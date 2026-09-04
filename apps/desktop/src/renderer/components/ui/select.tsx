/**
 * Select — reusable select / dropdown component.
 *
 * Built on @base-ui/react Select primitive. Provides Root, Trigger, Value,
 * Popup, List, Item, ItemText, ItemIndicator, Group, GroupLabel, Separator.
 *
 * @example
 *   <Select.Root value={value} onValueChange={setValue}>
 *     <Select.Trigger>
 *       <Select.Value placeholder="Pick one" />
 *     </Select.Trigger>
 *     <Select.Portal>
 *       <Select.Positioner>
 *         <Select.Popup>
 *           <Select.List>
 *             <Select.Item value="a">Option A</Select.Item>
 *             <Select.Item value="b">Option B</Select.Item>
 *           </Select.List>
 *         </Select.Popup>
 *       </Select.Positioner>
 *     </Select.Portal>
 *   </Select.Root>
 *
 *   ⚠️ The Positioner is NOT optional: `Select.Popup` reads its positioning
 *   context from it and throws ("SelectPositionerContext is missing") on
 *   mount without it — which React surfaces as a crash in <SelectPopup> the
 *   moment the popup opens.
 */
import { Select as BaseSelect } from "@base-ui/react/select";
import { cn } from "@renderer/lib/cn.js";
import { IconChevronDown, IconCheck } from "@renderer/lib/icons.js";

/* ───────── Root ───────── */

/**
 * Select Root — state container, does NOT render its own HTML element,
 * so it does NOT accept className.
 */
export type SelectRootProps = React.ComponentPropsWithoutRef<typeof BaseSelect.Root>;

function SelectRoot(props: SelectRootProps) {
  return <BaseSelect.Root {...props} />;
}

/* ───────── Trigger ───────── */

export interface SelectTriggerProps
  extends React.ComponentPropsWithoutRef<typeof BaseSelect.Trigger> {}

function SelectTrigger({ className, children, ...props }: SelectTriggerProps) {
  return (
    <BaseSelect.Trigger
      className={cn(
        "flex items-center gap-1 rounded-md border border-edge bg-surface px-2.5 py-1.5 text-xs text-content outline-none transition-colors",
        "hover:bg-surface-muted focus:border-accent",
        "data-[popup-open]:border-accent",
        className,
      )}
      {...props}
    >
      {children}
      <Select.Icon>
        <IconChevronDown size={14} className="text-content-subtle" />
      </Select.Icon>
    </BaseSelect.Trigger>
  );
}

/* ───────── Value ───────── */

export interface SelectValueProps
  extends React.ComponentPropsWithoutRef<typeof BaseSelect.Value> {}

function SelectValue({ className, ...props }: SelectValueProps) {
  return (
    <BaseSelect.Value
      className={cn("min-w-0 flex-1 truncate text-left", className)}
      {...props}
    />
  );
}

/* ───────── Icon ───────── */

export interface SelectIconProps
  extends React.ComponentPropsWithoutRef<typeof BaseSelect.Icon> {}

function SelectIcon({ className, ...props }: SelectIconProps) {
  return (
    <BaseSelect.Icon
      className={cn("flex-shrink-0", className)}
      {...props}
    />
  );
}

/* ───────── Popup ───────── */

export interface SelectPopupProps
  extends React.ComponentPropsWithRef<typeof BaseSelect.Popup> {}

function SelectPopup({ className, ...props }: SelectPopupProps) {
  return (
    <BaseSelect.Popup
      className={cn(
        "origin-top rounded-md border border-edge bg-surface py-1 shadow-lg",
        "data-[ending-style]:scale-y-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-y-95 data-[starting-style]:opacity-0",
        "transition-[transform,opacity] duration-100",
        className,
      )}
      {...props}
    />
  );
}

/* ───────── Portal ───────── */

function SelectPortal(
  props: React.ComponentPropsWithoutRef<typeof BaseSelect.Portal>,
) {
  return <BaseSelect.Portal {...props} />;
}

/* ───────── Positioner ───────── */

/**
 * Select Positioner — renders the popup's positioning wrapper. Base UI
 * requires `Select.Popup` to live inside a `Select.Positioner` (the popup
 * itself doesn't read the positioning context, so omitting this throws
 * "SelectPositionerContext is missing"). Place within `<Select.Portal>`.
 *
 * The z-index MUST live on the Positioner, not the Popup: the Positioner is
 * the `position: fixed` element that participates in the root stacking
 * context, while the Popup is `position: static` (a z-index there is inert).
 * Without it, the popup renders BELOW any overlay with a positive z-index
 * (e.g. the settings overlay in App.tsx is `z-30`), so the dropdown appears
 * unclickable/invisible. Matches Tooltip.Positioner's `z-[60]` convention.
 */
