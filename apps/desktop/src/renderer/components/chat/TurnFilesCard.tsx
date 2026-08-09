import { useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { basename } from "@renderer/lib/path.js";
import { api } from "@renderer/lib/api.js";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconFile,
  IconPlus,
  IconEdit,
} from "@renderer/lib/icons.js";

/**
 * "本轮修改" card - rendered INLINE in the message stream as a per-turn
 * trailing `kind: "turn-files"` block. Each turn that touched files keeps its
 * own card frozen in history (new turns add new cards; old cards stay as
 * read-only snapshots and are never deleted). On session reopen every
 * historical card is restored from the persisted message snapshot.
 *
 * One expand level: card folded -> "本轮修改了 N 个文件 +总A -总D". Expand to
 * see the file rows. Clicking a row opens that file's diff for review - WHERE
 * it opens follows the Git setting "差异打开方式" (center editor column, or the
 * floating multi-tab diff dialog). The card's frozen `before` is passed
 * through so HISTORICAL turns - whose snapshot is gone from the live
 * turn-files bucket - still diff against the current on-disk content.
 *
 * Rewind: only the LATEST turn's card (`isLatestTurn === true`) renders the
 * 撤销本轮 button - it restores files via the in-memory FileSnapshot (cleared
 * per turn, so only the most recent turn is rewindable). Older cards are
 * display-only; their rewind button is hidden. The rewind action is pulled
 * from the store directly (the card is the sole consumer), keeping the block
 * rendering path prop-free.
 *
 * Theme: neutral surface/edge tokens (no accent) - these are *completed*
 * file ops, not pending approvals. The +/- tallies keep accent/danger for
 * semantic color (green=added, red=deleted).
 */
