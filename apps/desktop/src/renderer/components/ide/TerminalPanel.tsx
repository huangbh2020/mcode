import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import {
  IconPlus,
  IconX,
  IconTerminal2,
  IconRefresh,
  IconPlayerStop,
  IconEraser,
} from "@renderer/lib/icons.js";
import {
  TerminalView,
  type TerminalSessionStatus,
  type TerminalViewHandle,
} from "./TerminalView.js";
import { TerminalCommandsMenu } from "./TerminalCommandsMenu.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** One UI terminal tab. `key` is stable; the underlying PTY id lives in the view.
 *  The tab title is derived at render time from `seq` ("终端 {n}") so it
 *  follows the UI locale instead of being frozen at creation. */
interface TermSession {
  key: string;
  /** Ordinal shown in the tab title. */
  seq: number;
  status: TerminalSessionStatus;
  detail?: string;
}

/** Stable empty array for the no-project read-only view (avoids a fresh `[]`
 *  each render that would churn downstream selectors). */
const EMPTY_SESSIONS: TermSession[] = [];

let nextSeq = 1;
function makeSession(): TermSession {
  const n = nextSeq++;
  return { key: `term-${n}-${Date.now().toString(36)}`, seq: n, status: "starting" };
}

/** Per-project terminal state. `sessions` are the open tabs; `activeKey` is the
 *  visible one. Kept out of React state on purpose - see `termsRef` below. */
interface ProjectTermState {
  sessions: TermSession[];
  activeKey: string | null;
}

/**
 * Bottom-bar Terminal panel body.
 *
 * - Scoped to the active project's path (cwd = project root).
 * - Supports multiple local sessions (tabs) per project; each mounts a
 *   TerminalView.
 * - Parent BottomTerminalBar keep-alives this component (collapses to height 0
 *   instead of unmounting) so PTYs and scrollback survive the bar toggling.
 * - Cross-project keep-alive: every project that has ever opened a terminal
 *   keeps its TerminalViews mounted while the user switches projects. Only the
 *   current project's active tab is visible; the rest are CSS-hidden with
 *   active=false. Switching back to a project restores its tabs, active tab and
 *   running PTYs exactly as they were. Terminals are torn down only when a
 *   project is deleted/archived (see the projects effect below).
 */
