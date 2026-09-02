import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconAdjustmentsHorizontal } from "@renderer/lib/icons.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { ComposerToolbar } from "./ComposerToolbar.js";

/**
 * Narrow-composer entry point for the chip cluster.
 *
 * When the chip row can't fit on one line beside the mic/provider/send
 * cluster — or the composer card itself is narrower than 580px (the width
 * floor in useComposerRowFit) — `useComposerRowFit` adds
 * `composer-row-collapsed` to the action
 * row (measured fit — not a fixed breakpoint, since the chips' width depends
 * on locale and selected values). The inline chip row (Model / Effort /
 * Permission / ContextRing rendered by {@link ComposerToolbar}) is then hidden
 * by CSS, and THIS toggle icon takes its place. Clicking it pops a panel that
 * hosts the *same* `ComposerToolbar` in its `layout="row"` presentation — a
 * vertical settings list where each control is a full-width labelled row
 * (field name left, current value right); each dropdown cascades to the
 * right of its row, or upward on phone-class viewports (useNarrowViewport).
 * The controls collapse to a single icon visually, but behaviour is
 * identical to the wide-mode chip row (no duplicated logic). Shared by the
 * desktop narrow pane, the side-chat panel, and the phone shell — the
 * vertical list is the usable shape in all three: it exists precisely
 * because horizontal space ran out, and labelled rows let the user read the
 * whole next-turn config (model / thinking / permission / context) at a
 * glance before opening anything.
 *
 * The toggle is hidden by default (`display:none` via the `.composer-chips-toggle`
 * rule) and only revealed by the collapsed state; in wide mode it is absent
 * from the layout entirely.
 *
 * The popup deliberately uses `overflow-visible` so that nested portaled
 * menus can still render beyond the popup's box. Effort/Permission use
 * `Menu.Portal` and ContextRing uses a hover tooltip, so neither is affected.
 */
export function ComposerToolbarToggle({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
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
              title={t("chat.toolbarToggle")}
              aria-label={t("chat.toolbarToggle")}
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
          {/* z on the POSITIONER (not just the popup): floating-ui positions
              it via transform, which creates a stacking context — a z-50 on
              the popup alone is trapped inside a z-auto positioner and loses
              to the center pane's z-10 (ThreePaneLayout's <main>). The chips
              popup is wider than the side-chat's right panel and overflows
              over the center pane, so without this the Model chip (leftmost)
              ends up underneath it and unclickable. Same convention as
              ui/select.tsx's Positioner wrapper. */}
          <Popover.Positioner side="top" align="start" className="z-50">
            <Popover.Popup
              className={cn(
                // overflow-visible: let portaled child menus escape the box.
                "z-50 overflow-visible rounded-xl border border-edge bg-surface p-1.5 shadow-2xl",
                "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                "transition-[transform,opacity] duration-100",
              )}
            >
              <ComposerToolbar sessionId={sessionId} layout="row" />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}
