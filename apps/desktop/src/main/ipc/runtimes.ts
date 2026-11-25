/**
 * IPC handlers for the settings panel's "Agent Runtimes" section.
 *
 * Two download-on-demand runtimes (codex / pi) — see
 * main/runtimes/runtimeInstaller.ts for the install pipeline. list() is a
 * snapshot (expected vs installed vs registry-latest); install() runs the
 * full download→verify→gate→extract pipeline and resolves when done,
 * streaming coarse progress over the `runtimes:event` push channel;
 * remove()/rollback() delete managed version dirs.
 *
 * Claude is NOT a managed runtime any more (2026-11-24): Claude sessions run
 * the user's own `claude` CLI (lib/claudeExecutable.ts), installed and
 * updated from the「终端会话类型」section of the same panel. The installer
 * still knows the agent (the compat list and older installs on disk do), so
 * the boundary is here: the panel never sees it, and an operation that names
 * it is refused with a pointer to where the CLI is managed.
 *
 * install/remove/rollback are ALL rejected while ANY turn is running: the
 * runtime binary the turn is executing (or about to spawn) would vanish
 * mid-flight, and on Windows deleting a running executable's dir fails with
 * EPERM. The guard is intentionally conservative (any session, not
 * per-agent) — replacing a ~300MB runtime is rare enough that a "stop your
 * turns first" hint is cheaper than per-provider mapping. The check RPC is
 * read-only and always allowed.
 */
import type { IpcMain } from "electron";
import {
  IPC,
  RuntimesCheckSchema,
  RuntimesClaudeCliSchema,
  RuntimesInstallLocalSchema,
  RuntimesInstallSchema,
  RuntimesRemoveSchema,
  RuntimesRollbackSchema,
  type ClaudeCliStatus,
  type RuntimeAgentId,
} from "@contracts/ipc";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import {
  invalidateClaudeExecutableCache,
  MIN_CLAUDE_CLI_VERSION,
  compareVersions,
  probeClaudeCliVersion,
  resolveClaudeExecutable,
} from "@main/lib/claudeExecutable.js";
import {
  checkRuntimeUpdates,
  installRuntime,
  installRuntimeFromLocalPath,
  listRuntimes,
  removeRuntime,
  rollbackRuntime,
} from "@main/runtimes/runtimeInstaller.js";

/** Agents Mcode no longer downloads: their sessions run the user's own CLI. */
const UNMANAGED_AGENTS: ReadonlySet<RuntimeAgentId> = new Set(["claude"]);

const UNMANAGED_ERROR =
  "Claude 会话直接运行本机安装的 claude CLI,Mcode 不再单独下载 Claude 运行时 — 请到 设置 → Agent 的「终端会话类型」里安装或更新。";

function unmanagedGuard(agent: RuntimeAgentId): { ok: false; error: string } | null {
  return UNMANAGED_AGENTS.has(agent) ? { ok: false, error: UNMANAGED_ERROR } : null;
}

function runningTurnGuard(): { ok: false; error: string } | null {
  const running = runtimeManager.runningSessionIds();
  if (running.length === 0) return null;
  return {
    ok: false,
    error: `${running.length} session(s) still have a running turn — stop them before touching a runtime`,
  };
}

export function registerRuntimesHandlers(ipcMain: IpcMain): void {
  // list takes no input (mirrors lsp.list) — nothing to parse.
  ipcMain.handle(IPC.RUNTIMES_LIST, async () => {
    const runtimes = (await listRuntimes()).filter((r) => !UNMANAGED_AGENTS.has(r.agent));
    return { runtimes };
  });

  ipcMain.handle(IPC.RUNTIMES_INSTALL, async (_evt, raw) => {
    const input = RuntimesInstallSchema.parse(raw);
    const unmanaged = unmanagedGuard(input.agent);
    if (unmanaged) return unmanaged;
    const guard = runningTurnGuard();
    if (guard) return guard;
    return await installRuntime(input.agent, input.version, input.force ?? false);
  });

  ipcMain.handle(IPC.RUNTIMES_INSTALL_LOCAL, async (_evt, raw) => {
    const input = RuntimesInstallLocalSchema.parse(raw);
    const unmanaged = unmanagedGuard(input.agent);
    if (unmanaged) return unmanaged;
    const guard = runningTurnGuard();
    if (guard) return guard;
    return await installRuntimeFromLocalPath(input.agent, input.localPath);
  });

  ipcMain.handle(IPC.RUNTIMES_REMOVE, async (_evt, raw) => {
    const input = RuntimesRemoveSchema.parse(raw);
    const unmanaged = unmanagedGuard(input.agent);
    if (unmanaged) return unmanaged;
    const guard = runningTurnGuard();
    if (guard) return guard;
    return await removeRuntime(input.agent, input.version);
  });

  // Manual "check for updates" — user-clicked only, read-only, always allowed.
  ipcMain.handle(IPC.RUNTIMES_CHECK_UPDATES, async (_evt, raw) => {
    RuntimesCheckSchema.parse(raw);
    const results = (await checkRuntimeUpdates()).filter((r) => !UNMANAGED_AGENTS.has(r.agent));
    return { results };
  });

  ipcMain.handle(IPC.RUNTIMES_ROLLBACK, async (_evt, raw) => {
    const input = RuntimesRollbackSchema.parse(raw);
    const unmanaged = unmanagedGuard(input.agent);
    if (unmanaged) return unmanaged;
    const guard = runningTurnGuard();
    if (guard) return guard;
    return await rollbackRuntime(input.agent);
  });

  // The provider picker's availability gate for claude-sdk: the USER'S CLI,
  // not the managed-runtime list (Claude left it — sessions spawn this CLI
  // directly). Same version gate startTurn applies, so a green item cannot
  // still fail at launch with the "too old" card. `force` drops the ~10 min
  // resolver/probe caches (a CLI installed moments ago).
  ipcMain.handle(IPC.RUNTIMES_CLAUDE_CLI, async (_evt, raw) => {
    const { force } = RuntimesClaudeCliSchema.parse(raw ?? {});
    if (force) invalidateClaudeExecutableCache();
    const executable = resolveClaudeExecutable();
    if (!executable) {
      const status: ClaudeCliStatus = { installed: false, minVersion: MIN_CLAUDE_CLI_VERSION, usable: false, reason: "not-installed" };
      return status;
    }
    const version = await probeClaudeCliVersion(executable, 8_000, force).catch(() => null);
    const tooOld = version !== null && compareVersions(version, MIN_CLAUDE_CLI_VERSION) < 0;
    const status: ClaudeCliStatus = {
      installed: true,
      path: executable.path,
      ...(version ? { version } : {}),
      minVersion: MIN_CLAUDE_CLI_VERSION,
      usable: !tooOld,
      ...(tooOld ? { reason: "too-old" as const } : {}),
    };
    return status;
  });
}