export function TerminalPanel({ active }: { active: boolean }) {
  const { t } = useI18n();
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);

  const projectPath = useMemo(() => {
    if (!activeProjectId) return null;
    return projects.find((p) => p.id === activeProjectId)?.path ?? null;
  }, [activeProjectId, projects]);

  // Terminal state is keyed by project path and kept in refs (NOT React state).
  // The reason: when the user switches projects we must NOT unmount the other
  // projects' TerminalViews - unmounting kills the PTY (cleanup calls
  // api.terminal.kill) and destroys scrollback. Instead every project's
  // TerminalViews stay mounted; only the visible one (current project + active
  // tab) is shown, the rest are hidden via CSS. refs are the single source of
  // truth and `forceRender` re-renders after a mutation so the UI reflects it.
  const termsRef = useRef<Map<string, ProjectTermState>>(new Map()); // projectPath -> state
  const handlesRef = useRef<Map<string, TerminalViewHandle>>(new Map()); // sessionKey -> handle (sessionKey is globally unique)
  const keyToPathRef = useRef<Map<string, string>>(new Map()); // sessionKey -> projectPath (routes status callbacks back to the right bucket)
  // Per-session commands waiting to be typed into the PTY once it reaches
  // "running" (the new PTY is spawned async by TerminalView, so we can't write
  // immediately). Keyed by sessionKey so concurrent "run in new terminal"
  // invocations across multiple tabs never overwrite each other (matches the
  // per-session bucketing convention documented in AGENTS.md).
  const pendingCommandBySession = useRef<Map<string, string>>(new Map());
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  // Read-only view of the CURRENT project's state (empty when no project).
  const current = projectPath ? termsRef.current.get(projectPath) : undefined;
  const sessions = current?.sessions ?? EMPTY_SESSIONS;
  const activeKey = current?.activeKey ?? null;

  // Ensure the current project has a terminal bucket: create the first session
  // on first visit, but leave existing buckets untouched so switching back to a
  // project restores its tabs + active tab + live PTYs.
  useEffect(() => {
    if (!projectPath) return; // no project -> empty state; don't touch the map
    if (termsRef.current.has(projectPath)) return; // already has terminals -> restore as-is
    const first = makeSession();
    termsRef.current.set(projectPath, { sessions: [first], activeKey: first.key });
    keyToPathRef.current.set(first.key, projectPath);
    forceRender();
  }, [projectPath]);

  // Clean up terminals for projects that no longer exist (deleted/archived out).
  // The store has already switched activeProjectId away by the time this runs,
  // so dropping the bucket is safe. Unmounting the TerminalViews re-kills the
  // PTYs (cleanup), which is harmless.
  useEffect(() => {
    const livePaths = new Set(projects.map((p) => p.path));
    let changed = false;
    for (const [p, st] of termsRef.current) {
      if (livePaths.has(p)) continue;
      for (const s of st.sessions) {
        handlesRef.current.get(s.key)?.kill();
        handlesRef.current.delete(s.key);
        keyToPathRef.current.delete(s.key);
      }
      termsRef.current.delete(p);
      changed = true;
    }
    if (changed) forceRender();
  }, [projects]);

  const addSession = useCallback(() => {
    if (!projectPath) return;
    const s = makeSession();
    const st = termsRef.current.get(projectPath);
    if (st) {
      st.sessions = [...st.sessions, s];
      st.activeKey = s.key;
    } else {
      termsRef.current.set(projectPath, { sessions: [s], activeKey: s.key });
    }
    keyToPathRef.current.set(s.key, projectPath);
    forceRender();
  }, [projectPath]);

  const closeSession = useCallback(
    (key: string) => {
      const path = keyToPathRef.current.get(key);
      // Kill + deregister the handle regardless of whether we find its bucket.
      handlesRef.current.get(key)?.kill();
      handlesRef.current.delete(key);
      keyToPathRef.current.delete(key);

      if (!path) {
        forceRender();
        return;
      }
      const st = termsRef.current.get(path);
      if (st) {
        const next = st.sessions.filter((s) => s.key !== key);
        if (next.length === 0 && path === projectPath) {
          // Closing the last tab of the current project spawns a fresh terminal
          // so the current project is never left empty.
          const fresh = makeSession();
          keyToPathRef.current.set(fresh.key, path);
          termsRef.current.set(path, { sessions: [fresh], activeKey: fresh.key });
        } else if (next.length === 0) {
          // Last tab of a non-current project - drop the bucket entirely.
          termsRef.current.delete(path);
        } else {
          st.sessions = next;
          if (st.activeKey === key) {
            st.activeKey = next[next.length - 1]?.key ?? null;
          }
        }
      }
      forceRender();
    },
    [projectPath],
  );

  const updateStatus = useCallback(
    (key: string, status: TerminalSessionStatus, detail?: string) => {
      const path = keyToPathRef.current.get(key);
      if (!path) return;
      const st = termsRef.current.get(path);
      if (!st) return;
      st.sessions = st.sessions.map((s) =>
        s.key === key ? { ...s, status, detail } : s,
      );
      // Only re-render if the changed tab belongs to the visible project - a
      // hidden project's status dot isn't on screen, so a render would be
      // wasted work.
      if (path === projectPath) forceRender();
    },
    [projectPath],
  );

  // NOTE: all hooks must be declared before any early return (Rules of Hooks).
  // activeSession/activeHandle resolve to null/undefined when there is no
  // project, which is harmless - the runCommand body and the toolbar buttons
  // all guard on activeHandle themselves.
  const activeSession = sessions.find((s) => s.key === activeKey) ?? sessions[0] ?? null;
  const activeHandle = activeSession ? handlesRef.current.get(activeSession.key) : undefined;

  // Run a saved quick-command: write the command to the active PTY so the
  // shell executes it immediately. Silently no-ops when no terminal is running
  // (no session yet, or the shell has exited) - matches the kill button's guard.
  //
  // Line endings: shell line editors (PowerShell PSReadLine, cmd cooked mode,
  // readline) commit the current line on a carriage return ("\r"), NOT on a
  // line feed ("\n"). xterm sends Enter as "\r" for normal typing, so we mirror
  // that. A bare "\n" is not a submit signal - feeding a multi-line command
  // like "cd ./dir\nnpm run dev\r" (only the final "\r") confuses the line
  // editor: it treats the whole block as one unsubmitted line, scrambles its
  // buffer, and ends up executing the lines OUT OF ORDER (repro: on PowerShell
  // the second line ran before the first). Normalizing every newline to "\r"
  // makes each line its own submit, preserving the user's intended order. Safe
  // for single-line commands too (no newlines -> unchanged).
  const runCommand = useCallback(
    (command: string) => {
      const id = activeHandle?.getTerminalId();
      if (id && activeHandle?.getStatus() === "running") {
        void api.terminal.write({ terminalId: id, data: `${command.replace(/\r\n|\n|\r/g, "\r")}\r` });
      }
    },
    [activeHandle],
  );

  // Open a NEW terminal tab, switch to it, and run the command there once its
  // PTY is ready. The actual write is deferred until the new TerminalView
  // reports status "running" (PTY spawn is async) — see the onStatusChange
  // handler in the render list below. This keeps the user's current terminal
  // untouched (e.g. a long-running dev server) while still showing the command
  // output immediately in a fresh tab.
  const runCommandInNewTerminal = useCallback(
    (command: string) => {
      if (!projectPath) return;
      const s = makeSession();
      const st = termsRef.current.get(projectPath);
      if (st) {
        st.sessions = [...st.sessions, s];
        st.activeKey = s.key;
      } else {
        termsRef.current.set(projectPath, { sessions: [s], activeKey: s.key });
      }
      keyToPathRef.current.set(s.key, projectPath);
      pendingCommandBySession.current.set(s.key, command);
      forceRender();
    },
    [projectPath],
  );

  if (!projectPath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface text-content-subtle">
          <IconTerminal2 size={20} />
        </div>
        <p className="text-xs font-medium text-content-muted">{t("ide.files.noProjectTitle")}</p>
        <p className="text-[11px] leading-relaxed text-content-subtle">
          {t("ide.term.noProjectDesc")}
        </p>
      </div>
    );
  }

  // Flatten every project's terminals into a single render list. All of them
  // stay mounted (cross-project keep-alive); visibility is decided per-entry
  // below. Computed from the ref source-of-truth each render.
  const allTermEntries: Array<{ s: TermSession; path: string }> = [];
  for (const [p, st] of termsRef.current) {
    for (const s of st.sessions) allTermEntries.push({ s, path: p });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Session tab strip + actions */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-edge px-1">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-0.5">
          {sessions.map((s) => {
            const isActive = s.key === activeKey;
            // Derive the tab title at render so it re-localizes on locale switch.
            const sessionTitle = t("ide.term.tabTitle", { n: s.seq });
            return (
              <div
                key={s.key}
                className={cn(
                  "group flex max-w-[9rem] shrink-0 items-center gap-0.5 rounded-full px-2 py-1 text-[11px] transition-colors",
                  isActive
                    ? "bg-accent/15 text-accent"
                    : "text-content-subtle hover:bg-surface-muted/50 hover:text-content-muted",
                )}
              >
                <button
                  type="button"
                  className="min-w-0 truncate"
                  onClick={() => {
                    if (!projectPath) return;
                    const st = termsRef.current.get(projectPath);
                    if (st && st.activeKey !== s.key) {
                      st.activeKey = s.key;
                      forceRender();
                    }
                  }}
                  title={s.detail ? `${sessionTitle} - ${s.detail}` : sessionTitle}
                >
                  <span
                    className={cn(
                      "mr-1 inline-block h-1.5 w-1.5 rounded-full",
                      s.status === "running" && "bg-accent",
                      s.status === "starting" && "bg-warning",
                      s.status === "exited" && "bg-content-subtle",
                      s.status === "error" && "bg-danger",
                    )}
                  />
                  {sessionTitle}
                </button>
                <button
                  type="button"
                  className={cn(
                    "rounded p-0.5 transition-colors text-content-subtle hover:bg-surface-hover hover:text-content",
                    !isActive && "opacity-0 group-hover:opacity-100",
                  )}
                  title={t("ide.term.closeTerminal")}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(s.key);
                  }}
                >
                  <IconX size={11} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
            title={t("ide.term.newTerminal")}
            onClick={addSession}
          >
            <IconPlus size={13} />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 border-l border-edge pl-1">
          <TerminalCommandsMenu onRun={runCommand} onRunInNewTerminal={runCommandInNewTerminal} />
          <IconBtn
            title={t("ide.term.clearScreen")}
            onClick={() => activeHandle?.clear()}
            disabled={!activeHandle}
          >
            <IconEraser size={13} />
          </IconBtn>
          <IconBtn
            title={t("ide.term.killProcess")}
            onClick={() => activeHandle?.kill()}
            disabled={!activeHandle || activeSession?.status !== "running"}
          >
            <IconPlayerStop size={13} />
          </IconBtn>
          <IconBtn
            title={t("ide.term.restart")}
            onClick={() => {
              // Clear scrollback then spawn a fresh PTY into the same view.
              activeHandle?.clear();
              activeHandle?.restart();
            }}
            disabled={!activeHandle}
          >
            <IconRefresh size={13} />
          </IconBtn>
        </div>
      </div>

      {/* Status line for exited/error */}
      {activeSession &&
        (activeSession.status === "exited" || activeSession.status === "error") && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-edge bg-surface px-2 py-1 text-[11px] text-content-muted">
            <span className="truncate">
              {activeSession.detail ??
                (activeSession.status === "error" ? t("ide.term.startFailed") : t("ide.term.exited"))}
            </span>
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-accent hover:bg-surface-hover"
              onClick={() => activeHandle?.restart()}
            >
              {t("ide.term.restart")}
            </button>
          </div>
        )}

      {/* Terminal hosts — keep ALL terminals across ALL projects mounted so
          PTYs + scrollback survive both intra-project tab switches and
          inter-project switches. Only the current project's active tab is
          visible; everything else is hidden via CSS (invisible) and its
          TerminalView is fed active=false so it skips fit/focus. */}
      <div className="relative min-h-0 flex-1 bg-surface">
        {allTermEntries.map(({ s, path: p }) => {
          const st = termsRef.current.get(p);
          const isActive = p === projectPath && s.key === st?.activeKey;
          return (
            <div
              key={s.key}
              className={cn(
                "absolute inset-0",
                isActive ? "z-10" : "pointer-events-none invisible z-0",
              )}
              aria-hidden={!isActive}
            >
              <TerminalView
                sessionKey={s.key}
                projectPath={p}
                active={active && isActive}
                onStatusChange={(status, detail) => {
                  updateStatus(s.key, status, detail);
                  // Drain any command queued by runCommandInNewTerminal once the
                  // freshly spawned PTY is ready. Same newline normalization as
                  // runCommand (shell commits on "\r", not "\n").
                  if (status === "running") {
                    const cmd = pendingCommandBySession.current.get(s.key);
                    if (cmd) {
                      pendingCommandBySession.current.delete(s.key);
                      const id = handlesRef.current.get(s.key)?.getTerminalId();
                      if (id) {
                        void api.terminal.write({
                          terminalId: id,
                          data: `${cmd.replace(/\r\n|\n|\r/g, "\r")}\r`,
                        });
                      }
                    }
                  }
                }}
                onReady={(handle) => {
                  handlesRef.current.set(s.key, handle);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}
