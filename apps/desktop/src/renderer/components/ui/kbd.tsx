/**
 * Kbd — keyboard-shortcut display component.
 *
 * Renders a shortcut chord as a row of keycaps (VS Code / Linear style),
 * one `<kbd>` per key/modifier token. Pair it with
 * `acceleratorToDisplayTokens` from `@renderer/lib/shortcuts.js` to split an
 * `Accelerator` into per-keycap tokens.
 *
 * @example
 *   <Kbd keys={["⌘", "K"]} size="xs" />
 *   <Kbd keys={["Ctrl", "Shift", "F"]} />
 *   <Kbd keys={["↑"]} />
 */
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn.js";

const kbdVariants = cva("inline-flex items-center", {
  variants: {
    size: {
      xs: "gap-0.5",
      sm: "gap-1",
    },
  },
  defaultVariants: { size: "sm" },
});

const keycapVariants = cva(
  // Keycap: raised box with a subtle bottom edge for depth, consistent with
  // the `rounded border border-edge` kbd style used across the app.
  "inline-flex items-center justify-center rounded border border-edge bg-surface/70 font-medium text-content-subtle shadow-[0_1px_0_rgba(0,0,0,0.06)]",
  {
    variants: {
      size: {
        xs: "h-4 min-w-4 px-1 text-[10px] leading-none",
        sm: "h-5 min-w-5 px-1.5 text-[11px] leading-none",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

export interface KbdProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof kbdVariants> {
  /** One keycap label per key/modifier token, e.g. `["⌘", "K"]`. */
  keys: string[];
}

/** Keyboard-shortcut display: each `keys` entry renders as its own keycap. */
export function Kbd({ keys, className, size, ...props }: KbdProps) {
  return (
    <span className={cn(kbdVariants({ size }), className)} {...props}>
      {keys.map((key, i) => (
        <kbd key={`${key}-${i}`} className={keycapVariants({ size })}>
          {key}
        </kbd>
      ))}
    </span>
  );
}
