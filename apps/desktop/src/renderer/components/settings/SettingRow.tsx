import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";

/** Fixed width of the control column in horizontal rows (plan A: `--ctrl-w`
 *  defaults to 240px). All rows share the same slot so the controls line up as
 *  one visual column down the card — selects/inputs fill it (`w-full`),
 *  switches & steppers right-align inside it. Rows whose control doesn't fit
 *  (long button combos, color palettes) use `layout="vertical"` instead and
 *  own the full row width. */
const CONTROL_SLOT_WIDTH = 240;

/**
 * One setting = one row. Left side carries a label (+ optional description),
 * right side carries the control(s) inside a fixed-width slot so every row's
 * control starts at the same x. Plan-A row template is a two-column grid
 * (`minmax(0,1fr) auto`) — a long description no longer pushes the control
 * onto a second line, it just narrows the label column. The parent container
 * draws the row separators (`divide-y divide-edge`) so this component stays a
 * pure layout shell — no borders of its own. Rows carry their own horizontal
 * inset (`px-3.5`) so content never touches the card edges.
 *
 * Control-slot conventions (horizontal layout):
 *  - Select / Input / Textarea: give them `w-full` so they fill the slot.
 *  - Switch / stepper / icon button: no extra classes — the slot right-aligns
 *    them (`justify-end`).
 *  - Select + trailing icon button combos: `flex-1 min-w-0` on the select.
 *
 * `htmlFor` (optional) makes the title label click-through to the control,
 * useful for native inputs like range/color. `controlAlign` lets the caller
 * vertically align the right column to the title (default) or to the whole
 * block (for multi-line descriptions).
 */
export function SettingRow({
  title,
  desc,
  descExtra,
  htmlFor,
  controlAlign = "center",
  layout = "horizontal",
  className,
  children,
}: {
  title: ReactNode;
  desc?: ReactNode;
  /** Optional secondary line below `desc` (e.g. a faint hint). */
  descExtra?: ReactNode;
  htmlFor?: string;
  /** Vertical alignment of the right control column (horizontal layout only). */
  controlAlign?: "center" | "start";
  /** Layout direction: horizontal = side-by-side, vertical = stacked. */
  layout?: "horizontal" | "vertical";
  className?: string;
  children: ReactNode;
}) {
  const isLabel = !!htmlFor;
  const TitleTag = isLabel ? "label" : "div";

  if (layout === "vertical") {
    return (
      <div className={cn("flex flex-col gap-2 px-3.5 py-3", className)}>
        <div>
          <TitleTag
            {...(isLabel ? { htmlFor } : {})}
            className="text-[0.9286em] font-medium leading-snug text-content"
          >
            {title}
          </TitleTag>
          {desc && (
            <div className="mt-0.5 text-[0.8571em] leading-relaxed text-content-subtle">
              {desc}
            </div>
          )}
          {descExtra && <div className="mt-0.5">{descExtra}</div>}
        </div>
        <div className="w-full">{children}</div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[18px] gap-y-1.5 px-3.5 py-3",
        className,
      )}
    >
      <div className="min-w-0">
        <TitleTag
          {...(isLabel ? { htmlFor } : {})}
          className="text-[0.9286em] font-medium leading-snug text-content"
        >
          {title}
        </TitleTag>
        {desc && (
          <div className="mt-0.5 text-[0.8571em] leading-relaxed text-content-subtle">
            {desc}
          </div>
        )}
        {descExtra && <div className="mt-0.5">{descExtra}</div>}
      </div>
      <div
        style={{ width: CONTROL_SLOT_WIDTH }}
        className={cn(
          "flex shrink-0 items-center justify-end gap-2",
          controlAlign === "start" ? "self-start" : "self-center",
        )}
      >
        {children}
      </div>
    </div>
  );
}
