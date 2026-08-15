/**
 * Browser-safe UUID.
 *
 * `crypto.randomUUID()` only exists in secure contexts (HTTPS / localhost /
 * Electron). The mobile shell is served over plain HTTP on the LAN, where the
 * function is undefined — calling it directly crashes with a TypeError on the
 * phone. Always route id generation through here when the code can run in the
 * web shell.
 */
export function browserUuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  // RFC 4122 v4-ish fallback — collision odds are irrelevant for the
  // request/tab-scoped ids this app generates.
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
