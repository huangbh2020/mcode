/**
 * Resolve which shell executable to spawn for an integrated terminal.
 *
 * Order:
 *  1. Explicit override (per-create or settings key)
 *  2. Platform smart defaults (pwsh → powershell → git-bash → cmd on Windows;
 *     $SHELL → bash → zsh → sh on POSIX)
 *
 * Returns an absolute-ish path (or bare command name that spawn can find) plus
 * argv. Callers should still handle spawn failures gracefully — the resolved
 * binary may not exist on PATH at runtime.
 */
import { existsSync } from "node:fs";
import { log } from "@main/lib/logger.js";
import { which } from "@main/lib/binaryResolve.js";

export interface ResolvedShell {
  /** Executable path or command name passed to node-pty. */
  file: string;
  /** argv (not including the executable). */
  args: string[];
  /** Display label for UI / TerminalInfo.shell. */
  label: string;
}

function winShellFromPath(file: string): ResolvedShell {
  const lower = file.toLowerCase();
  if (lower.endsWith("pwsh.exe") || lower.endsWith("\\pwsh") || lower.endsWith("/pwsh")) {
    return { file, args: ["-NoLogo"], label: file };
  }
  if (lower.includes("powershell")) {
    return { file, args: ["-NoLogo"], label: file };
  }
  if (lower.endsWith("bash.exe") || lower.endsWith("\\bash") || lower.endsWith("/bash")) {
    return { file, args: ["--login", "-i"], label: file };
  }
  if (lower.endsWith("cmd.exe") || lower.endsWith("\\cmd") || lower.endsWith("/cmd")) {
    return { file, args: [], label: file };
  }
  return { file, args: [], label: file };
}

function posixShellFromPath(file: string): ResolvedShell {
  // Login shell keeps user PATH/profile; -i is interactive.
  const base = file.split("/").pop() ?? file;
  if (base === "bash" || base === "zsh") {
    return { file, args: ["-l"], label: file };
  }
  return { file, args: [], label: file };
}

/** Resolve shell from an explicit user override (setting or per-create). */
function resolveOverride(override: string): ResolvedShell | null {
  const trimmed = override.trim();
  if (!trimmed) return null;
  const found = which(trimmed) ?? (existsSync(trimmed) ? trimmed : null);
  if (!found) {
    log.warn(`terminal.shell override not found: ${trimmed}`);
    return null;
  }
  return process.platform === "win32" ? winShellFromPath(found) : posixShellFromPath(found);
}

/** Platform smart-default shell. Always returns something spawnable-ish;
 *  last resort is `cmd.exe` / `/bin/sh` even if which() missed them. */
export function resolveDefaultShell(override?: string | null): ResolvedShell {
  if (override) {
    const o = resolveOverride(override);
    if (o) return o;
  }

  if (process.platform === "win32") {
    const order: Array<{ name: string; args: string[] }> = [
      { name: "pwsh", args: ["-NoLogo"] },
      { name: "powershell", args: ["-NoLogo"] },
      { name: "bash", args: ["--login", "-i"] },
      { name: "cmd", args: [] },
    ];
    for (const cand of order) {
      const file = which(cand.name);
      if (file) return { file, args: cand.args, label: file };
    }
    // Last resort — node-pty on Windows can usually find cmd via COMSPEC.
    const comspec = process.env.ComSpec || "cmd.exe";
    return { file: comspec, args: [], label: comspec };
  }

  const shellEnv = process.env.SHELL;
  if (shellEnv) {
    const found = which(shellEnv) ?? (existsSync(shellEnv) ? shellEnv : null);
    if (found) return posixShellFromPath(found);
  }
  for (const name of ["bash", "zsh", "sh"]) {
    const file = which(name);
    if (file) return posixShellFromPath(file);
  }
  return { file: "/bin/sh", args: [], label: "/bin/sh" };
}

/** Where the shell that WILL be spawned came from. */
export type ShellSource = "setting" | "default";

export interface EffectiveShell {
  /** The shell a newly created terminal will actually spawn. */
  shell: ResolvedShell;
  /** "setting" when the user's configured value was honored, "default"
   *  otherwise (empty setting, or a value that does not resolve). */
  source: ShellSource;
}

/** Tell apart "the setting is in effect" from "the setting was ignored".
 *
 *  `resolveDefaultShell` falls back to the platform default SILENTLY (a
 *  terminal must always open, and callers can't do anything about a missing
 *  binary anyway) — which is also why a typo'd path only ever shows up as a
 *  `terminal.shell override not found` warn line while the terminal happily
 *  opens the default shell. This wrapper is what the settings panel asks
 *  before/after saving, so the user is told the truth about their config
 *  instead of assuming it was applied. */
export function resolveEffectiveShell(setting?: string | null): EffectiveShell {
  if (setting) {
    const override = resolveOverride(setting);
    if (override) return { shell: override, source: "setting" };
  }
  return { shell: resolveDefaultShell(null), source: "default" };
}
