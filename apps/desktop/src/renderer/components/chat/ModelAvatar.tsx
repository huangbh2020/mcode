import { cn } from "@renderer/lib/cn.js";
import { modelAvatarColor, modelDisplayName, modelInitial } from "@renderer/lib/modelAvatar.js";

/**
 * Monogram avatar for the model that produced a turn.
 *
 * The stream records the model per turn (`TurnMeta.model` — the composer's
 * resolved send-model id), because the selection can change between turns. This
 * avatar turns that id into a glanceable badge: the initial letter plus a
 * deterministic background hue, so two different models are distinguishable at
 * a glance without reading the name (the same trick the project avatars use).
 *
 * Parsing lives in lib/modelAvatar.ts (pure, smoke-tested); this file is the
 * view only.
 */

export function ModelAvatar({
  model,
  className,
}: {
  /** The turn's recorded model id; renders nothing when absent/empty. */
  model?: string | null;
  className?: string;
}) {
  const initial = modelInitial(model);
  const name = modelDisplayName(model);
  if (!initial || !name) return null;
  return (
    <span
      className={cn(
        "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-white",
        className,
      )}
      style={{ backgroundColor: modelAvatarColor(name) }}
      title={name}
      aria-label={name}
    >
      {initial}
    </span>
  );
}

/** Avatar + name as one left-aligned group for a turn's process header
 *  (方案A: the model that produced this turn rides with the summary row).
 *  Collapses to nothing when the turn has no recorded model — turns that
 *  predate the field must render exactly as before. */
export function ModelBadge({ model, className }: { model?: string | null; className?: string }) {
  const name = modelDisplayName(model);
  if (!name) return null;
  return (
    <span className={cn("inline-flex min-w-0 shrink-0 items-center gap-1.5", className)}>
      <ModelAvatar model={model} />
      <span className="chat-model-name truncate text-content-muted">{name}</span>
    </span>
  );
}
