/**
 * `app-resource://` — main's guarded streaming file protocol for renderer
 * media elements (`<video>` in the IDE's VideoPreviewPane today).
 *
 * Why a protocol instead of the image pipeline (`file:readBinary` → base64
 * data URL): rendered tutorial videos are tens-to-hundreds of MB. A data URL
 * needs the WHOLE file resident in the renderer as a 1.33x-inflated base64
 * string, and the production CSP has no `media-src` entry (`default-src
 * 'self'` blocks data:/blob: media anyway). A custom protocol streams from
 * disk with HTTP Range support, so `<video>` seeking works and memory stays
 * flat regardless of file size.
 *
 * URL shape: `app-resource://f/<encodeURIComponent(absolutePath)>` — a fixed
 * host (standard-scheme URLs parse more predictably with one) plus a single
 * opaque percent-encoded segment carrying the full path. All slashes are
 * encoded, so WHATWG URL dot-segment normalization cannot rewrite the path.
 * The mirror helper lives at renderer/lib/appResource.ts — keep the two in
 * sync.
 *
 * Security: the handler applies the SAME containment guard as
 * `readBinaryGuarded` (ipc/files.ts) — the decoded path must live inside a
 * known workspace root (persisted projects ∪ session worktrees) or the
 * paste-temp dir. Anything else 403s and is logged, matching its IPC twin.
 */
import { protocol } from "electron";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { findContainingWorkspaceRoot, isPasteTempPath } from "@main/lib/pathGuard.js";
import { log } from "@main/lib/logger.js";

export const APP_RESOURCE_SCHEME = "app-resource";
const APP_RESOURCE_HOST = "f";

/** Content-Types served by the protocol. Unknown extensions fall back to a
 *  generic octet-stream — Chromium's media pipeline sniffs containers
 *  anyway; the header mainly keeps non-media consumers honest. Shared with
 *  the mobile server's `/api/media` route (same media, one HTTP transport
 *  for the phone, this protocol for the desktop window). */
export const MEDIA_CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".ogv": "video/ogg",
  ".avi": "video/x-msvideo",
  // The desktop PDF pane reads bytes over IPC (file:readBinary), but the
  // mobile /api/media route shares this table — phones then inline PDFs in
  // their browser viewer for free.
  ".pdf": "application/pdf",
};
const CONTENT_TYPES = MEDIA_CONTENT_TYPES;

/** Register the scheme's privileges — MUST run before app ready: the media
 *  pipeline only honors `stream` (streaming + seekable media) on schemes
 *  that were privileged at session-creation time. */
export function registerAppResourceScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_RESOURCE_SCHEME,
      privileges: { standard: true, secure: true, stream: true },
    },
  ]);
}

/** Install the request handler — call once from app.whenReady(). */
export function initAppResourceProtocol(): void {
  protocol.handle(APP_RESOURCE_SCHEME, async (request): Promise<Response> => {
    const refuse = (status: number, message: string): Response => {
      log.warn(`app-resource refused (${status}) — ${message}`);
      return new Response(message, { status });
    };

    let filePath: string;
    try {
      const url = new URL(request.url);
      if (url.host !== APP_RESOURCE_HOST) throw new Error("unexpected host");
      filePath = decodeURIComponent(url.pathname.replace(/^\//, ""));
    } catch {
      return refuse(400, `malformed app-resource URL: ${request.url}`);
    }

    const root = findContainingWorkspaceRoot(filePath);
    if (!root && !isPasteTempPath(filePath)) {
      return refuse(403, `path outside any workspace root: ${filePath}`);
    }

    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch (err) {
      return refuse(404, `stat failed for ${filePath}: ${(err as Error).message}`);
    }

    const headers: Record<string, string> = {
      "Content-Type": CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
    };

    // Range handling is manual: `<video>` seeking issues `bytes=start-end`
    // requests, and answering them with 206 partial content is what makes
    // the scrubber usable on large files. A Node fs read stream backs the
    // Response body via Readable.toWeb (cast: node:stream/web vs the global
    // ReadableStream type disagree nominally, not structurally).
    const rangeHeader = request.headers.get("range");
    const range = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (Number.isNaN(start) || start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
      return new Response(
        Readable.toWeb(createReadStream(filePath, { start, end })) as unknown as ReadableStream,
        {
          status: 206,
          headers: {
            ...headers,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": String(end - start + 1),
          },
        },
      );
    }

    return new Response(Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream, {
      status: 200,
      headers: { ...headers, "Content-Length": String(size) },
    });
  });
  log.info("app-resource:// protocol registered (guarded media streaming)");
}
