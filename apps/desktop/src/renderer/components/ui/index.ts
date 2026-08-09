/**
 * UI component barrel export.
 *
 * All reusable UI components live in this directory and are exported
 * from here. Import from @renderer/components/ui/index.js.
 *
 * @example
 *   import { Button, Input, Dialog } from "@renderer/components/ui/index.js";
 */
export { Button, buttonVariants } from "./button.js";
export type { ButtonProps } from "./button.js";

export { Input } from "./input.js";
export type { InputProps } from "./input.js";

export { Dialog } from "./dialog.js";
export type {
  DialogRootProps,
  DialogBackdropProps,
  DialogPopupProps,
  DialogTitleProps,
  DialogDescriptionProps,
  DialogCloseProps,
  DialogTriggerProps,
} from "./dialog.js";

export { ConfirmDialog } from "./confirm-dialog.js";
export type { ConfirmDialogProps } from "./confirm-dialog.js";

export { Select } from "./select.js";
export type {
  SelectRootProps,
  SelectTriggerProps,
  SelectValueProps,
  SelectPopupProps,
  SelectPositionerProps,
  SelectListProps,
  SelectItemProps,
  SelectGroupProps,
  SelectGroupLabelProps,
  SelectSeparatorProps,
} from "./select.js";

export { Card } from "./card.js";
export type { CardProps } from "./card.js";

export { Switch } from "./switch.js";
export type { SwitchProps } from "./switch.js";

export { Tooltip } from "./tooltip.js";
export type {
  TooltipRootProps,
  TooltipProviderProps,
  TooltipTriggerProps,
  TooltipPositionerProps,
  TooltipPopupProps,
} from "./tooltip.js";

export { Kbd } from "./kbd.js";
export type { KbdProps } from "./kbd.js";

export { ImageWithPreview } from "./image-preview.js";
export type { ImageWithPreviewProps } from "./image-preview.js";
