/** Smoke stub for @main/lib/pathGuard.js — imports electron's app otherwise.
 *  Only samePath is needed (MCP allowlist matching); a normalized-string
 *  comparison suffices for the smoke's purposes. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
