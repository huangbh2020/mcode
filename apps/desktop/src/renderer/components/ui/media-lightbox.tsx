/**
 * MediaLightbox — Fullscreen modern viewer for images and videos.
 *
 * Capabilities:
 * - Pan & Zoom: Smooth wheel zoom anchored to cursor, drag pan with grab cursor.
 * - Adaptive layout: Fits large/tall/wide screenshots and photos with zero clipping.
 * - Controls:
 *   - Top-right fixed close button with Esc shortcut.
 *   - Left / Right floating navigation arrows for gallery browsing.
 *   - Top status pill with image dimensions, zoom level, and item counter.
 *   - Bottom frosted-glass dock: Zoom -, 100% reset, Zoom +, Fit window, 1:1, Rotate 90°, Copy, Download, Reveal.
 *   - Double-click to toggle Fit <-> 100%.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "./dialog.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { isElectron } from "@renderer/lib/platform.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCode,
  IconCopy,
  IconDownload,
  IconFolderOpen,
  IconPlayerPlay,
  IconRotateClockwise,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from "@renderer/lib/icons.js";

export type MediaItem =
  | { kind: "image"; src: string; alt?: string; name?: string }
  | { kind: "video"; src: string; name: string; filePath: string };

/** Trigger a browser download of a data: or blob: URL. */
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

/** Dock icon button */
function DockButton({
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
        "grid h-9 w-9 place-items-center rounded-xl transition-all duration-150",
        tone === "accent"
          ? "text-accent hover:bg-white/10"
          : tone === "danger"
            ? "text-danger hover:bg-white/10"
            : "text-white/80 hover:bg-white/15 hover:text-white active:bg-white/20",
        disabled && "pointer-events-none opacity-30",
      )}
    >
      {children}
    </button>
  );
}

function DockDivider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px bg-white/15" />;
}

export interface MediaLightboxProps {
  items: MediaItem[];
  index: number;
  open?: boolean;
  onNavigate: (index: number) => void;
  onClose: () => void;
}

