/**
 * PDF preview pane — pdf.js canvas rendering inside the FileEditor preview
 * slot. Loaded via React.lazy from FileEditor, so this chunk (pdf.js main
 * library included) only loads when a PDF is actually opened.
 *
 * Architecture notes (see lib/pdfjs.ts for the loading pipeline):
 *  - Continuous vertical scrolling; each page is a sized placeholder div.
 *    An IntersectionObserver renders only pages near the viewport (±600px)
 *    and frees their canvases when they scroll away, so a 500-page document
 *    costs no more than a handful of live canvases.
 *  - A module-level semaphore caps concurrent page renders at 2 — pdf.js
 *    rendering is main-thread raster work; unbounded fan-out janks the UI.
 *  - A text layer (transparent, selectable spans from page.getTextContent)
 *    overlays each rendered canvas so text can be selected and copied.
 *  - Every rendered canvas is DPI-scaled (devicePixelRatio) via the render
 *    transform, clamped so no canvas edge exceeds 8192px (Chromium's raster
 *    ceiling) — huge zooms degrade instead of blanking.
 *  - Zoom: fit-width (default) / fit-page (both recomputed on container
 *    resize via ResizeObserver) / manual (toolbar ±, Ctrl+wheel).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  loadPdfDocument,
  PdfDocumentHandle,
  PdfEncryptedError,
} from "@renderer/lib/pdfjs.js";
import { api } from "@renderer/lib/api.js";
import {
  IconChevronLeft,
  IconChevronRight,
  IconExternalLink,
  IconFileTypePdf,
  IconLoader2,
  IconRotateClockwise,
  IconZoomIn,
  IconZoomOut,
} from "@renderer/lib/icons.js";

/* ───────────── shared constants & render semaphore ───────────── */

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const ZOOM_STEP = 1.2;
/** Fit-mode horizontal padding inside the scroll container. */
const FIT_PADDING = 48;
/** Chromium canvas raster ceiling — clamp the devicePixelRatio so extreme
 *  zooms degrade instead of producing a blank canvas. */
const MAX_CANVAS_EDGE = 8192;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Module-level render-slot semaphore — at most 2 pages rasterize at once. */
const MAX_CONCURRENT_PAGE_RENDERS = 2;
let activeRenders = 0;
const renderWaiters: (() => void)[] = [];
async function withRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeRenders >= MAX_CONCURRENT_PAGE_RENDERS) {
    await new Promise<void>((resolve) => {
      renderWaiters.push(resolve);
    });
  }
  activeRenders++;
  try {
    return await fn();
  } finally {
    activeRenders--;
    renderWaiters.shift()?.();
  }
}

type ZoomMode = "fit-width" | "fit-page" | "manual";
type Phase = "loading" | "ready" | "error" | "encrypted";

/* ───────────── pane ───────────── */

