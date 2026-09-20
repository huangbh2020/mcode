import { cn } from "@renderer/lib/cn.js";
import { projectInitial } from "@renderer/lib/projectAvatar.js";

/** The colored-initial project identity mark: a small rounded swatch with
 *  the project's uppercase initial, background from the project's display
 *  color. Shared by every surface that names a project (tree row, stream
 *  sidebar cards / scope menu, session tabs) so one project renders the
 *  same avatar everywhere.
 *
 *  The color arrives pre-resolved — callers go through
 *  `projectDisplayColor(project, projectColors)` so a user-picked color
 *  shows up on every surface at once. */
export function ProjectAvatar({
  name,
  color,
  className,
}: {
  name: string;
  color: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[8px] font-bold text-white",
        className,
      )}
      style={{ backgroundColor: color }}
      aria-hidden
    >
      {projectInitial(name)}
    </span>
  );
}
