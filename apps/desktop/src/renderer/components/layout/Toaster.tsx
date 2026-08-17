/**
 * Toaster - renders the global in-app toast stack.
 *
 * Mounted once at the app root (App.tsx). Reads from the toast store and
 * renders a bottom-right stack of toast cards. Each card is clickable to
 * navigate to its source session (via openTab), and has a dismiss button.
 *
 * Toasts are fired from sessionStore.ingestEvent for background session
 * events when the window is focused (OS notifications are suppressed in that
 * case, so the toast is the user's only in-app signal beyond the badge).
 */
import { useEffect } from "react";
import { useToastStore, type ToastItem, type ToastKind } from "@renderer/stores/toastStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import { IconInfoCircle, IconAlertTriangle, IconAlertCircle, IconX } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Per-kind visual config: icon + accent border color. */
const KIND_META: Record<ToastKind, { icon: typeof IconInfoCircle; accent: string }> = {
  info: { icon: IconInfoCircle, accent: "border-l-accent" },
  warning: { icon: IconAlertTriangle, accent: "border-l-yellow-500" },
  error: { icon: IconAlertCircle, accent: "border-l-danger" },
};

function ToastCard({ toast }: { toast: ToastItem }) {
  const { t } = useI18n();
  const dismiss = useToastStore((s) => s.dismiss);
  const openTab = useSessionStore((s) => s.openTab);
  const meta = KIND_META[toast.kind];
  const Icon = meta.icon;

  const handleClick = () => {
    if (toast.sessionId) {
      void openTab(toast.sessionId);
    }
    dismiss(toast.id);
  };

  return (
    <div
      onClick={handleClick}
      className={cn(
        "group pointer-events-auto flex w-80 cursor-pointer items-start gap-2 rounded-md border border-edge border-l-2 bg-surface px-3 py-2.5 shadow-lg",
        "transition-all hover:bg-surface-hover",
        meta.accent,
      )}
      role="alert"
    >
      <Icon size={16} className={cn("mt-0.5 shrink-0", toast.kind === "error" ? "text-danger" : toast.kind === "warning" ? "text-yellow-500" : "text-accent")} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-content">{toast.title}</div>
        {toast.body && (
          <div className="mt-0.5 truncate text-[12px] text-content-muted">{toast.body}</div>
        )}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          dismiss(toast.id);
        }}
        className="shrink-0 rounded p-0.5 text-content-subtle opacity-0 transition-opacity hover:bg-surface-hover hover:text-content group-hover:opacity-100"
        aria-label={t("common.close")}
      >
        <IconX size={14} />
      </button>
    </div>
  );
}

/** The toast stack container. Mount once at the app root. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);

  // Escape key dismisses all toasts.
  useEffect(() => {
    if (toasts.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useToastStore.getState().clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toasts.length]);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}
