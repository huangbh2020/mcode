/**
 * Build an `app-resource://` URL for an absolute local file path.
 *
 * This mirrors the handler in main/lib/appResourceProtocol.ts — same fixed
 * host, same single `encodeURIComponent`-encoded path segment. The scheme is
 * registered as privileged (standard + stream) by main at startup, so media
 * elements can stream and seek it. Used by the IDE's video preview instead
 * of `file:readBinary` data URLs, which would need the whole (potentially
 * hundreds-of-MB) file resident in the renderer as base64.
 */
export function appResourceUrl(filePath: string): string {
  return `app-resource://f/${encodeURIComponent(filePath)}`;
}
