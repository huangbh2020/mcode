/**
 * Unified media tiles + lightbox — chat-stream rendering for BOTH image and
 * video blocks under one visual grammar.
 *
 * Why unified: images (screenshots, base64) and videos (script-generated
 * files, streamed by path) are the same thing to the user — this turn's
 * media output. Media renders as one COMPACT row of square thumbnails
 * (56px, the composer's pending-image geometry — a run costs ~60px of chat
 * height, and inline painting is capped at canvas-downscaled ~112px thumbs
 * so full-res decodes never sit in the image cache), and clicking any tile
 * opens ONE lightbox whose stage plays the right medium: images get the
 * zoom-fit/scroll viewer, videos get a `<video controls autoPlay>` player.
 * The docked control bar switches per item kind — image buttons operate on
 * data URLs (copy/download/reveal), video buttons on file paths (open in
 * editor / show in folder / open in system).
 *
 * Video tiles intentionally have NO native controls: at thumbnail size the
 * scrubber is unusable and it would break the tile grammar. preload="metadata"
 * + the `#t=0.1` fragment make Chromium paint the first frame as the poster
 * without loading the whole file (a several-hundred-MB render costs one
 * small range request); playback happens exclusively in the lightbox, so
 * at most one video decodes at a time.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../ui/dialog.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { isElectron } from "@renderer/lib/platform.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useSessionStore, type Block } from "@renderer/stores/sessionStore.js";
import { appResourceUrl } from "@renderer/lib/appResource.js";
import { authenticatedMediaUrl } from "@renderer/lib/webApi.js";
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconFolderOpen,
  IconPhoto,
  IconPlayerPlay,
  IconVideo,
  IconX,
} from "@renderer/lib/icons.js";

export type MediaBlock = Extract<Block, { kind: "image" | "video" }>;

/** What a tool_use block contributes to media labeling: the identity needed
 *  to name an image block that carries no path (base64 only). */
export type ToolMeta = { toolName: string; input: unknown };

/** One lightbox/tile item, resolved from a block. Image items carry the
 *  data URL; video items carry the app-resource streaming URL + the file
 *  identity the path-based actions need. */
export type MediaItem =
  | { kind: "image"; src: string; alt: string }
  | { kind: "video"; src: string; name: string; filePath: string };

/** Resolve the video element's source for one absolute file path, per
 *  transport. Desktop windows stream via the guarded `app-resource://`
 *  protocol (Electron-main registered). The phone's browser can't see that
 *  scheme, so the web build uses the mobile server's token-authenticated
 *  `/api/media` route (same fence, Range-capable) — null there means
 *  unpaired, which renders as the unplayable tile. */
function videoSrcFor(filePath: string): string {
  if (isElectron) return appResourceUrl(filePath);
  return authenticatedMediaUrl(filePath) ?? "";
}

