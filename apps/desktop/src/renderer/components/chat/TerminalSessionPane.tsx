/**
 * Terminal session surface — a session-kind=“terminal” tab that renders a
 * live PTY running the USER'S OWN Claude CLI in interactive TTY mode.
 *
 * Division of labor vs ChatPane: the terminal session has no message stream,
 * no approval bridge, no Mcode value-adds — the CLI's own TUI owns all of
 * that. This pane only:
 *  - spawns the shell with an init command that launches claude
 *    (`--session-id <uuid>` on first open, `--resume <uuid>` after a
 *    restart — the uuid is pre-generated into the session row at creation);
 *  - restores the previous scrollback (serialized xterm snapshot persisted
 *    via terminal.saveHistory) so a restart shows what the user left;
 *  - snapshots the buffer every few seconds while mounted (keep-alive means
 *    this pane stays alive in background tabs too);
 *  - surfaces the CLI probe (version badge / not-installed hint).
 *
 * The restored text is frozen history above the new prompt; the CLI resumes
 * its conversation from its OWN ~/.claude transcript, so content and context
 * both survive restarts (in-flight processes do not — a PTY cannot).
 */
import { useEffect, useRef, useState } from "react";
import { TerminalView, type TerminalSessionStatus, type TerminalViewHandle } from "@renderer/components/ide/TerminalView.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { buildTerminalInitCommand } from "@renderer/lib/terminalCli.js";

/** Snapshot cadence. Losing at most one interval of trailing output on an
 *  abrupt close is the accepted trade (a real terminal loses everything). */
const SNAPSHOT_INTERVAL_MS = 3_000;

/** Minimal session lookup: kind is terminal by construction (App routes
 *  here), we only need the project root + the pre-generated CLI uuid. */
function useTerminalSession(sessionId: string) {
  return useSessionStore((s) => {
    for (const list of Object.values(s.sessionsByProject)) {
      const hit = list?.find((x) => x.id === sessionId);
      if (hit) return hit;
    }
    const pinned = s.pinnedSessions.find((x) => x.id === sessionId);
    if (pinned) return pinned;
    return s.streamSessions.find((x) => x.id === sessionId);
  });
}

export function TerminalSessionPane({
  sessionId,
  isActive,
}: {
  sessionId: string;
  isActive: boolean;
}) {
  const { t } = useI18n();
  const session = useTerminalSession(sessionId);
  const setTerminalBusy = useSessionStore((s) => s.setTerminalBusy);
  const projectPath = useSessionStore((s) => {
    if (!session) return null;
    return s.projects.find((p) => p.id === session.projectId)?.path ?? null;
  });
  const [boot, setBoot] = useState<{
    initialContent?: string;
    initCommand?: string;
    /** Capture geometry of the snapshot — replayed size-faithfully. */
    cols?: number;
    rows?: number;
  } | null>(null);
  const handleRef = useRef<TerminalViewHandle | null>(null);
  const lastSnapshotRef = useRef("");
  const titleTriedRef = useRef(false);
  const bootedAtRef = useRef(0);
  // Locale-fresh translator for callbacks bound once.
  const tRef = useRef(t);
  tRef.current = t;

  // Unmount clears the busy flag even when the pty dies silently with
  // the pane (tab closed / single-mode switch kills it without an exit
  // callback reaching handleStatusChange).
  useEffect(() => {
    return () => setTerminalBusy(sessionId, false);
  }, [sessionId, setTerminalBusy]);

  // One-time boot decision: load the last snapshot (restart detection) and
  // derive the init command from the pre-generated CLI session uuid. Runs
  // once per mount; claudeSessionId is immutable after creation.
  useEffect(() => {
    let alive = true;
    setBoot(null);
    void (async () => {
      let initialContent: string | undefined;
      let cols: number | undefined;
      let rows: number | undefined;
      let adoptedCliId: string | null | undefined;
      try {
        const res = await api.terminal.loadHistory({ sessionId });
        if (res.content) {
          initialContent = res.content;
          cols = res.cols;
          rows = res.rows;
        }
        if (res.claudeSessionId) {
          adoptedCliId = res.claudeSessionId;
        }
      } catch {
        /* first open or persistence disabled */
      }
      const cliId = adoptedCliId ?? session?.claudeSessionId;
      const initCommand = buildTerminalInitCommand(
        session?.providerId ?? "claude-sdk",
        cliId,
        !!initialContent,
      );
      if (!alive) return;
      setBoot({ initialContent, initCommand: initCommand ?? undefined, cols, rows });
      bootedAtRef.current = Date.now();
    })();
    return () => {
      alive = false;
    };
    // session?.claudeSessionId is read once by design — see the doc comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Snapshot loop — only while a PTY has produced output (status starting =
  // nothing to save). Skips identical snapshots (spinner frames settle).
  // The same tick drives the auto-name probe: once the buffer has enough
  // content and the pty has settled (≥15s), ask main to titleGen the
  // session (main gates on default-title/settings; done=true stops asking).
  useEffect(() => {
    const timer = window.setInterval(() => {
      const h = handleRef.current;
      if (!h || h.getStatus() === "starting") return;
      const snap = h.serialize();
      if (snap && snap !== lastSnapshotRef.current) {
        lastSnapshotRef.current = snap;
        void api.terminal
          .saveHistory({ sessionId, content: snap, ...(h.getDimensions() ?? {}) })
          .catch(() => {});
      }
      if (!titleTriedRef.current && Date.now() - bootedAtRef.current >= 15_000) {
        const fuel = snap || lastSnapshotRef.current;
        if (fuel && fuel.length > 800) {
          void api.terminal
            .suggestTitle({ sessionId, content: fuel.slice(0, 20_000) })
            .then((r) => {
              if (r.done) titleTriedRef.current = true;
            })
            .catch(() => {});
        }
      }
    }, SNAPSHOT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [sessionId]);

  const handleStatusChange = (next: TerminalSessionStatus) => {
    // Final snapshot on exit — the buffer outlives the PTY, so the tail the
    // interval never reached is captured here.
    if (next === "exited" || next === "error") {
      const h = handleRef.current;
      if (!h) return;
      const snap = h.serialize();
      if (snap) {
        void api.terminal
          .saveHistory({ sessionId, content: snap, ...(h.getDimensions() ?? {}) })
          .catch(() => {});
      }
    }
  };

  return (
    <div className="group/term relative flex h-full min-h-0 w-full flex-col bg-surface">
      {/* The terminal host. `boot` gates the spawn until the history decision
          is made so the FIRST PTY already carries the right init command
          (--session-id vs --resume). */}
      <div className="min-h-0 flex-1">
        {projectPath && boot && (
          <TerminalView
            sessionKey={sessionId}
            projectPath={projectPath}
            cwd={projectPath}
            initCommand={boot.initCommand}
            initialContent={boot.initialContent}
            initialCols={boot.cols}
            initialRows={boot.rows}
            restoreSeparator={t("ide.termSession.historySeparator")}
            mentionFilesOnDrop
            projectPathForLinks={projectPath ?? undefined}
            onBusyChange={(busy) => setTerminalBusy(sessionId, busy)}
            active={isActive}
            onStatusChange={handleStatusChange}
            onReady={(h) => {
              handleRef.current = h;
            }}
          />
        )}
      </div>
    </div>
  );
}
