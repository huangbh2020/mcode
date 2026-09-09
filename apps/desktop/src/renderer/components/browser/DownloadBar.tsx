import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  IconDownload,
  IconLoader2,
  IconCircleCheck,
  IconAlertTriangle,
  IconCircleXFilled,
  IconFolderOpen,
  IconX,
} from "@renderer/lib/icons.js";

/**
 * Download bar — a Chrome-download-bar-style strip at the bottom of the
 * browser panel, fed by the "download" browser:event pushes (start + terminal
 * state). One chip per tracked download: spinner while downloading, terminal
 * state styling after. A completed chip's click opens the file with the OS
 * default app; the folder button always reveals it in
 * `<系统下载>/mcode-browser/`. Chips auto-dismiss ~8s after reaching a
 * terminal state (timer held by the parent) and can be removed manually.
 *
 * The bar takes layout height when non-empty, which shrinks the stage — the
 * stage's ResizeObserver re-syncs the WebContentsView bounds automatically.
 */
export interface DownloadBarItem {
  downloadId: string;
  filename: string;
  path: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
}

export interface DownloadBarProps {
  items: DownloadBarItem[];
  onOpen: (downloadId: string) => void;
  onReveal: (downloadId: string) => void;
  onDismiss: (downloadId: string) => void;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function DownloadBar({ items, onOpen, onReveal, onDismiss }: DownloadBarProps) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  const stateLabel = (state: DownloadBarItem["state"]): string => {
    switch (state) {
      case "progressing":
        return t("browser.downloadStateProgressing");
      case "completed":
        return t("browser.downloadStateCompleted");
      case "cancelled":
        return t("browser.downloadStateCancelled");
      case "interrupted":
        return t("browser.downloadStateInterrupted");
    }
  };
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-edge bg-surface-muted px-2">
      <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-content-muted">
        <IconDownload size={12} />
        {t("browser.downloadBarLabel")}
      </span>
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {items.map((d) => (
          <span
            key={d.downloadId}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px]",
              d.state === "completed" &&
                "cursor-pointer border-accent/40 bg-accent/10 text-accent transition-colors hover:bg-accent/20",
              d.state === "progressing" && "border-edge bg-surface text-content",
              (d.state === "cancelled" || d.state === "interrupted") &&
                "border-red-500/40 bg-red-500/10 text-content-muted",
            )}
            title={d.state === "completed" ? `${d.path}\n${t("browser.downloadOpenFile")}` : d.path}
            onClick={() => {
              if (d.state === "completed") onOpen(d.downloadId);
            }}
          >
            {d.state === "progressing" ? (
              <IconLoader2 size={11} className="animate-spin opacity-70" />
            ) : d.state === "completed" ? (
              <IconCircleCheck size={11} className="opacity-80" />
            ) : d.state === "interrupted" ? (
              <IconAlertTriangle size={11} className="text-red-500 opacity-80" />
            ) : (
              <IconCircleXFilled size={11} className="opacity-60" />
            )}
            <span className="max-w-[160px] truncate font-medium">{d.filename}</span>
            <span className="shrink-0 text-content-muted">
              {d.state === "progressing"
                ? stateLabel(d.state)
                : `${stateLabel(d.state)} · ${formatBytes(d.receivedBytes)}`}
            </span>
            {d.state === "completed" && (
              <button
                type="button"
                aria-label={t("browser.downloadRevealFolder")}
                title={t("browser.downloadRevealFolder")}
                onClick={(e) => {
                  e.stopPropagation();
                  onReveal(d.downloadId);
                }}
                className="inline-flex h-4 w-4 items-center justify-center rounded text-accent/70 transition-colors hover:bg-accent/30 hover:text-accent"
              >
                <IconFolderOpen size={11} />
              </button>
            )}
            <button
              type="button"
              aria-label={t("browser.downloadDismiss")}
              title={t("browser.downloadDismiss")}
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(d.downloadId);
              }}
              className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
            >
              <IconX size={10} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
