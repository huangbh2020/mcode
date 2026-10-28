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

/** One lightbox/tile item, resolved from a block. Image items carry the
 *  data URL; video items carry the app-resource streaming URL + the file
 *  identity the path-based actions need. */
export type MediaItem =
  | { kind: "image"; src: string; alt: string }
  | { kind: "video"; src: string; name: string; filePath: string };

/** Tile geometry — matches the ceilings the old single-image/gallery paths
 *  used (maxThumbnailWidth 300 × maxThumbnailHeight 200, fixed frame), so
 *  media renders at one constant size whether it shows up alone or in a run. */
const TILE_W = 300;
const TILE_H = 200;

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

function toMediaItem(b: MediaBlock, t: (key: MessageId) => string): MediaItem {
  if (b.kind === "image") {
    return {
      kind: "image",
      src: `data:${b.mimeType};base64,${b.data}`,
      alt: b.toolCallId ? t("chatStream.image.browserScreenshot") : t("chatStream.image.userImage"),
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

/** One fixed-frame media tile. Images show the bitmap; videos show the
 *  first frame with a play badge + duration chip. A video Chromium can't
 *  decode (codec/container) degrades to a broken-media chip that names the
 *  file — click does nothing rather than opening a dead lightbox. */
function MediaTile({ item, onOpen }: { item: MediaItem; onOpen: () => void }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState<string | null>(null);

  // Broken tile: Chromium can't decode the file, OR the web client has no
  // device token (empty src — unpaired phone). Either way the media is
  // unwatchable here; name it and stop.
  if (item.kind === "video" && (failed || !item.src)) {
    return (
      <div
        className="flex shrink-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-edge bg-surface-muted/60 px-3 text-center"
        style={{ width: TILE_W, height: TILE_H }}
        title={item.filePath}
      >
        <IconVideo size={24} className="text-content-subtle" />
        <span className="max-w-full truncate text-[11px] font-medium text-content-muted">{item.name}</span>
        <span className="text-[10px] text-content-subtle">{t("chatStream.video.unplayable")}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title={item.kind === "image" ? item.alt : item.name}
      className="group relative block shrink-0 overflow-hidden rounded-lg border border-edge bg-surface-muted/60 shadow-sm transition-all hover:border-accent/60 hover:shadow-md"
      style={{ width: TILE_W, height: TILE_H }}
    >
      {item.kind === "image" ? (
        <img
          src={item.src}
          alt={item.alt}
          loading="lazy"
          draggable={false}
          className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.03]"
        />
      ) : (
        <>
          <video
            // #t=0.1: forces Chromium to seek-paint the first frame as the
            // poster under preload="metadata" (metadata alone leaves some
            // containers blank until play).
            src={`${item.src}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            draggable={false}
            onLoadedMetadata={(e) => setDuration(formatDuration(e.currentTarget.duration))}
            onError={() => setFailed(true)}
            className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.03]"
          />
          {/* Play affordance + duration — video tiles read as playable at a
              glance, mirroring how every video surface marks itself. */}
          <span className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm">
              <IconPlayerPlay size={18} />
            </span>
          </span>
          {duration && (
            <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">
              {duration}
            </span>
          )}
        </>
      )}
      <span className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
        <IconArrowsMaximize size={12} />
        {t("layout.image.view")}
      </span>
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

/** A compact tabbed media card for a run of image/video blocks.
 *
 *  ONE fixed-size tile is visible at a time (the stream stays compact —
 *  media runs must not sprawl). When the run contains BOTH kinds, a small
 *  tab strip splits them: 视频(n) / 图片(n), defaulting to the video tab
 *  (script renders are the finale); with a single kind there is no tab bar
 *  and the card is exactly the old gallery's footprint. Within a tab,
 *  ◀ ▶ overlay arrows + counter + dots page through the items; clicking the
 *  tile opens the lightbox positioned at that item, navigating within the
 *  active tab's list. */
export function MediaGallery({ blocks }: { blocks: MediaBlock[] }) {
  const { t } = useI18n();
  const videos = useMemo(
    () => blocks.filter((b): b is Extract<MediaBlock, { kind: "video" }> => b.kind === "video").map((b) => toMediaItem(b, t)),
    [blocks, t],
  );
  const images = useMemo(
    () => blocks.filter((b): b is Extract<MediaBlock, { kind: "image" }> => b.kind === "image").map((b) => toMediaItem(b, t)),
    [blocks, t],
  );
  const both = videos.length > 0 && images.length > 0;
  // Default to the video tab when videos exist (the rendered clip is the
  // result the user is waiting for); a media run seen mid-stream may start
  // on images and keep that tab once videos land — the tab badge shows the
  // count either way.
  const [tab, setTab] = useState<"video" | "image">(videos.length > 0 ? "video" : "image");
  const [idx, setIdx] = useState(0);
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const active = tab === "video" ? (videos.length > 0 ? videos : images) : images.length > 0 ? images : videos;
  const curIdx = Math.min(idx, active.length - 1);
  const cur = active[Math.max(0, curIdx)];
  const go = (delta: number) => setIdx((i) => Math.max(0, Math.min(active.length - 1, i + delta)));

  return (
    <div className="my-1 flex w-fit max-w-full flex-col overflow-hidden rounded-lg border border-edge bg-surface-muted/50">
      {both && (
        <div className="flex items-center gap-0.5 border-b border-edge/60 px-1.5 pt-1">
          {(
            [
              { key: "video" as const, label: t("chatStream.media.tabVideos"), count: videos.length, icon: <IconVideo size={12} /> },
              { key: "image" as const, label: t("chatStream.media.tabImages"), count: images.length, icon: <IconPhoto size={12} /> },
            ]
          ).map((tb) => (
            <button
              key={tb.key}
              type="button"
              onClick={() => {
                setTab(tb.key);
                setIdx(0);
              }}
              className={cn(
                "flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[11px] font-medium transition-colors",
                tab === tb.key ? "border-accent text-content" : "border-transparent text-content-subtle hover:text-content-muted",
              )}
            >
              {tb.icon}
              {tb.label}
              <span className="tabular-nums opacity-70">{tb.count}</span>
            </button>
          ))}
        </div>
      )}
      <div className="p-1.5">
        <div className="relative">
          <MediaTile item={cur} onOpen={() => setOpenIdx(curIdx)} />
          {active.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => go(-1)}
                disabled={curIdx <= 0}
                title={t("chatStream.gallery.prev")}
                className="absolute left-1 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/55 p-1.5 text-white/90 backdrop-blur-sm transition-colors enabled:hover:bg-black/80 enabled:hover:text-white disabled:opacity-30"
              >
                <IconChevronLeft size={18} />
              </button>
              <button
                type="button"
                onClick={() => go(1)}
                disabled={curIdx >= active.length - 1}
                title={t("chatStream.gallery.next")}
                className="absolute right-1 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/55 p-1.5 text-white/90 backdrop-blur-sm transition-colors enabled:hover:bg-black/80 enabled:hover:text-white disabled:opacity-30"
              >
                <IconChevronRight size={18} />
              </button>
            </>
          )}
        </div>
      </div>
      {active.length > 1 && (
        <div className="flex items-center justify-center gap-1 pb-1.5 text-[11px] text-content-subtle">
          <span className="tabular-nums">
            {curIdx + 1} / {active.length}
          </span>
          {active.length <= 12 && (
            <span className="ml-1.5 flex items-center gap-1">
              {active.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setIdx(i)}
                  title={`${i + 1}`}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    i === curIdx ? "w-3 bg-accent" : "w-1.5 bg-content-subtle/40 hover:bg-content-subtle/70",
                  )}
                />
              ))}
            </span>
          )}
        </div>
      )}
      {openIdx != null && (
        <MediaLightbox items={active} index={openIdx} onNavigate={setOpenIdx} onClose={() => setOpenIdx(null)} />
      )}
    </div>
  );
}
