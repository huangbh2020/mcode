/**
 * Deterministic project avatar: background hue from the name hash plus the
 * uppercase initial. Shared by the stream sidebar's cards / scope menu and
 * the composer's directory switcher so a project renders the same color on
 * every surface.
 */

const PROJECT_AVATAR_COLORS = ["#3b82f6", "#d97706", "#8b5cf6", "#0d9488", "#e11d48", "#0284c7"];

/** Swatch palette offered by the project color picker (new-session panel's
 *  manage menu). Deliberately a SEPARATE superset — extending the hash list
 *  above would reshuffle every existing project's auto color. */
export const PROJECT_COLOR_SWATCHES = [
  "#3b82f6",
  "#0284c7",
  "#059669",
  "#0d9488",
  "#65a30d",
  "#d97706",
  "#e11d48",
  "#db2777",
  "#8b5cf6",
  "#4338ca",
  "#64748b",
];

/** Effective avatar color for a project: the user's pick when one was set
 *  (settings key `project.colors`, store bucket `projectColors`), else the
 *  deterministic name-hash default. Every surface that renders a project
 *  avatar goes through this so the choice shows up everywhere at once. */
export function projectDisplayColor(
  p: { id: string; name: string },
  custom: Record<string, string>,
): string {
  return custom[p.id] || projectAvatarColor(p.name);
}

export function projectAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PROJECT_AVATAR_COLORS[Math.abs(hash) % PROJECT_AVATAR_COLORS.length];
}

export function projectInitial(name: string): string {
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}
