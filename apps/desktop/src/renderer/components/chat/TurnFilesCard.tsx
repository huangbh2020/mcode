import { useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { basename } from "@renderer/lib/path.js";
import { api } from "@renderer/lib/api.js";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { isElectron } from "@renderer/lib/platform.js";
import { ConfirmDialog } from "@renderer/components/ui/index.js";
import {
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconFile,
  IconFocus,
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
  const { t } = useI18n();
  // Local rewind-in-flight flag so the button is disabled while the
  // IPC call is in progress (main also clears the card on its
  // `turn.rewound` event, but that takes a tick after the IPC resolves).
  const [rewinding, setRewinding] = useState(false);
  // Toggle to "撤销成功" briefly after success, so the user gets
  // confirmation before the card disappears (latest-turn) or flips to
  // the 已撤销 state (historical).
  const [done, setDone] = useState(false);
  // Controls the in-app confirmation dialog. Replaces native confirm() —
  // every rewind (latest or historical) now goes through this gate so the
  // action is never a single mis-click.
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleRewind = async () => {
    if (rewinding || rewound) return;
    setRewinding(true);
    try {
      // targetFiles is ALWAYS passed — the event handler matches the card
      // by path-set and marks it `rewound: true` in place (the card stays
      // in the stream as a trace that this turn was rolled back), whether
      // this is the latest turn or a historical one. Confirmation is now
      // handled by the ConfirmDialog before this runs.
      await rewindTurn(files, files.map((f) => f.filePath));
      setDone(true);
      // Auto-collapse once rewound — the file list is now a stale snapshot
      // of rolled-back changes, so fold the card to keep the scroll-back
      // history calm. The card itself stays in the stream with the 已撤销
      // badge (conversation record preserved).
      setOpen(false);
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
    <div className={cn("mb-[5px] rounded-lg border border-edge bg-surface-muted/60 shadow-sm text-xs text-content-muted", rewound && "opacity-60")}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover/50"
      >
        <IconFile size={14} className="shrink-0 text-content-subtle" />
        <span className="whitespace-nowrap font-semibold text-content">
          <span className="tfc-long">{t("chatStream.turnFiles.titleLong", { n: files.length })}</span>
          <span className="tfc-short">{t("chatStream.turnFiles.titleShort", { n: files.length })}</span>
        </span>
        <span className="tfc-sub text-content-subtle">
          ({created > 0 ? t("chatStream.turnFiles.created", { n: created }) : ""}
          {created > 0 && modified > 0 ? " · " : ""}
          {modified > 0 ? t("chatStream.turnFiles.modified", { n: modified }) : ""})
        </span>
        {/* Aggregate change tallies - the headline number reviewers care about. */}
        <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-surface-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
          <span className="text-success">+{totals.adds}</span>
          <span className="text-danger">-{totals.dels}</span>
        </span>
        {/* Right-aligned affordances: the rewind button sits to the right of
            the title, the expand chevron at the far edge. The rewind button
            stops propagation so clicking it opens the confirm dialog instead
            of toggling the card. An already-rewound card swaps the button for
            a danger-tinted 已撤销 badge so the rolled-back state reads
            clearly at a glance. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {!rewound ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmOpen(true);
              }}
              onKeyDown={(e) => e.stopPropagation()}
              disabled={rewinding || done}
              className="rounded-md bg-surface-hover px-3 py-1 font-medium text-content transition-colors hover:bg-edge disabled:cursor-not-allowed disabled:text-content-subtle"
              title={isLatestTurn ? t("chatStream.turnFiles.rewindLatestTitle") : t("chatStream.turnFiles.rewindHistoryTitle")}
            >
              {done ? t("chatStream.turnFiles.rewoundCheck") : rewinding ? t("chatStream.turnFiles.rewinding") : (
                <>
                  <span className="tfc-long">{t("chatStream.turnFiles.rewindLong")}</span>
                  <span className="tfc-short">{t("chatStream.turnFiles.rewindShort")}</span>
                </>
              )}
            </button>
          ) : (
            <span className="rounded-md bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">
              {t("chatStream.turnFiles.rewoundBadge")}
            </span>
          )}
          <span className="text-content-subtle">
            {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          </span>
        </div>
      </div>
      {open && (
        <div className="space-y-1 border-t border-edge px-2 py-2">
          {files.map((f) => (
            <FileRow key={f.filePath} entry={f} />
          ))}
        </div>
      )}
      {/* In-app confirmation for rewind - replaces native confirm(). Every
          rewind (latest or historical) goes through this gate so the action
          is never a single mis-click. Historical rewinds use the danger
          variant since they can clobber later turns' edits to the same
          files. */}
      <ConfirmDialog
        open={confirmOpen}
        title={t("chatStream.turnFiles.confirmTitle")}
        danger={!isLatestTurn}
        description={
          isLatestTurn
            ? t("chatStream.turnFiles.confirmDescLatest")
            : (
              <>
                {t("chatStream.turnFiles.confirmDescHistory1")}
                <br />
                {t("chatStream.turnFiles.confirmDescHistory2")}
              </>
            )
        }
        confirmText={t("chatStream.turnFiles.rewindShort")}
        onOpenChange={setConfirmOpen}
        onConfirm={() => void handleRewind()}
      />
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
 *  The row is a div[role=button] (not a native button) because it CONTAINS a
 *  real button: the trailing locate icon reveals this file in the right
 *  panel's file tree (desktop only - nested buttons are invalid HTML).
 *  An external-link glyph before it signals the row-click diff affordance. */
function FileRow({ entry }: { entry: TurnFileEntry }) {
  const { t } = useI18n();
  const isCreated = entry.kind === "created";

  const handleOpen = async () => {
    const store = useSessionStore.getState();
    // The mobile shell has no editor column / diff dialog — open the turn
    // diff in the fullscreen mobile viewer instead (frozen `before` vs the
    // current on-disk content, rendered by the shared DiffView).
    if (!isElectron) {
      store.openMobileViewer({
        kind: "diff",
        name: basename(entry.filePath),
        path: entry.filePath,
        before: entry.before,
      });
      return;
    }
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
    <div
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void handleOpen();
        }
      }}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md bg-surface-muted/40 px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
      title={t("chatStream.turnFiles.reviewDiff")}
    >
      <span aria-hidden title={isCreated ? t("chatStream.turnFiles.createdThisTurn") : t("chatStream.turnFiles.modifiedThisTurn")} className="shrink-0 text-content-subtle">
        {isCreated ? <IconPlus size={12} /> : <IconEdit size={12} />}
      </span>
      <span className="min-w-0 truncate font-mono text-[11px] text-content" title={entry.filePath}>
        {entry.filePath}
      </span>
      {/* Per-file change tallies. */}
      <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
        {entry.adds > 0 && <span className="text-success">+{entry.adds}</span>}
        {entry.dels > 0 && <span className="text-danger">-{entry.dels}</span>}
        {entry.adds === 0 && entry.dels === 0 && (
          <span className="text-content-subtle">{t("chatStream.turnFiles.noChanges")}</span>
        )}
      </span>
      <IconExternalLink
        size={11}
        className={cn("ml-auto shrink-0 text-content-subtle")}
      />
      {/* Locate this file in the right panel's file tree (expand ancestors +
          scroll to it). stopPropagation so the row's diff-open doesn't fire.
          Desktop only — the mobile shell has no file tree. */}
      {isElectron && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            useSessionStore.getState().revealInFileTree(entry.filePath);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className="shrink-0 rounded p-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
          title={t("chatStream.turnFiles.locateTitle")}
          aria-label={t("chatStream.turnFiles.locateTitle")}
        >
          <IconFocus size={12} className="block" />
        </button>
      )}
    </div>
  );
}

