import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconMinus, IconPlus } from "@renderer/lib/icons.js";

/**
 * Font-size stepper - a compact "−  value  +" control used by the
 * appearance settings (chat font size, side-panel font size). Replaces the
 * old `<input type="range">` sliders with explicit increment/decrement
 * buttons, which are easier to hit precisely than a 1px slider step.
 *
 * The value is clamped to [min, max] on both ends; the − / + buttons
 * disable at the boundaries. The caller owns the value + onChange (it just
 * forwards the next integer), so all persistence / store logic stays in the
 * setting row that uses this control.
 */
export function FontSizeStepper({
  value,
  min,
  max,
  onChange,
  id,
  className,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  /** Optional id so a sibling <label htmlFor> can focus the stepper. */
  id?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const atMin = value <= min;
  const atMax = value >= max;

  return (
    <div id={id} className={cn("flex items-center gap-1", className)}>
      <StepperButton
        title={t("settings.appearance.fontSmaller")}
        disabled={atMin}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <IconMinus size={13} />
      </StepperButton>
      <span className="w-12 text-center text-[0.7857em] tabular-nums text-content">
        {value}px
      </span>
      <StepperButton
        title={t("settings.appearance.fontLarger")}
        disabled={atMax}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <IconPlus size={13} />
      </StepperButton>
    </div>
  );
}

/** One square icon button of the stepper. */
function StepperButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded text-content-muted transition-colors",
        "hover:bg-surface-hover hover:text-content",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content-muted",
      )}
    >
      {children}
    </button>
  );
}
