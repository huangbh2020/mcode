import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { cn } from "@renderer/lib/cn.js";
import { IconAdjustmentsHorizontal } from "@renderer/lib/icons.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { ComposerToolbar } from "./ComposerToolbar.js";

/**
 * Narrow-composer entry point for the chip cluster.
 *
 * When the chat pane is narrow, the inline chip row (Model / Effort /
 * Permission / ContextRing rendered by {@link ComposerToolbar}) is hidden by a
 * container query (see styles.css, `@container (width < 30rem)`), and THIS
 * toggle icon takes its place. Clicking it pops a panel that hosts the *same*
 * `ComposerToolbar` — so the controls collapse to a single icon visually, but
 * behaviour is identical to the wide-mode chip row (no duplicated logic).
 *
 * The toggle is hidden by default (`display:none` via the `.composer-chips-toggle`
 * rule) and only revealed at the narrow breakpoint; in wide mode it is absent
 * from the layout entirely.
 *
 * The popup deliberately uses `overflow-visible` so that `ModelDropdown` —
 * whose submenu is an absolute panel relative to its own wrapper (not a portal)
 * — can still render upward beyond the popup's box. Effort/Permission use
 * `Menu.Portal` and ContextRing uses a hover tooltip, so neither is affected.
 */
export function ComposerToolbarToggle({ sessionId }: { sessionId: string }) {
  // The popup hosts the full chip row and is wider than a narrow/wide-mode
  // chat column, so it can extend over the browser's rect — suppress the
  // browser view while open to keep it visible/clickable.
  const [open, setOpen] = useState(false);
  useSuppressBrowserView(open);
  return (
    <span className="composer-chips-toggle shrink-0">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              title="模型 / 思考级别 / 权限模式 / 上下文"
              aria-label="模型 / 思考级别 / 权限模式 / 上下文"
            />
          }
          className={cn(
            "composer-chip inline-flex h-8 w-8 items-center justify-center rounded-xl text-content-muted transition-all duration-150 ease-out",
            "hover:scale-110 hover:bg-accent/10 hover:text-accent active:scale-95",
          )}
        >
          <IconAdjustmentsHorizontal size={18} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="start">
            <Popover.Popup
              className={cn(
                // overflow-visible: let non-portal child dropdowns (Model) escape.
                "z-50 overflow-visible rounded-xl border border-edge bg-surface p-2 shadow-2xl",
                "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                "transition-[transform,opacity] duration-100",
              )}
            >
              <div className="flex items-center gap-2">
                <ComposerToolbar sessionId={sessionId} />
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}
