/**
 * ImageWithPreview — a thumbnail that opens a fullscreen lightbox on click.
 *
 * Renders a small, bounded image inline (so it doesn't dominate the chat
 * stream); clicking it opens a Dialog-based lightbox with a dark backdrop where
 * the image is shown at its full size (object-contain within the viewport).
 * Built on the project's Dialog primitive (base-ui) for consistent modal
 * behavior: Esc to close, click backdrop to close, focus trap.
 *
 * Chrome layout (redesigned): every control lives in ONE glass bar docked
 * *below* the image — copy · download │ prev · counter · next │ close. The bar
 * occupies its own reserved strip outside the image stage (a `flex-1` sibling
 * that shrink-wraps the picture), so controls can never land on top of the
 * image, and they fade away ~2.6s after the pointer goes idle (any move /
 * keypress brings them back) so a screenshot can be studied with zero chrome
 * over it. Nothing is anchored to the screen's top-right corner on purpose: on
 * Windows/Linux the native caption overlay (min/max/close) is drawn above the
 * webview there, so chrome placed in that corner collides with it.
 *
 * When `gallery` is provided (the full image list this thumbnail is part of),
 * the lightbox gains prev/next stepping + a position counter, reachable both
 * from the bar and from the ←/→ keys. Navigation is pushed up via `onNavigate`
 * so the caller (e.g. ImageGallery) can keep its own index in sync; `index` is
 * the current position, used to initialize the lightbox view.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "./dialog.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  IconArrowsMaximize,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconX,
} from "@renderer/lib/icons.js";

/** Trigger a browser download of a `data:` URL (base64 image). Creates a
 *  temporary <a download> and clicks it. The filename is derived from a
 *  timestamp so repeated downloads don't collide. */
function downloadDataUrl(dataUrl: string, baseName: string): void {
  try {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = baseName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    // Downloads can be blocked in exotic embedded contexts; ignore silently.
  }
}

/** How long the chrome stays on screen after the last pointer move / keypress.
 *  Long enough to aim at a button, short enough that the picture is never
 *  studied through a haze of controls. */
const CHROME_IDLE_MS = 2600;

/** Height of the reserved strip at the bottom of the lightbox that counts as
 *  "the pointer is on the chrome" (the bar plus its padding, with slack). */
const CHROME_ZONE_PX = 88;

/** One icon button inside the lightbox bar. */
function LightboxButton({
  label,
  onClick,
  disabled,
  tone = "default",
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "default" | "accent" | "danger";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "grid h-9 w-9 place-items-center rounded-xl transition-colors",
        tone === "accent"
          ? "text-accent"
          : tone === "danger"
            ? "text-danger"
            : "text-white/80 enabled:hover:bg-white/10 enabled:hover:text-white enabled:active:bg-white/20",
        disabled && "opacity-30",
      )}
    >
      {children}
    </button>
  );
}

/** Hairline separator between button groups in the bar. */
function BarDivider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px bg-white/10" />;
}

export interface ImageWithPreviewProps {
  /** Raw image source — a full `data:` URL or a regular URL. */
  src: string;
  /** Alt text for accessibility. */
  alt?: string;
  /** Extra classes on the thumbnail wrapper. */
  className?: string;
  /** Max thumbnail height in px (default 160). Combined with `maxThumbnailWidth`
   *  this caps the inline preview so a screenshot sits politely in the message
   *  stream instead of dominating it — click opens the full-size lightbox. */
  maxThumbnailHeight?: number;
  /** Max thumbnail width in px (default 280). */
  maxThumbnailWidth?: number;
  /** When true, render the thumbnail inside a fixed frame of
   *  maxThumbnailWidth × maxThumbnailHeight (image is object-contain'd inside).
   *  Used by ImageGallery: switching between differently-sized screenshots then
   *  keeps the card a stable size instead of resizing around each image. */
  fixedFrame?: boolean;
  /** Full image list this thumbnail belongs to. When provided (length > 1),
   *  the lightbox gains prev/next navigation + a position counter. */
  gallery?: string[];
  /** Current index within `gallery`. Seeds the lightbox view and follows
   *  external index changes (e.g. the caller's own thumbnail arrows). */
  index?: number;
  /** Fired when the user navigates inside the lightbox, so the caller can sync
   *  its own index (and thus which thumbnail is shown). */
  onNavigate?: (index: number) => void;
}

