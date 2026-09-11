/**
 * Model-badge helpers: turning a turn's recorded model id into an avatar seed +
 * a display name.
 *
 * Lives in `lib/` (not next to the component) so the pure parsing can be
 * compiled and asserted directly by the smoke script — a replica of this logic
 * in a test would only prove the replica right.
 */

/** Avatar palette. DELIBERATELY separate from the project avatar palette
 *  (lib/projectAvatar.ts): models and projects are different namespaces, and
 *  sharing the list would reshuffle every existing project's color. */
export const MODEL_AVATAR_COLORS = [
  "#0d9488", // teal
  "#7c3aed", // violet
  "#d97706", // amber
  "#2563eb", // blue
  "#db2777", // pink
  "#059669", // emerald
];

/** Deterministic palette color for a model name (stable across sessions). */
export function modelAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return MODEL_AVATAR_COLORS[Math.abs(hash) % MODEL_AVATAR_COLORS.length];
}

/** The model's name portion: drops a `<providerId>/` prefix (codex binds
 *  sessions that way — the prefix is the endpoint, not the model) and the
 *  `[1m]`-style context-window suffix (an env-var decoration). Returns null
 *  when nothing is left, i.e. the caller should render no badge at all. */
export function modelDisplayName(model: string | undefined | null): string | null {
  if (!model) return null;
  const name = (model.split("/").pop() ?? model).replace(/\[[^\]]*\]/g, "").trim();
  return name || null;
}

/** The avatar glyph: the first alphanumeric character of the model's name,
 *  uppercased (`deepseek-flash` → "D", `_sonnet` → "S"). Null when the name has
 *  no alphanumeric character — a meaningless glyph is worse than none. */
export function modelInitial(model: string | undefined | null): string | null {
  const name = modelDisplayName(model);
  if (!name) return null;
  const letter = name.match(/[a-z0-9]/i)?.[0];
  return letter ? letter.toUpperCase() : null;
}