function basenameOfPath(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Tools whose image result is a browser capture — no meaningful file name,
 *  so they label as screenshots. Claude's in-process MCP server surfaces the
 *  tool as `mcp__mcode-browser__browser_screenshot`; Pi's native tool is
 *  `browser_screenshot`. */
const SCREENSHOT_TOOL_NAMES = new Set([
  "mcp__mcode-browser__browser_screenshot",
  "mcp__mcode-browser__browser_script", // finalScreenshot rides the same result shape
  "browser_screenshot",
]);

/** Best-effort human label for an image block. Tool-produced images carry no
 *  file path (base64 only), so the paired tool_use block (same message) is
 *  the only naming source: Read-style tools contribute the real file name
 *  from their input, capture tools get the screenshot label, anything else
 *  falls back to a generic image label. */
function resolveImageLabel(
  b: Extract<MediaBlock, { kind: "image" }>,
  toolMetaById: ReadonlyMap<string, ToolMeta> | undefined,
  t: (key: MessageId) => string,
): string {
  if (!b.toolCallId || !toolMetaById) return t("chatStream.image.userImage");
  const meta = toolMetaById.get(b.toolCallId);
  if (!meta) return t("chatStream.image.toolImage");
  if (SCREENSHOT_TOOL_NAMES.has(meta.toolName)) return t("chatStream.image.browserScreenshot");
  const input = meta.input as Record<string, unknown> | null | undefined;
  if (input && typeof input === "object") {
    const fp = input.file_path ?? input.path;
    if (typeof fp === "string" && fp.length > 0) return basenameOfPath(fp);
  }
  return t("chatStream.image.toolImage");
}

function toMediaItem(b: MediaBlock, label: string, index?: number): MediaItem {
  if (b.kind === "image") {
    const alt = typeof index === "number" ? `${label} ${index + 1}` : label;
    return {
      kind: "image",
      src: `data:${b.mimeType};base64,${b.data}`,
      alt,
    };
  }
  return { kind: "video", src: videoSrcFor(b.filePath), name: basenameOfPath(b.filePath), filePath: b.filePath };
}

/* ── Tiles ────────────────────────────────────────────────────────────
 * Compact square thumbnails (56px, the composer's pending-image geometry)
 * in one flex-wrap row — a media run costs ~60px of chat height, never a
 * wall of bitmaps. Click opens the lightbox where the full-resolution
 * viewer belongs.
 *
 * Memory discipline: the stream may hold dozens of full-res screenshots as
 * base64. Painting them as <img> keeps EVERY full decode in Chromium's
 * image cache (~12MB per 2000×1500 PNG, resident). So inline rendering
 * only ever paints a canvas-downscaled thumb (≤112px @2dpr, ~50KB); the
 * full-res data URL is reserved for the lightbox, one image at a time.
 * Thumbs are WeakMap-cached per block object and generated on a serialized
 * queue so a 20-screenshot run decodes sequentially, not concurrently. */

const THUMB_EDGE = 112; // 56px tile at 2× dpr
const thumbCache = new WeakMap<object, string>();
let thumbQueue: Promise<unknown> = Promise.resolve();

async function makeThumbDataUrl(data: string, mimeType: string): Promise<string> {
  // createImageBitmap decodes off the main thread (HTMLImageElement would
  // cache the full decode); atob+Blob is just the container.
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
  try {
    const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL(mimeType === "image/png" ? "image/png" : "image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}

/** Inline-rendering source for one image block: the downscaled thumb once
 *  ready, the full data URL as pre-thumb/failure fallback (decoding async —
 *  a broken thumbnail path must not hide the image). The cache is read
 *  during render (non-reactive) and a tick bump triggers the re-render that
 *  picks it up — no per-block src state, so a block identity swap can never
 *  flash a previous image. */
export function useMediaThumbSrc(block: Extract<MediaBlock, { kind: "image" }>): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (thumbCache.has(block)) return;
    let alive = true;
    // Serialized: one full decode at a time across the whole stream.
    thumbQueue = thumbQueue
      .then(async () => {
        const url = await makeThumbDataUrl(block.data, block.mimeType);
        thumbCache.set(block, url);
        if (alive) setTick((t) => t + 1);
      })
      .catch(() => {
        /* failure → keep the full-src fallback; nothing to report */
      });
    return () => {
      alive = false;
    };
  }, [block]);
  return thumbCache.get(block) ?? `data:${block.mimeType};base64,${block.data}`;
}

/** The thumbnail <img> proper — shared with ChatPane's user-image strip so
 *  sent images look exactly like the composer's pending ones. `onError`
 *  fires when BOTH the thumb path and the full-src fallback fail (corrupt
 *  bytes), letting the caller swap in a labeled placeholder. */
export function MediaThumbImage({
  block,
  className,
  onError,
}: {
  block: Extract<MediaBlock, { kind: "image" }>;
  className?: string;
  onError?: () => void;
}) {
  const src = useMediaThumbSrc(block);
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      decoding="async"
      onError={onError}
      className={cn("h-full w-full object-cover", className)}
    />
  );
}

const TILE_FRAME =
  "group relative block h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-edge bg-surface-muted shadow-xs transition-shadow hover:shadow-md cursor-zoom-in";
const TILE_HOVER_VEIL =
  "pointer-events-none absolute inset-0 hidden items-center justify-center bg-black/35 text-white group-hover:flex";