export function ImageWithPreview({
  src,
  alt = "",
  className,
  maxThumbnailHeight = 160,
  maxThumbnailWidth = 280,
  fixedFrame = false,
  gallery,
  index = 0,
  onNavigate,
}: ImageWithPreviewProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const gallerySrcs = gallery && gallery.length > 0 ? gallery : [src];
  const count = gallerySrcs.length;
  // Local lightbox index. Seeded from `index` on open, and re-synced whenever
  // the external `index` moves (the caller's thumbnail arrows / our own nav).
  const [viewIdx, setViewIdx] = useState(index);
  useEffect(() => {
    setViewIdx(Math.max(0, Math.min(count - 1, index)));
  }, [index, count]);
  // Opening the lightbox starts at the currently-selected thumbnail.
  useEffect(() => {
    if (open) {
      setViewIdx(Math.max(0, Math.min(count - 1, index)));
      // Fresh copy feedback each time the lightbox opens (stale ✓/toast from a
      // previous session shouldn't leak into the next one).
      setCopyState("idle");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const curIdx = Math.max(0, Math.min(count - 1, viewIdx));
  const curSrc = gallerySrcs[curIdx] ?? src;
  const curAlt = count > 1 ? `${alt} ${curIdx + 1}/${count}` : alt;

  /* ── Copy-to-clipboard feedback. Images are `data:image/...` URLs (the only
   *    kind this component receives from the message stream); the copy button
   *    is disabled for any other src shape. ── */
  const [copyState, setCopyState] = useState<"idle" | "copying" | "done" | "error">("idle");
  const copyResetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyResetTimer.current), []);

  const handleCopy = useCallback(async () => {
    if (!curSrc.startsWith("data:image/")) return;
    setCopyState("copying");
    const res = await api.clipboardFile.writeImage({ dataUrl: curSrc });
    setCopyState(res.ok ? "done" : "error");
    window.clearTimeout(copyResetTimer.current);
    copyResetTimer.current = window.setTimeout(() => setCopyState("idle"), res.ok ? 1600 : 2400);
  }, [curSrc]);

  /* ── Idle-fading chrome. The bar is on screen when the lightbox opens and
   *    whenever the pointer moves or a key is pressed; it retracts after
   *    CHROME_IDLE_MS of stillness so the image is never occluded. ── */
  const [chromeVisible, setChromeVisible] = useState(true);
  // Mirrors `chromeVisible` so the pointermove handler can bail out without
  // scheduling a state update for every mouse event.
  const chromeRef = useRef(true);
  const idleTimer = useRef<number | undefined>(undefined);
  // While the pointer lives in the bar's strip it must not fade out from under
  // the cursor (resting on a button fires no pointermove, and a bar that
  // vanished under a stationary pointer would turn the next click into a
  // backdrop click that closes the lightbox).
  const overChromeRef = useRef(false);

  const applyChrome = useCallback((visible: boolean) => {
    if (chromeRef.current === visible) return;
    chromeRef.current = visible;
    setChromeVisible(visible);
  }, []);

  /** Make the chrome visible and restart the idle countdown. */
  const wakeChrome = useCallback(() => {
    applyChrome(true);
    window.clearTimeout(idleTimer.current);
    if (overChromeRef.current) return;
    idleTimer.current = window.setTimeout(() => {
      if (overChromeRef.current) return;
      applyChrome(false);
    }, CHROME_IDLE_MS);
  }, [applyChrome]);

  useEffect(() => {
    if (!open) return;
    chromeRef.current = true;
    setChromeVisible(true);
    wakeChrome();
    let lastMove = 0;
    const onMove = (e: PointerEvent) => {
      // Throttle: pointermove fires far faster than the countdown needs.
      const now = performance.now();
      if (now - lastMove < 120) return;
      lastMove = now;
      // Geometric "on the chrome" test: hover events can't be trusted here,
      // since the bar ignores the pointer whenever it is hidden.
      overChromeRef.current = e.clientY >= window.innerHeight - CHROME_ZONE_PX;
      wakeChrome();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.clearTimeout(idleTimer.current);
    };
  }, [open, wakeChrome]);

  // ←/→ step through a gallery (and wake the chrome, since the counter the user
  // is reading lives in the bar).
  useEffect(() => {
    if (!open || count <= 1) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const delta = e.key === "ArrowLeft" ? -1 : 1;
      const next = Math.max(0, Math.min(count - 1, curIdx + delta));
      if (next === curIdx) return;
      setViewIdx(next);
      onNavigate?.(next);
      wakeChrome();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, count, curIdx, onNavigate, wakeChrome]);

  const go = (delta: number) => {
    const next = Math.max(0, Math.min(count - 1, curIdx + delta));
    if (next === curIdx) return;
    setViewIdx(next);
    onNavigate?.(next);
    wakeChrome();
  };

  // The embedded browser's page is an OS-level WebContentsView that floats
  // above all renderer DOM, so this lightbox (a renderer-DOM overlay) would be
  // covered by it. Increment the global suppression counter while open so
  // BrowserPanel hides the view; the cleanup decrements on close/unmount so it
  // restores. A counter composes safely if multiple overlays ever stack.
  // Fullscreen lightbox: suppress unconditionally while open (no popup ref —
  // it always overlaps the browser's rect).
  useSuppressBrowserView(open);

  const copyLabel =
    copyState === "done"
      ? t("layout.image.copied")
      : copyState === "error"
        ? t("layout.image.copyFailed")
        : t("layout.image.copy");

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("layout.image.clickToView")}
        className={cn(
          "group relative block w-fit overflow-hidden rounded-lg border border-edge bg-surface-muted/60 shadow-sm transition-all hover:border-accent/60 hover:shadow-md",
          className,
        )}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          draggable={false}
          style={
            fixedFrame
              ? { width: maxThumbnailWidth, height: maxThumbnailHeight }
              : { maxHeight: maxThumbnailHeight, maxWidth: maxThumbnailWidth }
          }
          className="block object-contain transition-transform duration-200 group-hover:scale-[1.03]"
        />
        {/* Hover affordance: a small maximize badge that appears on hover. */}
        <span className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          <IconArrowsMaximize size={12} />
          {t("layout.image.view")}
        </span>
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop
            // Override the default top-10 + bg-black/60 for a true fullscreen
            // dark lightbox: cover from the very top, deeper tint with a soft
            // vignette so the picture reads as the brightest thing on screen.
            // Clicking the backdrop closes (base-ui Dialog propagates
            // onOpenChange).
            className="lightbox-scrim fixed inset-0 top-0 z-50 bg-transparent"
          />
          <Dialog.Popup
            data-chrome={chromeVisible ? "shown" : "hidden"}
            // Transparent, borderless, full-viewport column: the image stage
            // (flex-1) sits above the docked control bar, so the two can never
            // overlap. `pointer-events-none` lets clicks in the letterbox area
            // fall through to the backdrop (click-outside-to-close) — the image
            // and the bar re-enable hit-testing for themselves only.
            className={cn(
              "lightbox-root pointer-events-none fixed inset-0 z-50 flex h-full w-full flex-col",
              "!left-0 !top-0 !translate-x-0 !translate-y-0",
              "rounded-none border-0 bg-transparent p-0 shadow-none outline-none",
            )}
          >
            {/* Visually-hidden title for a11y (Dialog expects a Title). */}
            <Dialog.Title className="sr-only">{curAlt || t("layout.image.previewTitle")}</Dialog.Title>
            <div className="pointer-events-none flex min-h-0 flex-1 items-center justify-center px-6 pb-2 pt-6">
              <img
                src={curSrc}
                alt={curAlt}
                draggable={false}
                className="lightbox-figure pointer-events-auto block max-h-full max-w-full rounded-lg object-contain shadow-2xl"
              />
            </div>
            {/* Docked control bar — the only chrome in the lightbox. */}
            {/* The strip is sized to the bar alone: copy feedback is delivered
                in place (the icon becomes a check / turns red) rather than by a
                second floating element, which would either overlap a tall image
                or reflow it when it appeared. */}
            <div className="lightbox-chrome flex shrink-0 justify-center px-4 pb-5 pt-3">
              <div className="lightbox-bar pointer-events-auto flex items-center gap-0.5 rounded-2xl p-1">
                <LightboxButton
                  label={copyLabel}
                  onClick={() => void handleCopy()}
                  disabled={copyState === "copying" || !curSrc.startsWith("data:image/")}
                  tone={copyState === "done" ? "accent" : copyState === "error" ? "danger" : "default"}
                >
                  {copyState === "done" ? (
                    <IconCheck size={17} className="lightbox-check" />
                  ) : (
                    <IconCopy size={17} />
                  )}
                </LightboxButton>
                <LightboxButton
                  label={t("layout.image.download")}
                  onClick={() => {
                    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                    downloadDataUrl(curSrc, t("layout.image.downloadName", { stamp }));
                  }}
                >
                  <IconDownload size={17} />
                </LightboxButton>
                {count > 1 && (
                  <>
                    <BarDivider />
                    <LightboxButton
                      label={t("layout.image.prev")}
                      onClick={() => go(-1)}
                      disabled={curIdx <= 0}
                    >
                      <IconChevronLeft size={18} />
                    </LightboxButton>
                    <span className="px-1.5 text-xs font-medium tabular-nums text-white/75">
                      {curIdx + 1} / {count}
                    </span>
                    <LightboxButton
                      label={t("layout.image.next")}
                      onClick={() => go(1)}
                      disabled={curIdx >= count - 1}
                    >
                      <IconChevronRight size={18} />
                    </LightboxButton>
                  </>
                )}
                <BarDivider />
                <Dialog.Close
                  aria-label={t("layout.image.closePreview")}
                  className="relative right-auto top-auto grid h-9 w-9 place-items-center rounded-xl p-0 text-white/80 transition-colors hover:bg-white/10 hover:text-white active:bg-white/20"
                >
                  <IconX size={17} />
                </Dialog.Close>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
