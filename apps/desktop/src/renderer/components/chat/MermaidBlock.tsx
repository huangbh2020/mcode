import { memo, useState, useEffect, useRef, useLayoutEffect } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import {
  IconCheck,
  IconCopy,
  IconLoader2,
  IconAlertTriangle,
  IconChevronDown,
  IconChevronUp,
  IconArrowsMaximize,
} from "@renderer/lib/icons.js";

let mermaidPromise: Promise<typeof import("mermaid")["default"]> | null = null;
let mermaidIdCounter = 0;

/** Collapsed height of a mermaid block before the user clicks 展开. */
const MERMAID_COLLAPSE_MAX_PX = 400;

function ensureMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        fontFamily: "inherit",
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

function isDarkMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
        "text-content-subtle hover:bg-surface-hover/60 hover:text-content-muted",
      )}
      title={t("chatStream.copyCode")}
    >
      {copied ? (
        <>
          <IconCheck size={10} /> {t("common.copied")}
        </>
      ) : (
        <>
          <IconCopy size={10} /> {t("common.copy")}
        </>
      )}
    </button>
  );
}

export interface MermaidBlockProps {
  rawCode: string;
  className?: string;
  renderCodeFallback?: (code: string) => React.ReactNode;
}

export const MermaidBlock = memo(function MermaidBlock({
  rawCode,
  renderCodeFallback,
}: MermaidBlockProps) {
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<"chart" | "code">("chart");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Fullscreen lightbox dialog state
  const [lightboxOpen, setLightboxOpen] = useState(false);
  useSuppressBrowserView(lightboxOpen);

  // Collapse / expand handling for long diagrams or code
  const [expanded, setExpanded] = useState(false);
  const [clippable, setClippable] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const cleanCode = rawCode.trim();

    if (!cleanCode) {
      setSvg(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const renderId = `mcode-mermaid-${++mermaidIdCounter}`;

    void (async () => {
      try {
        const mermaid = await ensureMermaid();
        if (cancelled) return;

        const dark = isDarkMode();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "default",
          fontFamily: "inherit",
        });

        const result = await mermaid.render(renderId, cleanCode);
        if (!cancelled) {
          setSvg(result.svg);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          // Clean up stray mermaid element if inserted
          const stray = document.getElementById(renderId) ?? document.getElementById(`d${renderId}`);
          stray?.remove();

          setError(err instanceof Error ? err.message : String(err));
          setSvg(null);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rawCode]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    setClippable(el.scrollHeight > el.clientHeight + 1);
  }, [rawCode, svg, loading, viewMode, expanded]);

  const hasError = !!error;
  const showCode = viewMode === "code" || (hasError && viewMode === "chart");

  return (
    <div className="my-[var(--chat-md-gap-md)] overflow-hidden rounded-lg border border-edge/60 bg-surface-muted/60">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-2 border-b border-edge/60 bg-surface-muted/40 px-2 py-1 text-content-subtle [font-size:var(--chat-fs-xxs)]">
        <div className="flex items-center gap-2">
          <span className="font-mono font-medium text-content-muted">mermaid</span>
          <div className="flex items-center rounded border border-edge/40 bg-surface/50 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setViewMode("chart")}
              className={cn(
                "rounded px-1.5 py-0.5 transition-colors",
                viewMode === "chart"
                  ? "bg-surface text-content font-medium shadow-xs"
                  : "text-content-subtle hover:text-content-muted",
              )}
            >
              {t("chatStream.mermaid.chart")}
            </button>
            <button
              type="button"
              onClick={() => setViewMode("code")}
              className={cn(
                "rounded px-1.5 py-0.5 transition-colors",
                viewMode === "code"
                  ? "bg-surface text-content font-medium shadow-xs"
                  : "text-content-subtle hover:text-content-muted",
              )}
            >
              {t("chatStream.mermaid.code")}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {viewMode === "chart" && svg && !loading && (
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-surface-hover/60 hover:text-content-muted"
              title={t("chatStream.mermaid.fullscreen")}
            >
              <IconArrowsMaximize size={12} />
            </button>
          )}
          {clippable && expanded && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-surface-hover/60 hover:text-content-muted"
              title={t("chatStream.code.collapse")}
            >
              <IconChevronUp size={10} /> {t("chatStream.code.collapse")}
            </button>
          )}
          <CopyBtn text={rawCode.replace(/\n$/, "")} />
        </div>
      </div>

      {/* Main content with collapsible container */}
      <div className="relative">
        <div
          ref={bodyRef}
          className="overflow-auto"
          style={{ maxHeight: expanded ? undefined : MERMAID_COLLAPSE_MAX_PX }}
        >
          {showCode ? (
            <div>
              {hasError && viewMode === "chart" && (
                <div className="flex items-center gap-1.5 border-b border-edge/40 bg-warning/10 px-3 py-1 text-[11px] text-warning">
                  <IconAlertTriangle size={12} className="shrink-0" />
                  <span className="truncate">{t("chatStream.mermaid.renderError")}</span>
                </div>
              )}
              {renderCodeFallback ? (
                renderCodeFallback(rawCode)
              ) : (
                <pre className="overflow-auto p-3 font-mono text-[12px] leading-relaxed text-content">
                  <code>{rawCode}</code>
                </pre>
              )}
            </div>
          ) : (
            <div className="relative min-h-[60px] bg-surface/30">
              {loading && (
                <div className="flex h-24 items-center justify-center text-content-subtle">
                  <IconLoader2 size={16} className="animate-spin text-accent" />
                </div>
              )}
              {svg && !loading && (
                <div
                  ref={containerRef}
                  onClick={() => setLightboxOpen(true)}
                  className="group/mermaid relative flex cursor-zoom-in justify-center overflow-x-auto p-4 [&_svg]:max-w-full [&_svg]:h-auto"
                  title={t("chatStream.mermaid.clickToView")}
                >
                  <div dangerouslySetInnerHTML={{ __html: svg }} />
                  <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/mermaid:opacity-100">
                    <IconArrowsMaximize size={11} />
                    {t("chatStream.mermaid.fullscreen")}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {clippable && !expanded && (
          <>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-surface-muted/95 to-transparent" />
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-edge bg-surface px-2.5 py-0.5 text-[11px] text-content-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-content"
              title={t("chatStream.code.expand")}
            >
              <IconChevronDown size={12} /> {t("chatStream.code.expand")}
            </button>
          </>
        )}
      </div>

      {/* Fullscreen Lightbox Dialog */}
      <Dialog.Root open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="!top-0 !bg-black/85 !backdrop-blur-md" />
          <Dialog.Popup className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-2xl backdrop-blur-xl md:inset-8">
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-edge/60 bg-surface-muted/40 px-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold text-content">mermaid</span>
                <span className="text-xs text-content-muted">· {t("chatStream.mermaid.fullscreen")}</span>
              </div>
              <div className="flex items-center gap-2">
                <CopyBtn text={rawCode.replace(/\n$/, "")} />
                <Dialog.Close />
              </div>
            </div>
            <div className="flex flex-1 items-center justify-center overflow-auto bg-surface/30 p-6">
              {svg && (
                <div
                  className="flex max-h-full max-w-full justify-center overflow-auto [&_svg]:max-w-full [&_svg]:h-auto"
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
});