export type SelectPositionerProps = React.ComponentPropsWithoutRef<
  typeof BaseSelect.Positioner
>;

function SelectPositioner({ className, ...props }: SelectPositionerProps) {
  return (
    <BaseSelect.Positioner className={cn("z-[60]", className)} {...props} />
  );
}

/* ───────── List ───────── */

export interface SelectListProps
  extends React.ComponentPropsWithoutRef<typeof BaseSelect.List> {}

function SelectList({ className, ...props }: SelectListProps) {
  return (
    <BaseSelect.List
      className={cn("flex flex-col", className)}
      {...props}
    />
  );
}

/* ───────── Item ───────── */

export interface SelectItemProps
  extends React.ComponentPropsWithoutRef<typeof BaseSelect.Item> {}

function SelectItem({ className, children, ...props }: SelectItemProps) {
  return (
    <BaseSelect.Item
      className={cn(
        "group flex items-center gap-2 px-3 py-1.5 text-xs text-content-muted outline-none select-none",
        "hover:bg-surface-muted hover:text-content data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
        "data-[disabled]:opacity-30 data-[disabled]:cursor-not-allowed",
        className,
      )}
      {...props}
    >
      {/* Selection indicator - keepMounted so every item reserves the same
          left space (otherwise the selected item's text shifts right vs the
          others). The check icon is shown only on the selected item via the
          parent `group` + data-selected. */}
      <Select.ItemIndicator className="flex w-[14px] flex-shrink-0 justify-center" keepMounted>
        <IconCheck size={14} className="text-accent opacity-0 group-data-[selected]:opacity-100" />
      </Select.ItemIndicator>
      {children}
    </BaseSelect.Item>
  );
}

/* ───────── ItemText ───────── */

function SelectItemText(
  props: React.ComponentPropsWithoutRef<typeof BaseSelect.ItemText>,
) {
  return <BaseSelect.ItemText {...props} />;
}

/* ───────── ItemIndicator ───────── */

export interface SelectItemIndicatorProps
  extends React.ComponentPropsWithoutRef<typeof BaseSelect.ItemIndicator> {}

function SelectItemIndicator({ className, ...props }: SelectItemIndicatorProps) {
  return (
    <BaseSelect.ItemIndicator
      className={cn(
        "flex-shrink-0",
        // Hide the checkmark indicator visually to make space;
        // we render it inside SelectItem already.
        "invisible data-[highlighted]:visible",
        className,
      )}
      {...props}
    />
  );
}

/* ───────── Group ───────── */

export interface SelectGroupProps
  extends React.ComponentPropsWithoutRef<typeof BaseSelect.Group> {}

function SelectGroup({ className, ...props }: SelectGroupProps) {
  return <BaseSelect.Group className={cn(className)} {...props} />;
}

/* ───────── GroupLabel ───────── */

export interface SelectGroupLabelProps
  extends React.ComponentPropsWithoutRef<typeof BaseSelect.GroupLabel> {}

function SelectGroupLabel({ className, ...props }: SelectGroupLabelProps) {
  return (
    <BaseSelect.GroupLabel
      className={cn(
        "px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle",
        className,
      )}
      {...props}
    />
  );
}

/* ───────── Separator ───────── */

export interface SelectSeparatorProps
  extends React.ComponentPropsWithoutRef<typeof BaseSelect.Separator> {}

function SelectSeparator({ className, ...props }: SelectSeparatorProps) {
  return (
    <BaseSelect.Separator
      className={cn("my-1 border-t border-edge", className)}
      {...props}
    />
  );
}

/* ───────── Compound export ───────── */

export const Select = {
  Root: SelectRoot,
  Trigger: SelectTrigger,
  Value: SelectValue,
  Icon: SelectIcon,
  Popup: SelectPopup,
  Portal: SelectPortal,
  Positioner: SelectPositioner,
  List: SelectList,
  Item: SelectItem,
  ItemText: SelectItemText,
  ItemIndicator: SelectItemIndicator,
  Group: SelectGroup,
  GroupLabel: SelectGroupLabel,
  Separator: SelectSeparator,
};