export function MediaLightbox({
  items,
  index,
  open = true,
  onNavigate,
  onClose,
}: MediaLightboxProps) {
  const { t } = useI18n();
  const count = items.length;
  const curIdx = Math.max(0, Math.min(count - 1, index));
  const item = items[curIdx] ?? items[0];
  const openFileInIde = useSessionStore((s) => s.openFileInIde);

  // Suppress embedded browser view while lightbox is open
  useSuppressBrowserView(open);

  // Zoom, pan, rotation states for image
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [fitScale, setFitScale] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  // Chrome visibility (idle auto-dimming)
  const [chromeVisible, setChromeVisible] = useState(true);
  const idleTimer = useRef<number | undefined>(undefined);
  const overChromeRef = useRef(false);

  const wakeChrome = useCallback(() => {
    setChromeVisible(true);
    window.clearTimeout(idleTimer.current);
    if (overChromeRef.current) return;
    idleTimer.current = window.setTimeout(() => {
      if (overChromeRef.current) return;
      setChromeVisible(false);
    }, 3200);
  }, []);

  // Compute fit scale whenever image or window changes
  const containerRef = useRef<HTMLDivElement | null>(null);

  const computeFit = useCallback((naturalW: number, naturalH: number) => {
    if (!containerRef.current) return 1;
    const stageW = containerRef.current.clientWidth;
    const stageH = containerRef.current.clientHeight;
    // Keep breathing room: 120px horizontally, 140px vertically
    const availW = Math.max(stageW - 120, 240);
    const availH = Math.max(stageH - 140, 240);
    const sW = availW / naturalW;
    const sH = availH / naturalH;
    const calculated = Math.min(sW, sH);
    // Don't upscale tiny icons beyond 1.0, but scale down large pictures
    return Math.min(calculated, 1);
  }, []);

  // Reset zoom, pan, and rotation when switching items
  useEffect(() => {
    setRotation(0);
    setPan({ x: 0, y: 0 });
    if (item && item.kind === "image" && naturalSize) {
      const fit = computeFit(naturalSize.width, naturalSize.height);
      setFitScale(fit);
      setScale(fit);
    } else {
      setScale(1);
    }
  }, [curIdx, item?.src, computeFit, naturalSize]);

  // Image load handler: inspect natural dimensions
  const handleImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      setNaturalSize({ width: nw, height: nh });
      const fit = computeFit(nw, nh);
      setFitScale(fit);
      setScale(fit);
      setPan({ x: 0, y: 0 });
      setRotation(0);
    },
    [computeFit],
  );

  // Window resize: recompute fit scale
  useEffect(() => {
    if (!open || !naturalSize) return;
    const onResize = () => {
      const fit = computeFit(naturalSize.width, naturalSize.height);
      setFitScale(fit);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, naturalSize, computeFit]);

  // Drag pan handling
  const isDraggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef({ x: 0, y: 0 });
  const startPanRef = useRef({ x: 0, y: 0 });
  const hasDraggedRef = useRef(false);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, [data-interactive]")) return;

    wakeChrome();
    isDraggingRef.current = true;
    setIsDragging(true);
    hasDraggedRef.current = false;
    startPosRef.current = { x: e.clientX, y: e.clientY };
    startPanRef.current = { ...pan };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    wakeChrome();
    if (!isDraggingRef.current) return;
    const dx = e.clientX - startPosRef.current.x;
    const dy = e.clientY - startPosRef.current.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      hasDraggedRef.current = true;
    }
    setPan({
      x: startPanRef.current.x + dx,
      y: startPanRef.current.y + dy,
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore in exotic contexts
    }
  };

  // Cursor-anchored wheel zooming
  const handleWheel = (e: React.WheelEvent) => {
    if (item?.kind !== "image") return;
    e.preventDefault();
    wakeChrome();

    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
    const minScale = 0.08;
    const maxScale = 10.0;

    setScale((prevScale) => {
      const nextScale = Math.min(Math.max(prevScale * zoomFactor, minScale), maxScale);
      if (!containerRef.current) return nextScale;

      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - (rect.left + rect.width / 2);
      const mouseY = e.clientY - (rect.top + rect.height / 2);

      const ratio = nextScale / prevScale;
      setPan((prevPan) => ({
        x: mouseX - (mouseX - prevPan.x) * ratio,
        y: mouseY - (mouseY - prevPan.y) * ratio,
      }));

      return nextScale;
    });
  };

  // Double-click: toggle between fit and 1:1 original scale
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (item?.kind !== "image") return;
    if ((e.target as HTMLElement).closest("button, [data-interactive]")) return;
    e.stopPropagation();
    wakeChrome();

    if (Math.abs(scale - 1) < 0.05) {
      setScale(fitScale);
      setPan({ x: 0, y: 0 });
    } else {
      setScale(1);
      setPan({ x: 0, y: 0 });
    }
  };

  // Backdrop click dismiss (only when not dragging)
  const handleStageClick = (e: React.MouseEvent) => {
    if (hasDraggedRef.current) {
      hasDraggedRef.current = false;
      return;
    }
    if (
      e.target === e.currentTarget ||
      (e.target as HTMLElement).getAttribute("data-backdrop-dismiss") === "true"
    ) {
      onClose();
    }
  };

  // Gallery navigation
  const go = useCallback(
    (delta: number) => {
      const next = Math.max(0, Math.min(count - 1, curIdx + delta));
      if (next === curIdx) return;
      onNavigate(next);
      wakeChrome();
    },
    [count, curIdx, onNavigate, wakeChrome],
  );

  // Keyboard navigation & Esc listener
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (count > 1) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          go(-1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          go(1);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, count, go, onClose]);

  // Track idle pointer move
  useEffect(() => {
    if (!open) return;
    wakeChrome();
    const onMove = () => wakeChrome();
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.clearTimeout(idleTimer.current);
    };
  }, [open, wakeChrome]);

  /* ── Image Copy / Reveal actions ── */
  const [copyState, setCopyState] = useState<"idle" | "copying" | "done" | "error">("idle");
  const [revealState, setRevealState] = useState<"idle" | "working" | "done" | "error">("idle");
  const copyResetTimer = useRef<number | undefined>(undefined);
  const revealResetTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      window.clearTimeout(copyResetTimer.current);
      window.clearTimeout(revealResetTimer.current);
    };
  }, []);

  useEffect(() => {
    setCopyState("idle");
    setRevealState("idle");
  }, [curIdx, item?.src]);

  const isDataImage = item?.kind === "image" && item.src.startsWith("data:image/");

  const handleCopy = useCallback(async () => {
    if (!isDataImage) return;
    setCopyState("copying");
    const res = await api.clipboardFile.writeImage({ dataUrl: item.src });
    setCopyState(res.ok ? "done" : "error");
    window.clearTimeout(copyResetTimer.current);
    copyResetTimer.current = window.setTimeout(
      () => setCopyState("idle"),
      res.ok ? 1600 : 2400,
    );
  }, [isDataImage, item]);

  const handleReveal = useCallback(async () => {
    if (!isDataImage) return;
    setRevealState("working");
    const res = await api.shell.showImageInFolder({ dataUrl: item.src });
    setRevealState(res.ok ? "done" : "error");
    window.clearTimeout(revealResetTimer.current);
    revealResetTimer.current = window.setTimeout(
      () => setRevealState("idle"),
      res.ok ? 1600 : 2400,
    );
  }, [isDataImage, item]);

  /* ── Video path actions ── */
  const [vidRevealState, setVidRevealState] = useState<"idle" | "working" | "done" | "error">("idle");
  const vidRevealTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(vidRevealTimer.current), []);
  useEffect(() => {
    setVidRevealState("idle");
  }, [curIdx, item?.kind]);

  const handleVideoReveal = useCallback(async () => {
    if (!item || item.kind !== "video") return;
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

  if (!open || !item) return null;

  const copyLabel =
    copyState === "done"
      ? t("layout.image.copied")
      : copyState === "error"
        ? t("layout.image.copyFailed")
        : t("layout.image.copy");

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
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        {/* Backdrop overlay */}
        <Dialog.Backdrop
          onClick={onClose}
          className="fixed inset-0 top-0 z-50 bg-black/80 backdrop-blur-md transition-opacity duration-200"
          style={{
            background:
              "radial-gradient(115% 85% at 50% 45%, rgba(10, 10, 12, 0.78), rgba(0, 0, 0, 0.94))",
          }}
        />

        {/* Modal Window Container */}
        <Dialog.Popup
          className={cn(
            "fixed inset-0 z-50 flex h-full w-full flex-col select-none",
            "!left-0 !top-0 !translate-x-0 !translate-y-0",
            "rounded-none border-0 bg-transparent p-0 shadow-none outline-none overflow-hidden",
          )}
        >
          <Dialog.Title className="sr-only">
            {item.kind === "image" ? item.alt || t("layout.image.previewTitle") : item.name}
          </Dialog.Title>

          {/* ── Top Bar: Info Badge (Left) & Prominent Close Button (Right) ── */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center justify-between p-5">
            {/* Info badge */}
            <div
              className={cn(
                "pointer-events-auto flex items-center gap-2.5 rounded-full px-3.5 py-1.5 text-xs font-medium text-white/85",
                "bg-zinc-900/75 backdrop-blur-xl border border-white/10 shadow-lg",
                "transition-opacity duration-300",
                chromeVisible ? "opacity-100" : "opacity-40 hover:opacity-100",
              )}
            >
              {count > 1 && (
                <span className="font-semibold text-white tabular-nums">
                  {curIdx + 1} / {count}
                </span>
              )}
              {count > 1 && (naturalSize || item.kind === "image") && (
                <span className="h-3 w-px bg-white/20" />
              )}
              {naturalSize && (
                <span className="tabular-nums text-white/70">
                  {naturalSize.width} × {naturalSize.height}
                </span>
              )}
              {item.kind === "image" && (
                <>
                  <span className="h-3 w-px bg-white/20" />
                  <span className="font-mono tabular-nums text-white/90">
                    {Math.round(scale * 100)}%
                  </span>
                </>
              )}
            </div>

            {/* Prominent Close button in Top-Right */}
            <button
              type="button"
              onClick={onClose}
              title={`${t("layout.image.closePreview")} (Esc)`}
              aria-label={t("layout.image.closePreview")}
              className={cn(
                "pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full text-white/90",
                "bg-zinc-900/80 backdrop-blur-xl border border-white/15 shadow-xl",
                "transition-all duration-200 hover:scale-105 hover:bg-zinc-800 hover:text-white hover:border-white/30 active:scale-95",
                chromeVisible ? "opacity-100" : "opacity-60 hover:opacity-100",
              )}
            >
              <IconX size={19} />
            </button>
          </div>

          {/* ── Left / Right Floating Navigation Arrows ── */}
          {count > 1 && (
            <>
              {/* Previous Button */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  go(-1);
                }}
                disabled={curIdx <= 0}
                title={t("layout.image.prev")}
                className={cn(
                  "pointer-events-auto absolute left-5 top-1/2 -translate-y-1/2 z-30",
                  "flex h-12 w-12 items-center justify-center rounded-full text-white/85",
                  "bg-zinc-900/80 backdrop-blur-xl border border-white/15 shadow-2xl",
                  "transition-all duration-200 hover:scale-110 hover:bg-zinc-800 hover:text-white hover:border-white/30 active:scale-95",
                  curIdx <= 0 && "pointer-events-none opacity-20",
                  curIdx > 0 && (chromeVisible ? "opacity-100" : "opacity-40 hover:opacity-100"),
                )}
              >
                <IconChevronLeft size={28} />
              </button>

              {/* Next Button */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  go(1);
                }}
                disabled={curIdx >= count - 1}
                title={t("layout.image.next")}
                className={cn(
                  "pointer-events-auto absolute right-5 top-1/2 -translate-y-1/2 z-30",
                  "flex h-12 w-12 items-center justify-center rounded-full text-white/85",
                  "bg-zinc-900/80 backdrop-blur-xl border border-white/15 shadow-2xl",
                  "transition-all duration-200 hover:scale-110 hover:bg-zinc-800 hover:text-white hover:border-white/30 active:scale-95",
                  curIdx >= count - 1 && "pointer-events-none opacity-20",
                  curIdx < count - 1 && (chromeVisible ? "opacity-100" : "opacity-40 hover:opacity-100"),
                )}
              >
                <IconChevronRight size={28} />
              </button>
            </>
          )}

          {/* ── Main Stage (Canvas for Pan, Zoom, and Drag) ── */}
          <div
            ref={containerRef}
            onClick={handleStageClick}
            data-backdrop-dismiss="true"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={handleWheel}
            onDoubleClick={handleDoubleClick}
            className={cn(
              "relative flex-1 w-full h-full overflow-hidden select-none",
              item.kind === "image"
                ? isDragging
                  ? "cursor-grabbing"
                  : "cursor-grab"
                : "cursor-default",
            )}
          >
            {item.kind === "image" ? (
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
                style={{
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
                  transition: isDragging ? "none" : "transform 140ms cubic-bezier(0.2, 0, 0, 1)",
                }}
              >
                <img
                  key={item.src}
                  src={item.src}
                  alt={item.alt || ""}
                  draggable={false}
                  onLoad={handleImageLoad}
                  style={{
                    transform: `scale(${scale}) rotate(${rotation}deg)`,
                    transformOrigin: "center center",
                    transition: isDragging
                      ? "none"
                      : "transform 140ms cubic-bezier(0.2, 0, 0, 1)",
                    maxWidth: "none",
                    maxHeight: "none",
                  }}
                  className="pointer-events-auto rounded shadow-2xl"
                />
              </div>
            ) : (
              /* Video stage */
              <div className="absolute inset-0 flex items-center justify-center p-8 pointer-events-none">
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

          {/* ── Bottom Dock (Frosted glass floating action dock) ── */}
          <div
            onMouseEnter={() => {
              overChromeRef.current = true;
              wakeChrome();
            }}
            onMouseLeave={() => {
              overChromeRef.current = false;
              wakeChrome();
            }}
            className="pointer-events-none absolute inset-x-0 bottom-5 z-30 flex justify-center px-4"
          >
            <div
              className={cn(
                "pointer-events-auto flex items-center gap-0.5 rounded-2xl p-1.5 shadow-2xl",
                "bg-zinc-900/85 text-white backdrop-blur-2xl border border-white/15",
                "transition-all duration-300",
                chromeVisible ? "opacity-100 translate-y-0" : "opacity-40 hover:opacity-100 translate-y-1",
              )}
            >
              {item.kind === "image" && (
                <>
                  {/* Zoom Out */}
                  <DockButton
                    label={t("layout.image.zoomOut")}
                    onClick={() => {
                      setScale((s) => Math.max(0.08, s * 0.8));
                      wakeChrome();
                    }}
                  >
                    <IconZoomOut size={18} />
                  </DockButton>

                  {/* Zoom percentage button (click resets to fitScale) */}
                  <button
                    type="button"
                    onClick={() => {
                      setScale(fitScale);
                      setPan({ x: 0, y: 0 });
                      setRotation(0);
                      wakeChrome();
                    }}
                    title={t("layout.image.resetZoom")}
                    className="px-2.5 py-1 text-xs font-mono font-medium text-white/80 hover:text-white transition-colors tabular-nums rounded-lg hover:bg-white/10"
                  >
                    {Math.round(scale * 100)}%
                  </button>

                  {/* Zoom In */}
                  <DockButton
                    label={t("layout.image.zoomIn")}
                    onClick={() => {
                      setScale((s) => Math.min(10.0, s * 1.25));
                      wakeChrome();
                    }}
                  >
                    <IconZoomIn size={18} />
                  </DockButton>

                  <DockDivider />

                  {/* Fit Window */}
                  <DockButton
                    label={t("layout.image.fitScreen")}
                    onClick={() => {
                      setScale(fitScale);
                      setPan({ x: 0, y: 0 });
                      wakeChrome();
                    }}
                  >
                    <IconArrowsMinimize size={18} />
                  </DockButton>

                  {/* 1:1 Original Size */}
                  <DockButton
                    label={t("layout.image.originalSize")}
                    onClick={() => {
                      setScale(1);
                      setPan({ x: 0, y: 0 });
                      wakeChrome();
                    }}
                  >
                    <IconArrowsMaximize size={18} />
                  </DockButton>

                  {/* Rotate 90° Clockwise */}
                  <DockButton
                    label={t("layout.image.rotate")}
                    onClick={() => {
                      setRotation((r) => (r + 90) % 360);
                      wakeChrome();
                    }}
                  >
                    <IconRotateClockwise size={18} />
                  </DockButton>

                  <DockDivider />
                </>
              )}

              {/* Media actions */}
              {item.kind === "image" ? (
                <>
                  {/* Copy Image */}
                  <DockButton
                    label={copyLabel}
                    onClick={() => void handleCopy()}
                    disabled={copyState === "copying" || !isDataImage}
                    tone={copyState === "done" ? "accent" : copyState === "error" ? "danger" : "default"}
                  >
                    {copyState === "done" ? (
                      <IconCheck size={18} className="text-emerald-400" />
                    ) : (
                      <IconCopy size={18} />
                    )}
                  </DockButton>

                  {/* Download Image */}
                  <DockButton
                    label={t("layout.image.download")}
                    onClick={() => {
                      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                      downloadDataUrl(item.src, t("layout.image.downloadName", { stamp }));
                    }}
                  >
                    <IconDownload size={18} />
                  </DockButton>

                  {/* Reveal in File Manager (Electron) */}
                  {isElectron && (
                    <DockButton
                      label={revealLabel}
                      onClick={() => void handleReveal()}
                      disabled={revealState === "working" || !isDataImage}
                      tone={
                        revealState === "done" ? "accent" : revealState === "error" ? "danger" : "default"
                      }
                    >
                      {revealState === "done" ? (
                        <IconCheck size={18} className="text-emerald-400" />
                      ) : (
                        <IconFolderOpen size={18} />
                      )}
                    </DockButton>
                  )}
                </>
              ) : (
                /* Video item actions */
                <>
                  <DockButton
                    label={t("chatStream.video.openInEditor")}
                    onClick={() => {
                      openFileInIde(item.filePath);
                      onClose();
                    }}
                  >
                    <IconCode size={18} />
                  </DockButton>

                  {isElectron && (
                    <>
                      <DockButton
                        label={vidRevealLabel}
                        onClick={() => void handleVideoReveal()}
                        disabled={vidRevealState === "working"}
                        tone={
                          vidRevealState === "done"
                            ? "accent"
                            : vidRevealState === "error"
                              ? "danger"
                              : "default"
                        }
                      >
                        {vidRevealState === "done" ? (
                          <IconCheck size={18} className="text-emerald-400" />
                        ) : (
                          <IconFolderOpen size={18} />
                        )}
                      </DockButton>

                      <DockButton
                        label={t("ide.editor.openInSystem")}
                        onClick={() => void api.shell.openFile({ path: item.filePath })}
                      >
                        <IconPlayerPlay size={18} />
                      </DockButton>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