export default function PdfPreviewPane({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("loading");
  const [handle, setHandle] = useState<PdfDocumentHandle | null>(null);
  const [numPages, setNumPages] = useState(0);
  /** First page size at scale=1 (rotation applied via `rotation` at use time). */
  const [basePage, setBasePage] = useState<{ w: number; h: number } | null>(null);

  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit-width");
  const [manualScale, setManualScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  /** Non-null while the page input has focus — shows the draft, not the live page. */
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<PdfDocumentHandle | null>(null);
  const pageEls = useRef<(HTMLDivElement | null)[]>([]);

  /* Load / reload the document for the current filePath. */
  useEffect(() => {
    let active = true;
    setPhase("loading");
    setHandle(null);
    setNumPages(0);
    setBasePage(null);
    setCurrentPage(1);
    pageEls.current = [];
    loadPdfDocument(filePath)
      .then(async (h) => {
        if (!active) {
          void h.destroy();
          return;
        }
        handleRef.current = h;
        setHandle(h);
        const first = await h.doc.getPage(1);
        if (!active) return;
        const vp = first.getViewport({ scale: 1 });
        setBasePage({ w: vp.width, h: vp.height });
        setNumPages(h.doc.numPages);
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof PdfEncryptedError) setPhase("encrypted");
        else setPhase("error");
      });
    return () => {
      active = false;
      void handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, [filePath]);

  /* Track the scroll container's size for the fit zoom modes. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  /* Ctrl+wheel zoom (native listener — React's wheel handler is passive and
     cannot preventDefault the browser's pinch/page-zoom gesture). */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoomMode("manual");
      setManualScale((s) => clamp(e.deltaY < 0 ? s * ZOOM_STEP : s / ZOOM_STEP, MIN_SCALE, MAX_SCALE));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const rotated = rotation % 180 !== 0;
  const baseW = basePage ? (rotated ? basePage.h : basePage.w) : 0;
  const baseH = basePage ? (rotated ? basePage.w : basePage.h) : 0;

  const effectiveScale = useMemo(() => {
    if (!basePage || !containerSize || containerSize.w <= 0 || containerSize.h <= 0) return 1;
    if (zoomMode === "manual") return clamp(manualScale, MIN_SCALE, MAX_SCALE);
    if (zoomMode === "fit-width") {
      return clamp((containerSize.w - FIT_PADDING) / baseW, MIN_SCALE, MAX_SCALE);
    }
    return clamp(
      Math.min((containerSize.w - FIT_PADDING) / baseW, (containerSize.h - FIT_PADDING) / baseH),
      MIN_SCALE,
      MAX_SCALE,
    );
    // baseW/baseH derive from basePage+rotation; list them so the memo tracks them.
  }, [basePage, baseW, baseH, containerSize, zoomMode, manualScale, rotation]);

  const cssW = Math.floor(baseW * effectiveScale);
  const cssH = Math.floor(baseH * effectiveScale);

  /* Current-page tracking: which page occupies ~30% down the viewport. */
  const onScroll = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const y = sc.scrollTop + sc.clientHeight * 0.3;
    const els = pageEls.current;
    let page = 1;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!el) continue;
      const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      if (top <= y) page = i + 1;
      else break;
    }
    setCurrentPage((prev) => (prev === page ? prev : page));
  }, []);

  const goToPage = useCallback(
    (n: number) => {
      const target = clamp(Math.round(n), 1, numPages || 1);
      const el = pageEls.current[target - 1];
      const sc = scrollRef.current;
      if (el && sc) {
        const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
        sc.scrollTo({ top: Math.max(0, top - 12) });
      }
      setCurrentPage(target);
    },
    [numPages],
  );

  const commitPageDraft = useCallback(() => {
    if (pageDraft == null) return;
    const parsed = Number.parseInt(pageDraft, 10);
    setPageDraft(null);
    if (Number.isFinite(parsed)) goToPage(parsed);
  }, [pageDraft, goToPage]);

  const zoomBy = useCallback(
    (factor: number) => {
      setZoomMode("manual");
      setManualScale(clamp(effectiveScale * factor, MIN_SCALE, MAX_SCALE));
    },
    [effectiveScale],
  );

  const registerPageEl = useCallback((index: number, el: HTMLDivElement | null) => {
    pageEls.current[index] = el;
  }, []);

  /* ── states that replace the whole pane ── */
  if (phase === "loading") {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("ide.editor.readingPdf")}
      </div>
    );
  }
  if (phase === "encrypted" || phase === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-muted text-content-subtle">
          <IconFileTypePdf size={28} />
        </div>
        <div className="space-y-1">
          <p className="text-[13px] font-medium text-content">
            {phase === "encrypted" ? t("ide.editor.pdfEncrypted") : t("ide.editor.pdfFailed")}
          </p>
          <p className="max-w-[360px] text-[11px] leading-relaxed text-content-subtle">
            {phase === "encrypted" ? t("ide.editor.pdfEncryptedDesc") : t("ide.editor.pdfFailedDesc")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void api.shell.openFile({ path: filePath })}
          className="flex items-center gap-1.5 rounded-md border border-edge bg-surface px-3 py-1.5 text-[12px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          title={t("ide.editor.openInSystemHint")}
        >
          {t("ide.editor.openInSystem")}
        </button>
      </div>
    );
  }
  if (!handle || !basePage) return null;

  /* ── toolbar button styles ── */
  const toolBtn =
    "flex items-center justify-center rounded p-1 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content disabled:pointer-events-none disabled:opacity-40";
  const fitActive = "bg-surface-hover text-content";

  return (
    <div className="flex h-full flex-col">
      {/* PDF toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-edge-panel bg-surface-muted/40 px-2.5 text-content-muted">
        <button
          type="button"
          className={toolBtn}
          disabled={currentPage <= 1}
          onClick={() => goToPage(currentPage - 1)}
          aria-label={t("ide.editor.pdfPrevPage")}
          title={t("ide.editor.pdfPrevPage")}
        >
          <IconChevronLeft size={14} />
        </button>
        <div className="flex items-center gap-1 text-[11px] tabular-nums">
          <input
            value={pageDraft ?? String(currentPage)}
            onChange={(e) => setPageDraft(e.target.value)}
            onFocus={(e) => {
              setPageDraft(e.target.value);
              e.target.select();
            }}
            onBlur={commitPageDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            aria-label={t("ide.editor.pdfGoToPage")}
            title={t("ide.editor.pdfGoToPage")}
            inputMode="numeric"
            className="w-9 rounded border border-edge bg-surface px-1 py-0.5 text-center text-[11px] text-content outline-none focus:border-accent"
          />
          <span>/ {numPages}</span>
        </div>
        <button
          type="button"
          className={toolBtn}
          disabled={currentPage >= numPages}
          onClick={() => goToPage(currentPage + 1)}
          aria-label={t("ide.editor.pdfNextPage")}
          title={t("ide.editor.pdfNextPage")}
        >
          <IconChevronRight size={14} />
        </button>

        <div className="mx-1 h-4 w-px bg-edge" />

        <button
          type="button"
          className={`${toolBtn} ${zoomMode === "fit-width" ? fitActive : ""}`}
          onClick={() => setZoomMode("fit-width")}
          aria-label={t("ide.editor.pdfFitWidth")}
          title={t("ide.editor.pdfFitWidth")}
        >
          <span className="text-[10px] font-medium">W</span>
        </button>
        <button
          type="button"
          className={`${toolBtn} ${zoomMode === "fit-page" ? fitActive : ""}`}
          onClick={() => setZoomMode("fit-page")}
          aria-label={t("ide.editor.pdfFitPage")}
          title={t("ide.editor.pdfFitPage")}
        >
          <span className="text-[10px] font-medium">H</span>
        </button>
        <button
          type="button"
          className={toolBtn}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          aria-label={t("ide.editor.pdfZoomOut")}
          title={t("ide.editor.pdfZoomOut")}
        >
          <IconZoomOut size={14} />
        </button>
        <span className="w-10 text-center text-[11px] tabular-nums">
          {Math.round(effectiveScale * 100)}%
        </span>
        <button
          type="button"
          className={toolBtn}
          onClick={() => zoomBy(ZOOM_STEP)}
          aria-label={t("ide.editor.pdfZoomIn")}
          title={t("ide.editor.pdfZoomIn")}
        >
          <IconZoomIn size={14} />
        </button>
        <button
          type="button"
          className={toolBtn}
          onClick={() => setRotation((r) => (r + 90) % 360)}
          aria-label={t("ide.editor.pdfRotate")}
          title={t("ide.editor.pdfRotate")}
        >
          <IconRotateClockwise size={14} />
        </button>

        <div className="flex-1" />
        <button
          type="button"
          className={toolBtn}
          onClick={() => void api.shell.openFile({ path: filePath })}
          aria-label={t("ide.editor.openInSystem")}
          title={t("ide.editor.openInSystemHint")}
        >
          <IconExternalLink size={14} />
        </button>
      </div>

      {/* Pages — continuous scroll, lazily rendered */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto bg-surface-muted/60"
      >
        <div className="flex min-h-full flex-col items-center gap-4 px-6 py-6">
          {Array.from({ length: numPages }, (_, i) => (
            <PdfPage
              key={i + 1}
              index={i}
              doc={handle.doc}
              pageNumber={i + 1}
              scale={effectiveScale}
              rotation={rotation}
              cssW={cssW}
              cssH={cssH}
              scrollRoot={scrollRef}
              registerEl={registerPageEl}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────────── single page ───────────── */

function PdfPage({
  index,
  doc,
  pageNumber,
  scale,
  rotation,
  cssW,
  cssH,
  scrollRoot,
  registerEl,
}: {
  index: number;
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  cssW: number;
  cssH: number;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
  registerEl: (index: number, el: HTMLDivElement | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  /* Visibility (with lead/lag margin) drives canvas allocation. */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setVisible(entry.isIntersecting);
      },
      { root: scrollRoot.current, rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRoot]);

  /* Render the canvas + text layer while visible; cancel on any change. */
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;
    let textLayer: pdfjsLib.TextLayer | null = null;
    void withRenderSlot(async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        // `rotation` is EXTRA rotation on top of the page's own /Rotate —
        // getViewport's rotation argument replaces the default, so add both.
        const viewport = page.getViewport({
          scale,
          rotation: (page.rotate + rotation) % 360,
        });
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const dpr = Math.min(
          window.devicePixelRatio || 1,
          MAX_CANVAS_EDGE / Math.max(viewport.width, viewport.height),
        );
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        renderTask = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        await renderTask.promise;
        if (cancelled) return;

        const container = textRef.current;
        if (!container) return;
        container.replaceChildren();
        container.style.width = `${cssW}px`;
        container.style.height = `${cssH}px`;
        const textContent = await page.getTextContent();
        if (cancelled) return;
        textLayer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container,
          viewport,
        });
        await textLayer.render();
      } catch (err) {
        // RenderingCancelledException fires on every unmount/param change —
        // expected noise, not an error surface.
        if (err instanceof pdfjsLib.RenderingCancelledException) return;
        if (cancelled) return;
        console.warn(`pdf page ${pageNumber} render failed:`, err);
      }
    });
    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        /* cancel() only queues the rejection — nothing to catch here. */
      }
      textLayer?.cancel();
    };
    // cssW/cssH derive from scale — scale covers them.
  }, [visible, doc, pageNumber, scale, rotation, cssW, cssH]);

  return (
    <div
      ref={(el) => {
        wrapRef.current = el;
        registerEl(index, el);
      }}
      className="relative shrink-0 bg-white shadow-md"
      style={{ width: cssW, height: cssH }}
      data-page={pageNumber}
    >
      {visible && <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />}
      <div ref={textRef} className="pdf-text-layer" />
    </div>
  );
}
