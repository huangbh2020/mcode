import { cn } from "@renderer/lib/cn.js";
import type { lineDiff } from "@renderer/lib/lineDiff.js";

/**
 * Render a flat diff list as a monospace line column with per-op coloring.
 * Includes gutter line numbers for old/new so reviewers can correlate changes.
 *
 * Shared by the per-tool EditToolCard (inside the message stream) and the
 * turn-level TurnFilesCard (expanded per-file diff). Extracted from
 * MessageBlocks.tsx so both call sites render diffs identically.
 *
 * The diff input is the return type of `lineDiff()` — typed via `typeof` to
 * avoid a value import we don't need here (this component only renders).
 */
export function DiffView({
  diff,
  scrollClassName = "max-h-80",
}: {
  diff: ReturnType<typeof lineDiff>;
  /** Class controlling the scroll container's height. Overridable so
   *  full-screen consumers (the mobile viewer overlay) can fill the screen;
   *  defaults to the inline card height. */
  scrollClassName?: string;
}) {
  if (diff.length === 0) {
    return (
      <div className="rounded bg-surface-muted/60 p-2 text-content-subtle [font-size:var(--chat-fs-xs)]">
        (no changes)
      </div>
    );
  }
  // Compute old/new line numbers in a single pass: an inserted line has
  // no old-side number; a deleted line has no new-side; equal lines have
  // both. Numbers give the user a stable "where am I" reference while
  // reviewing the patch.
  const rows = annotateDiffWithLineNumbers(diff);

  return (
    <div className={cn("overflow-auto rounded bg-surface-muted/60 font-mono leading-relaxed [font-size:var(--chat-fs-xs)]", scrollClassName)}>
      {rows.map((d, i) => {
        // Fixed red/green diff colors that don't shift with the theme - the
        // accent/danger tokens change between light/dark (and track the
        // accent hue), but diff added/removed lines read best as stable,
        // conventional red vs green in both themes. The 600 shade is used in
        // light mode; dark mode lifts to 400 so the +/- lines stay bright and
        // readable on the deep background (600 reads too dim on near-black).
        const opBg =
          d.op === "delete"
            ? "bg-red-500/15 text-red-600 dark:text-red-400"
            : d.op === "insert"
            ? "bg-green-500/15 text-green-600 dark:text-green-400"
            : "text-content-muted";
        return (
          <div key={i} className={cn("flex items-start whitespace-pre", opBg)}>
            <span className="w-10 shrink-0 select-none border-r border-edge/40 px-1.5 text-right text-content-subtle">
              {d.oldNo ?? ""}
            </span>
            <span className="w-10 shrink-0 select-none border-r border-edge/40 px-1.5 text-right text-content-subtle">
              {d.newNo ?? ""}
            </span>
            <span className="w-3 shrink-0 select-none pl-1 text-content-subtle">
              {d.op === "delete" ? "−" : d.op === "insert" ? "+" : " "}
            </span>
            <span className="flex-1 pl-1 pr-2">{d.text || "\u00A0"}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Build a per-line record with old/new line numbers. A single pass keeps
 *  the numbering correct regardless of which side contributes to each
 *  line. The accumulator is local so the function is safe to call from
 *  any render without stateful side effects. */
export function annotateDiffWithLineNumbers(
  diff: ReturnType<typeof lineDiff>,
): Array<ReturnType<typeof lineDiff>[number] & { oldNo: number | null; newNo: number | null }> {
  let oldNo = 0;
  let newNo = 0;
  return diff.map((d) => {
    const oldN = d.op === "insert" ? null : ++oldNo;
    const newN = d.op === "delete" ? null : ++newNo;
    return { ...d, oldNo: oldN, newNo: newN };
  });
}
