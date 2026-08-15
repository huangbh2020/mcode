/**
 * PatchView — colored line rendering of a unified git patch for the mobile
 * shell. Extracted from MobileGitScreen's DiffOverlay so other overlays can
 * reuse the same red/green line view.
 *
 * The patch lines are already tagged by git (+/-/space inside a hunk), so no
 * LCS comparison is needed — only the `@@ -a,b +c,d @@` ranges are parsed to
 * restore old/new line numbers.
 */
import { useMemo } from "react";
import { cn } from "@renderer/lib/cn.js";

/** One rendered row of a parsed unified patch. */
export type PatchRow =
  | { kind: "hunk"; label: string }
  | { kind: "add"; text: string; newNo: number }
  | { kind: "del"; text: string; oldNo: number }
  | { kind: "ctx"; text: string; oldNo: number; newNo: number };

/** Parse a unified patch into colored rows. File-level meta lines (diff --git
 *  / index / --- / +++) are skipped — the caller's title shows the path. */
export function parsePatch(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldNo = Number(m[1]) - 1;
        newNo = Number(m[2]) - 1;
      }
      rows.push({ kind: "hunk", label: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newNo: ++newNo });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldNo: ++oldNo });
    } else if (line.startsWith(" ") || line === "") {
      // Context line (git prefixes a space; an empty line inside a hunk is
      // also context whose space was stripped by transport).
      rows.push({ kind: "ctx", text: line.slice(1), oldNo: ++oldNo, newNo: ++newNo });
    }
    // Anything else ("\ No newline at end of file") is ignored.
  }
  return rows;
}

/** Render parsed patch rows as a colored, line-numbered column. */
export function PatchRows({ rows }: { rows: PatchRow[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[11px] leading-relaxed">
      {rows.map((r, i) =>
        r.kind === "hunk" ? (
          <div key={i} className="select-none bg-surface-muted/60 px-2 py-0.5 text-content-subtle">
            {r.label}
          </div>
        ) : (
          <div
            key={i}
            className={cn(
              "flex items-start whitespace-pre",
              // Fixed red/green diff colors (same convention as the desktop
              // DiffView): stable in both themes, independent of the accent hue.
              r.kind === "del"
                ? "bg-red-500/15 text-red-600 dark:text-red-400"
                : r.kind === "add"
                  ? "bg-green-500/15 text-green-600 dark:text-green-400"
                  : "text-content-muted",
            )}
          >
            <span className="w-9 shrink-0 select-none pr-1 text-right text-content-subtle">
              {r.kind !== "add" ? r.oldNo : ""}
            </span>
            <span className="w-9 shrink-0 select-none pr-1 text-right text-content-subtle">
              {r.kind !== "del" ? r.newNo : ""}
            </span>
            <span className="w-3 shrink-0 select-none text-center text-content-subtle">
              {r.kind === "del" ? "−" : r.kind === "add" ? "+" : " "}
            </span>
            <span className="flex-1 pr-2">{r.text || "\u00A0"}</span>
          </div>
        ),
      )}
    </div>
  );
}
