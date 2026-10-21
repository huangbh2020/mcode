/**
 * Terminal-session CLI catalog — maps a session's providerId to the
 * user-installed CLI it runs in the PTY, and builds the injected init
 * command per CLI's resume semantics:
 *
 *  - claude (`claude-sdk`): pinned uuid via `--session-id <uuid>` on first
 *    open; restarts `--resume <uuid>` (the pin can be dropped by a CLI
 *    auto-update relaunch — main's reconcile adopts the real id).
 *  - pi (`pi-sdk`): `--session-id <uuid>` "creating it if missing" — the
 *    SAME command both creates and continues, so first open and restart are
 *    identical. No reconcile needed (the pin is deterministic).
 *  - codex (`codex-sdk`): no first-run pin exists — first open is the bare
 *    `codex`; main's reconcile adopts the rollout session uuid afterwards
 *    and restarts run `codex resume <uuid>`.
 *  - opencode (`opencode`): same shape as codex — `-s <id>` REQUIRES an
 *    existing session ("Session not found" on a fresh id, verified live on
 *    1.17.13), so first open is the bare `opencode`; main's reconcile
 *    adopts the session id from opencode's SQLite store afterwards and
 *    restarts run `opencode -s <id>`.
 *
 * Unknown providerIds return null — the pane then opens a plain shell,
 * which is also the "no CLI picked" degenerate case.
 */

/** Provider ids that have a terminal-CLI counterpart. Order = menu order.
 *  The first three mirror registered AgentProviders; "opencode" and
 *  "antigravity" are terminal-ONLY ids (the user's own CLIs, no
 *  AgentProvider behind them). */
export const TERMINAL_CLI_PROVIDER_IDS: readonly string[] = [
  "claude-sdk",
  "pi-sdk",
  "codex-sdk",
  "opencode",
  "antigravity",
];

/** Fallback display names when the provider list isn't hydrated yet. */
export const TERMINAL_CLI_FALLBACK_LABELS: Record<string, string> = {
  "claude-sdk": "Claude",
  "pi-sdk": "Pi",
  "codex-sdk": "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity",
};

/** The shell command each provider's terminal session injects. */
export function terminalCliCommand(providerId: string): string {
  switch (providerId) {
    case "claude-sdk":
      return "claude";
    case "pi-sdk":
      return "pi";
    case "codex-sdk":
      return "codex";
    case "opencode":
      return "opencode";
    case "antigravity":
      // Antigravity CLI (agy.exe under %LOCALAPPDATA%\agy\bin, installed by
      // the IDE; `agy install` puts it on PATH).
      return "agy";
    default:
      return providerId;
  }
}

/**
 * Init command injected into the shell after it boots.
 *  `cliSessionId` — the pre-generated uuid from the session row's
 *    claudeSessionId slot (null only for degenerate rows → plain shell).
 *  `restored` — a scrollback snapshot existed, i.e. this is a RESTART open.
 */
export function buildTerminalInitCommand(
  providerId: string,
  cliSessionId: string | null | undefined,
  restored: boolean,
): string | null {
  if (!cliSessionId) return null;
  switch (providerId) {
    case "claude-sdk":
      return restored ? `claude --resume ${cliSessionId}` : `claude --session-id ${cliSessionId}`;
    case "pi-sdk":
      // "Use exact project session ID, creating it if missing" — one
      // command for both first open and continuation.
      return `pi --session-id ${cliSessionId}`;
    case "codex-sdk":
      // No pin exists; before the reconcile adopts a uuid there is nothing
      // to resume (bare launch), after adoption restarts resume by id.
      return restored ? `codex resume ${cliSessionId}` : "codex";
    case "opencode":
      // Same shape as codex: no first-run pin (`-s <fresh-id>` errors with
      // "Session not found"); after main's reconciler adopts the session id
      // from opencode's SQLite store (opencodeSession.ts), restarts resume
      // with `-s <id>` ("session id to continue").
      //
      // opencode validates that session IDs start with "ses" (e.g. "ses_...").
      // A raw pre-generated UUID means reconciliation has not adopted the real
      // session yet; passing it causes `Error: Expected a string starting with "ses"`.
      // Fall back to bare "opencode" if cliSessionId is not yet a valid "ses" id.
      return restored && cliSessionId.startsWith("ses") ? `opencode -s ${cliSessionId}` : "opencode";
    case "antigravity":
      // Same shape as codex: no first-run pin; after main's reconciler
      // adopts the conversation uuid (agySession.ts), restarts resume with
      // `--conversation <uuid>` (agy 1.4.2 help: "Resume a previous
      // conversation by ID"). Automatically appends `--dangerously-skip-permissions`
      // to auto-approve tool execution without approval prompts.
      return restored
        ? `agy --dangerously-skip-permissions --conversation ${cliSessionId}`
        : "agy --dangerously-skip-permissions";
    default:
      return null;
  }
}