export function TurnFilesCard({
  files,
  isLatestTurn,
  rewound,
}: {
  files: TurnFileEntry[];
  /** True only on the latest turn's card - the "live" rewind (clears the
   *  card on success). Older cards rewind individually via the historical
   *  path (confirmed, marks the card in place). */
  isLatestTurn?: boolean;
  /** True once this turn's files have been rewound. The card stays in the
   *  stream but renders dimmed with a "已撤销" badge; the rewind button is
   *  hidden. */
  rewound?: boolean;
}) {
  // Default expand state by lifecycle: the latest turn expands so the user
  // sees the fresh changes + rewind affordance; historical cards collapse to
  // a one-line summary (keeps the scroll-back history calm).
  const [open, setOpen] = useState(!!isLatestTurn);
  // rewindTurn comes from the store - invoked for both the latest turn
  // (clears the card) and historical turns (marks the card in place).
  const rewindTurn = useSessionStore((s) => s.rewindTurn);
  // Local rewind-in-flight flag so the button is disabled while the
  // IPC call is in progress (main also clears the card on its
  // `turn.rewound` event, but that takes a tick after the IPC resolves).
  const [rewinding, setRewinding] = useState(false);
  // Toggle to "撤销成功" briefly after success, so the user gets
  // confirmation before the card disappears (latest-turn) or flips to
  // the 已撤销 state (historical).
  const [done, setDone] = useState(false);

  const handleRewind = async () => {
    if (rewinding || rewound) return;
    // Historical rewind can clobber later turns' edits to the same files —
    // confirm before proceeding. Mirrors SDK checkpoint semantics where
    // rolling back to an old checkpoint is the user's explicit choice.
    if (!isLatestTurn) {
      const ok = window.confirm(
        "撤销历史轮次会把该轮修改的文件恢复到当时修改前的状态，\n可能影响后续轮次对同一文件的修改。\n确定继续吗？",
      );
      if (!ok) return;
    }
    setRewinding(true);
    try {
      // targetFiles is ALWAYS passed — the event handler matches the card
      // by path-set and marks it `rewound: true` in place (the card stays
      // in the stream as a trace that this turn was rolled back), whether
      // this is the latest turn or a historical one. The only difference
      // is the confirm() above for historical cards.
      await rewindTurn(files, files.map((f) => f.filePath));
      setDone(true);
    } finally {
      setRewinding(false);
    }
  };

  // Group by kind for a compact summary line: "本轮修改了 N 个文件
  // (创建 X · 修改 Y)".
  const created = files.filter((f) => f.kind === "created").length;
  const modified = files.length - created;
  // Aggregate tallies across all files for the folded badge.
  const totals = useMemo(
    () => files.reduce((acc, f) => ({ adds: acc.adds + f.adds, dels: acc.dels + f.dels }), { adds: 0, dels: 0 }),
    [files],
  );

  return (
    <div className={cn("rounded-lg border border-edge bg-surface/60 shadow-sm text-xs text-content-muted", rewound && "opacity-60")}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover/50"
      >
        <IconFile size={14} className="shrink-0 text-content-subtle" />
        <span className="font-semibold text-content">
          本轮修改了 {files.length} 个文件
        </span>
        <span className="text-content-subtle">
          ({created > 0 ? `创建 ${created}` : ""}
          {created > 0 && modified > 0 ? " · " : ""}
          {modified > 0 ? `修改 ${modified}` : ""})
        </span>
        {/* Aggregate change tallies - the headline number reviewers care about. */}
        <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-surface-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
          <span className="text-accent">+{totals.adds}</span>
          <span className="text-danger">-{totals.dels}</span>
        </span>
        {/* "已撤销" badge once this turn's files have been rewound. The card
            stays (conversation record preserved), so the badge makes the
            rewound state legible at a glance. */}
        {rewound && (
          <span className="ml-2 rounded-md bg-surface-muted px-1.5 py-0.5 font-medium text-content-subtle">
            已撤销
          </span>
        )}
        <span className="ml-auto shrink-0 text-content-subtle">
          {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        </span>
      </button>
      {open && (
        <div className="space-y-1 border-t border-edge px-2 py-2">
          {files.map((f) => (
            <FileRow key={f.filePath} entry={f} />
          ))}
          {/* Every card is rewindable: the latest turn via the live snapshot,
              historical turns via their persisted entries (DB-driven, works
              even after session reopen). An already-rewound card shows no
              button. Historical rewinds are confirmed in handleRewind since
              they can clobber later turns' edits to the same files. */}
          {!rewound && (
            <div className="flex items-center justify-end pt-1">
              <button
                onClick={handleRewind}
                disabled={rewinding || done}
                className="rounded-md bg-surface-hover px-3 py-1 font-medium text-content transition-colors hover:bg-edge disabled:cursor-not-allowed disabled:text-content-subtle"
                title={isLatestTurn ? "把本轮所有文件恢复为轮开始前的状态" : "把该历史轮次的文件改动恢复为当时修改前的状态(可能影响后续轮次)"}
              >
                {done ? "已撤销 ✓" : rewinding ? "撤销中…" : "撤销本轮"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One row in the file list. The whole row is clickable: it opens this file's
 *  diff for review. WHERE it opens follows the Git setting "差异打开方式":
 *   - center (default): the center editor column, side-by-side diff using the
 *     card's frozen `before` vs the current on-disk content.
 *   - dialog: a floating multi-tab diff dialog (same one the Git panel uses),
 *     so several files can be reviewed side by side. `after` is left undefined
 *     so DiffPane reads the live working-tree file from disk.
 *
 *  An external-link glyph at the trailing edge signals the open affordance. */
function FileRow({ entry }: { entry: TurnFileEntry }) {
  const isCreated = entry.kind === "created";

  const handleOpen = async () => {
    const store = useSessionStore.getState();
    // Resolve the file's owning repo so the dialog's left sidebar can show
    // working-tree status. discoverRepos scans the active project; we pick the
    // repo whose root is a prefix of this file's absolute path. Falls back to
    // the project root when no repo matches (the sidebar then just reads empty).
    let repoPath = "";
    const pid = store.activeProjectId;
    const projectPath = pid ? store.projects.find((p) => p.id === pid)?.path : undefined;
    if (projectPath) {
      try {
        const { repos } = await api.git.discoverRepos({ projectPath });
        // Normalize separators for a cross-platform prefix match.
        const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
        const fp = norm(entry.filePath);
        const match = repos.find((r) => {
          const rp = norm(r.path);
          return fp === rp || fp.startsWith(rp + "/");
        });
        repoPath = match?.path ?? projectPath;
      } catch {
        repoPath = projectPath;
      }
    }

    if (store.gitDiffOpenMode === "dialog") {
      // Dialog open-mode: open (or refresh) a diff tab in the floating dialog.
      // `after` is omitted on purpose - DiffPane reads the live working-tree
      // file from disk, which is exactly the post-turn content we want to diff
      // against the frozen `before` snapshot.
      store.openGitDiffDialogTab({
        id: `${entry.filePath}::turn`,
        filePath: entry.filePath,
        before: entry.before,
        title: basename(entry.filePath),
        repoPath,
        source: "working",
      });
      return;
    }

    // Center open-mode: open in the editor column with a side-by-side diff.
    store.setRightPanelTab("files");
    store.openFileInIde(entry.filePath, { diff: true, before: entry.before });
  };

  return (
    <button
      type="button"
      onClick={handleOpen}
      className="flex w-full items-center gap-2 rounded-md bg-surface-muted/40 px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
      title="在编辑器中审查改动"
    >
      <span aria-hidden title={isCreated ? "本轮新建" : "本轮修改"} className="shrink-0 text-content-subtle">
        {isCreated ? <IconPlus size={12} /> : <IconEdit size={12} />}
      </span>
      <span className="min-w-0 truncate font-mono text-[11px] text-content" title={entry.filePath}>
        {entry.filePath}
      </span>
      {/* Per-file change tallies. */}
      <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
        {entry.adds > 0 && <span className="text-accent">+{entry.adds}</span>}
        {entry.dels > 0 && <span className="text-danger">-{entry.dels}</span>}
        {entry.adds === 0 && entry.dels === 0 && (
          <span className="text-content-subtle">无变化</span>
        )}
      </span>
      <IconExternalLink
        size={11}
        className={cn("ml-auto shrink-0 text-content-subtle")}
      />
    </button>
  );
}

