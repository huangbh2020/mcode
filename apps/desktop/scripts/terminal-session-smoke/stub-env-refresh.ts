/* Smoke stub for @main/terminal/envRefresh.js — skips the real Windows
 * registry refresh (a powershell spawn) for speed/determinism. */
export async function buildTerminalEnv(): Promise<{
  env: Record<string, string | undefined>;
  registryVarsApplied: number;
}> {
  return { env: { ...process.env }, registryVarsApplied: 0 };
}
