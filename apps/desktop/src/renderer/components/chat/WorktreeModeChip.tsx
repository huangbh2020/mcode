import { useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore, type EnvChoice } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useNarrowViewport } from "@renderer/hooks/useNarrowViewport.js";
import {
  IconGitFork,
  IconGitBranch,
  IconFolder,
  IconCheck,
  IconChevronDown,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * The composer's working-environment picker — a MINIMAL text trigger placed
 * at the top-left corner of the composer card (above the textarea), not a
 * chip in the bottom action row. Three short options: 本地 / 工作树·沙盒
 * (detached) / 工作树·分支 (generated mcode/* branch).
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
  const popupRef = useRef<HTMLDivElement>(null);
  useSuppressBrowserView(open, popupRef);

  const envChoice = useSessionStore((s) => s.envChoice);
  const setEnvChoice = useSessionStore((s) => s.setEnvChoice);
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
  const value: EnvChoice = session
    ? session.envMode === "worktree"
      ? session.wtStyle === "branch"
        ? "wt-branch"
        : "wt-detached"
      : "local"
    : envChoice;

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

  const on = value !== "local";
  const triggerLabel =
    value === "local"
      ? t("chat.worktree.local")
      : value === "wt-branch"
        ? t("chat.worktree.pendingBranch")
        : t("chat.worktree.pendingDetached");

  const options = useMemo(
    () =>
      [
        {
          value: "local" as const,
          label: t("chat.worktree.local"),
          hint: t("chat.worktree.hintLocal"),
        },
        {
          value: "wt-detached" as const,
          label: t("chat.worktree.optionWtDetached"),
          hint: t("chat.worktree.hintWtDetached"),
        },
        {
          value: "wt-branch" as const,
          label: t("chat.worktree.optionWtBranch"),
          hint: t("chat.worktree.hintWtBranch"),
        },
      ] satisfies Array<{ value: EnvChoice; label: string; hint: string }>,
    [t],
  );

  // Visibility: the environment choice belongs to the NEW-SESSION stage
  // only. A session already in conversation hides the picker (same freshness
  // rule the backend's fresh-row reuse uses) — and a MATERIALIZED session
  // hides it too, fresh or not: its isolation is already communicated by the
  // left-bar fork badge/group and the Titlebar Land button, so a permanent
  // badge above the composer is noise, not information.
  // Freshness requires the ROW to exist. A missing row with a non-null
  // sessionId is a side chat (side sessions live outside the main list
  // buckets the selector scans) — NOT a new session: rendering the picker
  // there would show environment options the side session can never use,
  // and a pick would silently edit the GLOBAL new-session default instead
  // of any session. Same rule SessionDirectoryChip applies.
  const isFreshSession = session != null && session.title === "New session";
  const showPicker = isFreshSession && !materialized;

  // No repo (or still probing) / not a new-session context → render nothing.
  // AFTER all hooks.
  if (!hasRepo || !showPicker) return null;

  return (
    <span className={cn("inline-flex items-center", stacked && "w-full")}>
      <Menu.Root open={open} onOpenChange={setOpen}>
        <Menu.Trigger
          className={cn(
            // Clickable WITHOUT a hard border: chevron + icon + hover states
            // carry the affordance so the quiet row above the composer stays
            // visually light.
            "inline-flex select-none items-center gap-1.5 rounded-md px-2 py-1 text-xs outline-none transition-colors duration-100",
            "hover:bg-surface-hover",
            on
              ? "text-accent hover:bg-accent/10"
              : "text-content-muted hover:text-content",
          )}
          title={
            value === "local"
              ? t("chat.worktree.chipTitleLocal")
              : value === "wt-branch"
                ? t("chat.worktree.chipTitlePendingBranch")
                : t("chat.worktree.chipTitlePendingDetached")
          }
        >
          <span className="shrink-0 opacity-90">
            {value === "local" ? (
              <IconFolder size={12} />
            ) : value === "wt-branch" ? (
              <IconGitBranch size={12} />
            ) : (
              <IconGitFork size={12} />
            )}
          </span>
          <span className="truncate">{triggerLabel}</span>
          <IconChevronDown size={12} className="shrink-0 opacity-60" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            side={cascade ? "right" : "top"}
            align="start"
            sideOffset={cascade ? 6 : 4}
          >
            <Menu.Popup
              ref={popupRef}
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
                    onClick={() => setEnvChoice(opt.value)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                      "data-[highlighted]:bg-surface-muted",
                      active ? "text-accent" : "text-content-muted",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 opacity-90">
                        {opt.value === "local" ? (
                          <IconFolder size={11} />
                        ) : opt.value === "wt-branch" ? (
                          <IconGitBranch size={11} />
                        ) : (
                          <IconGitFork size={11} />
                        )}
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
