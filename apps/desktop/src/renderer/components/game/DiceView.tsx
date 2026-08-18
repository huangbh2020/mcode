/**
 * DiceView - renders a row of dice for the liars dice game.
 *
 * Uses Tabler's filled die-face icons (IconDice1Filled .. IconDice6Filled) for
 * revealed dice, and the generic IconDice (question-mark face) for hidden dice
 * (the model's hand before a reveal). Each die is a fixed-size chip.
 */
import { cn } from "@renderer/lib/cn.js";
import {
  IconDice,
  IconDice1Filled,
  IconDice2Filled,
  IconDice3Filled,
  IconDice4Filled,
  IconDice5Filled,
  IconDice6Filled,
} from "@renderer/lib/icons.js";
import type { Face } from "@contracts/ipc";

const FACE_ICONS = [
  IconDice1Filled,
  IconDice2Filled,
  IconDice3Filled,
  IconDice4Filled,
  IconDice5Filled,
  IconDice6Filled,
] as const;

export interface DiceViewProps {
  /** The dice faces to render (1-6). When hidden, renders dice backs instead. */
  dice: Face[];
  /** When true, the dice faces are shown. When false, dice backs are rendered
   *  (for the model's hand before a reveal). */
  revealed: boolean;
  /** Optional extra className for the row. */
  className?: string;
  /** Size of each die icon in px. */
  size?: number;
}

export function DiceView({ dice, revealed, className, size = 28 }: DiceViewProps) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      {dice.map((face, i) => {
        const FaceIcon = FACE_ICONS[face - 1];
        return revealed ? (
          <FaceIcon
            key={i}
            size={size}
            className={cn(
              "shrink-0 text-content",
              face === 1 && "text-accent",
            )}
          />
        ) : (
          <IconDice
            key={i}
            size={size}
            className="shrink-0 text-content-muted"
          />
        );
      })}
    </div>
  );
}
