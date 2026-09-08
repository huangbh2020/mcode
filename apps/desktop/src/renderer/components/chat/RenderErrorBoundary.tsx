import { Component, type ErrorInfo, type ReactNode } from "react";
import { IconAlertTriangle } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * A per-segment error boundary for the chat stream.
 *
 * The renderer has exactly one React tree and — until now — no boundary at
 * all, so a single card throwing during render (malformed block, memoized
 * Markdown edge, recycled-cell kind flip) unmounted the WHOLE tree: the
 * window went permanently black while the renderer process stayed alive, and
 * nothing recovered it (the 2026-09-08 black screens). Wrapping the chat
 * stream's independently-rendered surfaces (message blocks, ops groups, the
 * composer editor) means a crash degrades to ONE fallback card instead of the
 * whole app.
 *
 * The boundary is deliberately fine-grained (per block segment, not per app
 * section): the fallback replaces only the broken segment and the rest of the
 * stream — including everything after it — keeps working.
 *
 * componentDidCatch re-logs the original error + component stack via
 * console.error: main/window.ts persists those lines to main.log as
 * [renderer:ERROR], so a caught crash leaves the same forensic trail the
 * uncaught one did (the React 19 default onUncaughtError logs only the
 * component name, and the boundary now swallows the error before it ever
 * reaches that handler).
 */
class RenderErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error | null } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Single pre-formatted string: Electron's console-message forwarder only
    // persists the formatted line, and an object arg would lose the stack.
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(
      `[render-boundary] ${detail}${info.componentStack ? `\n${info.componentStack}` : ""}`,
    );
  }

  render() {
    if (this.state.error) {
      return <RenderErrorFallback message={this.state.error.message} />;
    }
    return this.props.children;
  }
}

/** Amber (not red) replacement card — matches the turn-incomplete card's
 *  severity: something failed to DISPLAY, the conversation itself is intact.
 *  The raw error message rides on the title attribute for hover debugging
 *  without polluting the stream. */
function RenderErrorFallback({ message }: { message: string }) {
  const { t } = useI18n();
  return (
    <div
      className="flex max-w-xl items-start gap-1.5 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-warning [font-size:var(--chat-fs-sm)]"
      title={message}
    >
      <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{t("chatStream.renderError")}</span>
    </div>
  );
}

export { RenderErrorBoundary };
