import { useEffect, useMemo, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useNarrowViewport } from "@renderer/hooks/useNarrowViewport.js";
import {
  IconGitFork,
  IconFolder,
  IconCheck,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * The composer's working-environment picker — a MINIMAL text trigger placed
 * at the top-left corner of the composer card (above the textarea), not a
 * chip in the bottom action row. Two short options: 本地 / 工作树.
 *
 * Availability: the PROJECT ROOT itself must be a git repo (`discoverRepos`
 * with `rootOnly`, one level — worktree materialization requires `.git` at
 * the root, so a repo nested in a subdirectory doesn't qualify). Probed per
 * active project and cached until the project changes.
 *
 * Value/choice semantics match the store: the picker shows the pane
 * session's effective environment (or the persisted new-session default
 * when no session exists); a choice edits an un-materialized foreground
 * session directly, else the default.
 *
 * Materialized sessions render NOTHING here — the thread's isolation is
 * communicated by the left-bar fork badge/group and the Titlebar Land
 * button; the composer area stays quiet once the conversation has started.
 */
export function WorktreeModeChip({
  sessionId,
  layout = "chip",
}: {
  sessionId: string | null;
  layout?: "chip" | "row";
}) {
  const { t } = useI18n();
  const stacked = layout === "row";
  const cascade = stacked && !useNarrowViewport();
  const [open, setOpen] = useState(false);
  useSuppressBrowserView(open);

  const worktreeMode = useSessionStore((s) => s.worktreeMode);
  const setWorktreeMode = useSessionStore((s) => s.setWorktreeMode);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  // This pane's session row (reference-stable selector).
  const session = useSessionStore((s) => {
    if (!sessionId) return undefined;
    if (s.activeSessionId === sessionId) {
      return s.sessions.find((x) => x.id === sessionId);
    }
    for (const list of Object.values(s.sessionsByProject)) {
      const hit = list?.find((x) => x.id === sessionId);
      if (hit) return hit;
    }
    return undefined;
  });

  const materialized = !!session?.worktreePath;
  const value: "local" | "worktree" = session
    ? session.envMode === "worktree"
      ? "worktree"
      : "local"
    : worktreeMode
      ? "worktree"
      : "local";

  // Git-repo availability probe for the active project — one level only
  // (`rootOnly`): the worktree can only materialize at the project root, so
  // a repo in a subdirectory must NOT light the picker up. Re-probed when
  // the project changes; failures read as "no repo" (picker hidden).
  const [hasRepo, setHasRepo] = useState<boolean | null>(null);
  useEffect(() => {
    setHasRepo(null);
    const projectPath = projects.find((p) => p.id === activeProjectId)?.path;
    if (!projectPath) return;
    let cancelled = false;
    api.git
      .discoverRepos({ projectPath, rootOnly: true })
      .then(({ repos }) => {
        if (!cancelled) setHasRepo(repos.length > 0);
      })
      .catch(() => {
        if (!cancelled) setHasRepo(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, projects]);

  // NOTE: every hook stays ABOVE the early return — a conditional return
  // before any hook would change the hook count between renders (probe
  // flips null → boolean, project switch re-probes) and crash React with
  // "Rendered more hooks than during the previous render".

  const on = value === "worktree";
  const triggerLabel = on ? t("chat.worktree.pending") : t("chat.worktree.local");

  const options = useMemo(
    () => [
      {
        value: "local" as const,
        label: t("chat.worktree.local"),
        hint: t("chat.worktree.hintLocal"),
      },
      {
        value: "worktree" as const,
        label: t("chat.worktree.optionWorktree"),
        hint: t("chat.worktree.hintWorktree"),
      },
    ],
    [t],
  );

  // Visibility: the environment choice belongs to the NEW-SESSION stage
  // only. A session already in conversation hides the picker (same freshness
  // rule the backend's fresh-row reuse uses) — and a MATERIALIZED session
  // hides it too, fresh or not: its isolation is already communicated by the
  // left-bar fork badge/group and the Titlebar Land button, so a permanent
  // badge above the composer is noise, not information.
  const isFreshSession = !session || session.title === "New session";
  const showPicker = isFreshSession && !materialized;

  // No repo (or still probing) / not a new-session context → render nothing.
  // AFTER all hooks.
  if (!hasRepo || !showPicker) return null;

  return (
    <span className={cn("inline-flex items-center", stacked && "w-full")}>
      <Menu.Root open={open} onOpenChange={setOpen}>
        <Menu.Trigger
          className={cn(
            "inline-flex select-none items-center gap-1 rounded px-1 py-0.5 text-[11px] outline-none transition-colors duration-100",
            "hover:bg-surface-muted",
            on ? "text-accent" : "text-content-subtle hover:text-content-muted",
          )}
          title={
            on
              ? t("chat.worktree.chipTitlePending")
              : t("chat.worktree.chipTitleLocal")
          }
        >
          <span className="shrink-0 opacity-90">{on ? <IconGitFork size={11} /> : <IconFolder size={11} />}</span>
          <span className="truncate">{triggerLabel}</span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            side={cascade ? "right" : "top"}
            align="start"
            sideOffset={cascade ? 6 : 4}
          >
            <Menu.Popup
              className={cn(
                "z-50 min-w-[240px] rounded-lg border border-edge bg-surface py-1 shadow-2xl",
                cascade ? "origin-top-left" : "origin-bottom-left",
                "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                "transition-[transform,opacity] duration-100",
              )}
            >
              {options.map((opt) => {
                const active = opt.value === value;
                return (
                  <Menu.Item
                    key={opt.value}
                    onClick={() => setWorktreeMode(opt.value === "worktree")}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                      "data-[highlighted]:bg-surface-muted",
                      active ? "text-accent" : "text-content-muted",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 opacity-90">
                        {opt.value === "worktree" ? <IconGitFork size={11} /> : <IconFolder size={11} />}
                      </span>
                      <span className="font-medium">{opt.label}</span>
                      <span className="truncate text-xs text-content-subtle">{opt.hint}</span>
                    </span>
                    {active && <IconCheck size={14} className="shrink-0" />}
                  </Menu.Item>
                );
              })}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </span>
  );
}