function ImageTile({ item, block, onOpen }: { item: Extract<MediaItem, { kind: "image" }>; block: Extract<MediaBlock, { kind: "image" }>; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="inline-flex h-14 max-w-[220px] shrink-0 items-center gap-1.5 rounded-lg border border-edge bg-surface-muted/60 px-2 py-1 text-xs text-content-muted">
        <IconPhoto size={12} className="shrink-0 text-accent" />
        <span className="truncate">{item.alt}</span>
      </span>
    );
  }
  return (
    <button type="button" onClick={onOpen} title={item.alt} className={TILE_FRAME}>
      <MediaThumbImage block={block} onError={() => setFailed(true)} />
      <span aria-hidden="true" className={TILE_HOVER_VEIL}>
        <IconArrowsMaximize size={14} />
      </span>
    </button>
  );
}

function VideoTile({ item, onOpen }: { item: Extract<MediaItem, { kind: "video" }>; onOpen: () => void }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        title={`${item.name} · ${t("chatStream.video.unplayable")}`}
        className="grid h-14 w-14 shrink-0 place-items-center rounded-lg border border-edge bg-surface-muted/60 text-content-subtle"
      >
        <IconVideo size={16} />
      </span>
    );
  }
  return (
    <button type="button" onClick={onOpen} title={item.name} className={TILE_FRAME}>
      {/* #t=0.1: forces Chromium to seek-paint the first frame as the poster
          without buffering the file (one small Range request). Playback only
          ever happens in the lightbox. */}
      <video
        src={`${item.src}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        draggable={false}
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 grid place-items-center"
      >
        <span className="grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white ring-1 ring-white/25 transition-transform group-hover:scale-110">
          <IconPlayerPlay size={12} />
        </span>
      </span>
    </button>
  );
}

function MediaTile({
  item,
  block,
  onOpen,
}: {
  item: MediaItem;
  block: MediaBlock;
  onOpen: () => void;
}) {
  // item and block are always derived from the same block (MediaGallery);
  // TS can't correlate the two params, so both narrow together here.
  if (item.kind === "image" && block.kind === "image") {
    return <ImageTile item={item} block={block} onOpen={onOpen} />;
  }
  if (item.kind === "video" && block.kind === "video") {
    return <VideoTile item={item} onOpen={onOpen} />;
  }
  return null;
}

/** Overflow tile for long runs — "+N" opens the lightbox at the first hidden
 *  item; ←/→ walk the full set there. */
function MoreTile({ remaining, onOpen }: { remaining: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid h-14 w-14 shrink-0 place-items-center rounded-lg border border-edge bg-surface-muted/70 text-sm font-semibold tabular-nums text-content-strong transition-colors hover:border-accent/50 hover:bg-surface-hover"
    >
      +{remaining}
    </button>
  );
}

/* ── Lightbox ─────────────────────────────────────────────────────────
 * Fullscreen dark viewer over the Dialog primitive, adapted from
 * ImageWithPreview: stage (flex-1) above a docked glass bar; the bar fades
 * after ~2.6s of pointer idleness and never overlaps the media. The stage
 * renders by item kind; the bar's action cluster switches with it. */

const CHROME_IDLE_MS = 2600;
const CHROME_ZONE_PX = 88;

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

function BarDivider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px bg-white/10" />;
}

/** Trigger a browser download of a `data:` URL (same trick as
 *  ImageWithPreview — videos are path-streamed and use the folder/system
 *  actions instead). */
function downloadDataUrl(dataUrl: string, baseName: string): void {
  try {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = baseName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    // Blocked downloads in exotic embedded contexts — ignore.
  }
}

export function MediaLightbox({
  items,
  index,
  onNavigate,
  onClose,
}: {
  items: MediaItem[];
  index: number;
  /** Position changes (thumbnail click seed + ←/→ / bar nav) flow up so the
   *  caller stays the single source of truth. */
  onNavigate: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const count = items.length;
  const curIdx = Math.max(0, Math.min(count - 1, index));
  const item = items[curIdx];
  const openFileInIde = useSessionStore((s) => s.openFileInIde);

  // Zoom mode for the IMAGE stage only (fit vs natural-width scroll).
  const [zoomMode, setZoomMode] = useState<"fit" | "scroll">("fit");
  const stageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (stageRef.current) stageRef.current.scrollTop = 0;
  }, [curIdx, item.kind]);
  // Leaving the image kind retires the zoom state; the next image re-detects.
  useEffect(() => {
    if (item.kind === "video") setZoomMode("fit");
  }, [item.kind]);

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setZoomMode(img.naturalHeight > img.naturalWidth * 1.15 ? "scroll" : "fit");
  }, []);

  const handleStageClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (
      e.target === e.currentTarget ||
      (e.target as HTMLElement).getAttribute("data-stage-click") === "true"
    ) {
      onClose();
    }
  }, [onClose]);

  /* ── Image data-URL actions (copy / download / reveal) — same semantics as
   *    ImageWithPreview's bar; disabled for any non-data src. ── */
  const [copyState, setCopyState] = useState<"idle" | "copying" | "done" | "error">("idle");
  const [revealState, setRevealState] = useState<"idle" | "working" | "done" | "error">("idle");
  const copyResetTimer = useRef<number | undefined>(undefined);
  const revealResetTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(copyResetTimer.current);
      window.clearTimeout(revealResetTimer.current);
    },
    [],
  );
  useEffect(() => {
    setCopyState("idle");
    setRevealState("idle");
  }, [curIdx, item.kind]);

  const isDataImage = item.kind === "image" && item.src.startsWith("data:image/");

  const handleCopy = useCallback(async () => {
    if (!isDataImage) return;
    setCopyState("copying");
    const res = await api.clipboardFile.writeImage({ dataUrl: item.src });
    setCopyState(res.ok ? "done" : "error");
    window.clearTimeout(copyResetTimer.current);
    copyResetTimer.current = window.setTimeout(() => setCopyState("idle"), res.ok ? 1600 : 2400);
  }, [isDataImage, item]);

  const handleReveal = useCallback(async () => {
    if (!isDataImage) return;
    setRevealState("working");
    const res = await api.shell.showImageInFolder({ dataUrl: item.src });
    setRevealState(res.ok ? "done" : "error");
    window.clearTimeout(revealResetTimer.current);
    revealResetTimer.current = window.setTimeout(() => setRevealState("idle"), res.ok ? 1600 : 2400);
  }, [isDataImage, item]);

  /* ── Video path actions feedback (show-in-folder). ── */
  const [vidRevealState, setVidRevealState] = useState<"idle" | "working" | "done" | "error">("idle");
  const vidRevealTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(vidRevealTimer.current), []);
  useEffect(() => {
    setVidRevealState("idle");
  }, [curIdx, item.kind]);
  const handleVideoReveal = useCallback(async () => {
    if (item.kind !== "video") return;
    setVidRevealState("working");
    try {
      await api.shell.showItemInFolder({ path: item.filePath });
      setVidRevealState("done");
    } catch {
      setVidRevealState("error");
    }
    window.clearTimeout(vidRevealTimer.current);
    vidRevealTimer.current = window.setTimeout(() => setVidRevealState("idle"), 1600);
  }, [item]);

  /* ── Idle-fading chrome (same contract as ImageWithPreview). ── */
  const [chromeVisible, setChromeVisible] = useState(true);
  const chromeRef = useRef(true);
  const idleTimer = useRef<number | undefined>(undefined);
  const overChromeRef = useRef(false);
  const applyChrome = useCallback((visible: boolean) => {
    if (chromeRef.current === visible) return;
    chromeRef.current = visible;
    setChromeVisible(visible);
  }, []);
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
    chromeRef.current = true;
    setChromeVisible(true);
    wakeChrome();
    let lastMove = 0;
    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastMove < 120) return;
      lastMove = now;
      overChromeRef.current = e.clientY >= window.innerHeight - CHROME_ZONE_PX;
      wakeChrome();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.clearTimeout(idleTimer.current);
    };
  }, [wakeChrome]);

  const go = useCallback(
    (delta: number) => {
      const next = Math.max(0, Math.min(count - 1, curIdx + delta));
      if (next === curIdx) return;
      onNavigate(next);
      wakeChrome();
    },
    [count, curIdx, onNavigate, wakeChrome],
  );

  useEffect(() => {
    if (count <= 1) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      go(e.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, go]);

  // The embedded browser's WebContentsView floats above renderer DOM — hide
  // it while the lightbox is up (same suppression contract as ImageWithPreview).
  useSuppressBrowserView(true);

  const copyLabel =
    copyState === "done" ? t("layout.image.copied") : copyState === "error" ? t("layout.image.copyFailed") : t("layout.image.copy");
  const revealLabel =
    revealState === "done"
      ? t("layout.image.revealed")
      : revealState === "error"
        ? t("layout.image.revealFailed")
        : t("layout.image.reveal");
  const vidRevealLabel =
    vidRevealState === "done"
      ? t("layout.image.revealed")
      : vidRevealState === "error"
        ? t("layout.image.revealFailed")
        : t("layout.image.reveal");

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="lightbox-scrim fixed inset-0 top-0 z-50 bg-transparent" />
        <Dialog.Popup
          data-chrome={chromeVisible ? "shown" : "hidden"}
          className={cn(
            "lightbox-root pointer-events-none fixed inset-0 z-50 flex h-full w-full flex-col",
            "!left-0 !top-0 !translate-x-0 !translate-y-0",
            "rounded-none border-0 bg-transparent p-0 shadow-none outline-none",
          )}
        >
          <Dialog.Title className="sr-only">
            {item.kind === "image" ? item.alt || t("layout.image.previewTitle") : item.name}
          </Dialog.Title>
          <div
            ref={stageRef}
            onClick={handleStageClick}
            data-stage-click="true"
            onWheel={wakeChrome}
            className="lightbox-stage pointer-events-auto relative min-h-0 flex-1 w-full overflow-y-auto overflow-x-hidden select-none"
          >
            {item.kind === "image" ? (
              <div
                data-stage-click="true"
                className="flex min-h-full min-w-full flex-col items-center px-6 pb-8 pt-6"
              >
                <img
                  key={item.src}
                  src={item.src}
                  alt={item.alt}
                  draggable={false}
                  onLoad={handleImageLoad}
                  onClick={(e) => {
                    e.stopPropagation();
                    setZoomMode((prev) => (prev === "fit" ? "scroll" : "fit"));
                  }}
                  title={zoomMode === "fit" ? t("layout.image.fitWidth") : t("layout.image.fitScreen")}
                  className={cn(
                    "lightbox-figure pointer-events-auto block rounded-lg shadow-2xl transition-[max-height,max-width,width] duration-150 my-auto",
                    zoomMode === "fit"
                      ? "max-h-full max-w-full object-contain cursor-zoom-in"
                      : "w-auto max-w-full h-auto cursor-zoom-out",
                  )}
                />
              </div>
            ) : (
              <div
                data-stage-click="true"
                className="flex min-h-full min-w-full items-center justify-center px-6 pb-8 pt-6"
              >
                <video
                  key={item.src}
                  src={item.src}
                  controls
                  autoPlay
                  playsInline
                  className="pointer-events-auto max-h-full max-w-full rounded-lg shadow-2xl"
                />
              </div>
            )}
          </div>
          <div className="lightbox-chrome flex shrink-0 justify-center px-4 pb-5 pt-3">
            <div className="lightbox-bar pointer-events-auto flex items-center gap-0.5 rounded-2xl p-1">
              {item.kind === "image" ? (
                <>
                  <LightboxButton
                    label={copyLabel}
                    onClick={() => void handleCopy()}
                    disabled={copyState === "copying" || !isDataImage}
                    tone={copyState === "done" ? "accent" : copyState === "error" ? "danger" : "default"}
                  >
                    {copyState === "done" ? <IconCheck size={17} className="lightbox-check" /> : <IconCopy size={17} />}
                  </LightboxButton>
                  <LightboxButton
                    label={t("layout.image.download")}
                    onClick={() => {
                      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                      downloadDataUrl(item.kind === "image" ? item.src : "", t("layout.image.downloadName", { stamp }));
                    }}
                    disabled={!isDataImage}
                  >
                    <IconDownload size={17} />
                  </LightboxButton>
                  {isElectron && (
                    <LightboxButton
                      label={revealLabel}
                      onClick={() => void handleReveal()}
                      disabled={revealState === "working" || !isDataImage}
                      tone={revealState === "done" ? "accent" : revealState === "error" ? "danger" : "default"}
                    >
                      {revealState === "done" ? <IconCheck size={17} className="lightbox-check" /> : <IconFolderOpen size={17} />}
                    </LightboxButton>
                  )}
                  <LightboxButton
                    label={zoomMode === "fit" ? t("layout.image.fitWidth") : t("layout.image.fitScreen")}
                    onClick={() => setZoomMode((prev) => (prev === "fit" ? "scroll" : "fit"))}
                  >
                    {zoomMode === "fit" ? <IconArrowsMaximize size={17} /> : <IconArrowsMinimize size={17} />}
                  </LightboxButton>
                </>
              ) : (
                <>
                  <LightboxButton
                    label={t("chatStream.video.openInEditor")}
                    onClick={() => {
                      openFileInIde(item.kind === "video" ? item.filePath : "");
                      onClose();
                    }}
                  >
                    <IconVideo size={17} />
                  </LightboxButton>
                  {isElectron && (
                    <LightboxButton
                      label={vidRevealLabel}
                      onClick={() => void handleVideoReveal()}
                      disabled={vidRevealState === "working"}
                      tone={vidRevealState === "done" ? "accent" : vidRevealState === "error" ? "danger" : "default"}
                    >
                      {vidRevealState === "done" ? <IconCheck size={17} className="lightbox-check" /> : <IconFolderOpen size={17} />}
                    </LightboxButton>
                  )}
                  {isElectron && (
                    <LightboxButton
                      label={t("ide.editor.openInSystem")}
                      onClick={() => {
                        if (item.kind === "video") void api.shell.openFile({ path: item.filePath });
                      }}
                    >
                      <IconArrowsMaximize size={17} />
                    </LightboxButton>
                  )}
                </>
              )}
              {count > 1 && (
                <>
                  <BarDivider />
                  <LightboxButton label={t("layout.image.prev")} onClick={() => go(-1)} disabled={curIdx <= 0}>
                    <IconChevronLeft size={18} />
                  </LightboxButton>
                  <span className="px-1.5 text-xs font-medium tabular-nums text-white/75">
                    {curIdx + 1} / {count}
                  </span>
                  <LightboxButton label={t("layout.image.next")} onClick={() => go(1)} disabled={curIdx >= count - 1}>
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
  );
}

/** Media run rendering: one compact flex-wrap row of square thumbnails,
 *  opening the shared lightbox. Images and videos keep block order in the
 *  same row — to the user they are the same thing: this turn's media
 *  output. DOM/img count per run is bounded by MAX_VISIBLE_TILES; the tail
 *  collapses into a "+N" tile. */
const MAX_VISIBLE_TILES = 12;

export function MediaGallery({
  blocks,
  toolMetaById,
}: {
  blocks: MediaBlock[];
  /** Paired tool_use metadata (same message) — names image blocks that
   *  carry no path. Optional; absent = generic labels. */
  toolMetaById?: ReadonlyMap<string, ToolMeta>;
}) {
  const { t } = useI18n();
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const allItems = useMemo<MediaItem[]>(
    () =>
      blocks.map((b, i) => {
        const label =
          b.kind === "image" ? resolveImageLabel(b, toolMetaById, t) : basenameOfPath(b.filePath);
        return toMediaItem(b, label, blocks.length > 1 ? i : undefined);
      }),
    [blocks, toolMetaById, t],
  );

  if (allItems.length === 0) return null;

  return (
    <>
      <div className="my-1 flex flex-wrap items-center gap-1.5">
        {allItems.slice(0, MAX_VISIBLE_TILES).map((item, i) => (
          <MediaTile key={i} item={item} block={blocks[i]} onOpen={() => setOpenIdx(i)} />
        ))}
        {allItems.length > MAX_VISIBLE_TILES && (
          <MoreTile
            remaining={allItems.length - MAX_VISIBLE_TILES}
            onOpen={() => setOpenIdx(MAX_VISIBLE_TILES)}
          />
        )}
      </div>
      {openIdx !== null && (
        <MediaLightbox
          items={allItems}
          index={openIdx}
          onNavigate={setOpenIdx}
          onClose={() => setOpenIdx(null)}
        />
      )}
    </>
  );
}
