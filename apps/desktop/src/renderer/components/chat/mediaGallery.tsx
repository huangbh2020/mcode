/**
 * Unified media tiles + lightbox — chat-stream rendering for BOTH image and
 * video blocks under one visual grammar.
 *
 * Why unified: images (screenshots, base64) and videos (script-generated
 * files, streamed by path) are the same thing to the user — this turn's
 * media output. They render as fixed-frame tiles (300×200, matching the old
 * gallery/single-image ceilings) in a flex-wrap row, and clicking any tile
 * opens ONE lightbox whose stage plays the right medium: images get the
 * zoom-fit/scroll viewer, videos get a `<video controls autoPlay>` player.
 * The docked control bar switches per item kind — image buttons operate on
 * data URLs (copy/download/reveal), video buttons on file paths (open in
 * editor / show in folder / open in system).
 *
 * Video tiles intentionally have NO native controls: at 300px the scrubber
 * is unusable and it would break the tile grammar. preload="metadata" +
 * the `#t=0.1` fragment make Chromium paint the first frame as the poster
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
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCopy,
  IconDownload,
  IconFolderOpen,
  IconPhoto,
  IconPlayerPlay,
  IconVideo,
  IconX,
} from "@renderer/lib/icons.js";

export type MediaBlock = Extract<Block, { kind: "image" | "video" }>;

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

function toMediaItem(b: MediaBlock, t: (key: MessageId) => string, index?: number): MediaItem {
  if (b.kind === "image") {
    const baseName = b.toolCallId ? t("chatStream.image.browserScreenshot") : t("chatStream.image.userImage");
    const alt = typeof index === "number" ? `${baseName} ${index + 1}` : baseName;
    return {
      kind: "image",
      src: `data:${b.mimeType};base64,${b.data}`,
      alt,
    };
  }
  const name = b.filePath.split(/[\\/]/).pop() ?? b.filePath;
  return { kind: "video", src: videoSrcFor(b.filePath), name, filePath: b.filePath };
}

function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Single media item: a clean, inline pill. */
function SingleMediaItem({ item, onOpen }: { item: MediaItem; onOpen: () => void }) {
  const { t } = useI18n();
  const isVideo = item.kind === "video";
  const displayName = isVideo ? item.name : item.alt;

  return (
    <div className="my-1.5 inline-flex max-w-full items-center gap-2 rounded-lg border border-edge bg-surface-muted/60 py-1.5 pl-2.5 pr-2 transition-colors hover:border-accent/40 hover:bg-surface-hover">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-accent/10 text-accent">
        {isVideo ? <IconPlayerPlay size={12} /> : <IconPhoto size={12} />}
      </span>
      <span className="truncate text-xs font-medium text-content-strong max-w-[320px]">
        {displayName}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="ml-1 inline-flex shrink-0 items-center gap-1 rounded bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent hover:text-white"
      >
        <IconArrowsMaximize size={11} />
        <span>{t("layout.image.view")}</span>
      </button>
    </div>
  );
}

/** Multiple media items: a structured, collapsible media deck.
 *  Aggregates dozens of screenshots / videos into a single clean drawer
 *  instead of sprawling messy pills across the conversation stream. */
function MediaDeck({
  items,
  kind,
  onOpenItem,
}: {
  items: MediaItem[];
  kind: "image" | "video";
  onOpenItem: (idx: number) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const isVideo = kind === "video";
  const count = items.length;

  const title = isVideo
    ? t("chatStream.media.videosTotal", { n: count })
    : t("chatStream.media.screenshotsTotal", { n: count });

  return (
    <div className="my-1.5 w-full max-w-xl overflow-hidden rounded-xl border border-edge/80 bg-surface-muted/40 shadow-xs transition-colors hover:border-edge">
      {/* Deck Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
            {isVideo ? <IconPlayerPlay size={13} /> : <IconPhoto size={13} />}
          </span>
          <span className="truncate text-xs font-semibold text-content-strong">
            {title}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => onOpenItem(0)}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white shadow-xs transition-opacity hover:opacity-90 active:opacity-100"
          >
            <IconArrowsMaximize size={12} />
            <span>{t("chatStream.media.previewAll")}</span>
          </button>

          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? t("chatStream.media.collapseList") : t("chatStream.media.expandList")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
          >
            {expanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Expanded item selector */}
      {expanded && (
        <div className="border-t border-edge/60 bg-surface/50 p-2.5">
          <div className="flex flex-wrap gap-1.5">
            {items.map((item, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onOpenItem(i)}
                title={item.kind === "video" ? item.name : item.alt}
                className="group inline-flex items-center gap-1 rounded-md border border-edge/80 bg-surface-base px-2 py-1 text-xs font-medium text-content transition-all hover:border-accent/60 hover:bg-accent/10 hover:text-accent"
              >
                <span className="text-[11px] tabular-nums font-semibold text-content-subtle group-hover:text-accent">
                  #{i + 1}
                </span>
                {item.kind === "video" && (
                  <span className="max-w-[120px] truncate text-[11px] font-normal text-content-muted group-hover:text-accent">
                    {item.name}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
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

/** A compact media gallery: clean single-line pill for 1 item, or a structured
 *  collapsible deck for multiple items with one-click preview all. */
export function MediaGallery({ blocks }: { blocks: MediaBlock[] }) {
  const { t } = useI18n();
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const allItems = useMemo<MediaItem[]>(
    () => blocks.map((b, i) => toMediaItem(b, t, blocks.length > 1 ? i : undefined)),
    [blocks, t],
  );

  const videoItems = useMemo(() => allItems.filter((m) => m.kind === "video"), [allItems]);
  const imageItems = useMemo(() => allItems.filter((m) => m.kind === "image"), [allItems]);

  if (allItems.length === 0) return null;

  // Single item fast-path: clean inline pill
  if (allItems.length === 1) {
    return (
      <>
        <SingleMediaItem item={allItems[0]} onOpen={() => setOpenIdx(0)} />
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

  return (
    <div className="space-y-1.5">
      {videoItems.length > 0 && (
        <MediaDeck
          items={videoItems}
          kind="video"
          onOpenItem={(subIdx) => {
            const target = videoItems[subIdx];
            const realIdx = allItems.indexOf(target);
            setOpenIdx(realIdx >= 0 ? realIdx : 0);
          }}
        />
      )}
      {imageItems.length > 0 && (
        <MediaDeck
          items={imageItems}
          kind="image"
          onOpenItem={(subIdx) => {
            const target = imageItems[subIdx];
            const realIdx = allItems.indexOf(target);
            setOpenIdx(realIdx >= 0 ? realIdx : 0);
          }}
        />
      )}
      {openIdx !== null && (
        <MediaLightbox
          items={allItems}
          index={openIdx}
          onNavigate={setOpenIdx}
          onClose={() => setOpenIdx(null)}
        />
      )}
    </div>
  );
}
