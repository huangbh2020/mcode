/**
 * Image artifact registry + cache, backing the lightbox's "show in file
 * manager" action.
 *
 * The renderer only ever holds a picture as a `data:` URL — the chat block
 * contract carries no filesystem path (browser screenshots come back from
 * providers as bare base64, pasted images never had a file at all). So instead
 * of letting the renderer name a path, main remembers the artifacts it wrote
 * itself, keyed by the **content hash** of the bytes:
 *
 *   browser_screenshot → `<screenshotDir>/<sessionId>/turn-<N>/<ts>-<id>.png`
 *   codex imageGeneration → the item's `savedPath`
 *
 * A reveal request carries the displayed bytes; hashing them finds the original
 * file, so the user is taken to the directory the screenshot was really saved
 * to (the configured screenshot dir, or Pictures) rather than a copy — and a
 * renderer-supplied path can never be opened, because none is accepted.
 *
 * When nothing matches (an image from an earlier app run — the registry is
 * in-memory, per process — a pasted image, or an MCP tool's image), the same
 * bytes are materialized into `<userData>/images/<sha1>.<ext>`. Content
 * addressed again: repeated clicks and duplicate images all resolve to the one
 * file, and a re-click never rewrites it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, shell } from "electron";
import { log } from "@main/lib/logger.js";

/** sha1 (hex) of the image bytes → absolute path of the file we wrote for it.
 *  Insertion-ordered, so the oldest entry is evicted first; a long session
 *  full of screenshots must not grow this without bound. */
const artifactByHash = new Map<string, string>();

/** Entry cap. Only hashes + paths are held (~100 bytes each), so this is a
 *  negligible amount of memory for a whole session's worth of images. */
const MAX_ARTIFACTS = 500;

/** Diagnostic-only strings returned to the renderer (the UI shows its own
 *  localized text) — same convention as `clipboard:writeImage`. */

/** Content hash of base64 image data. The registry key for both lookups and
 *  the cache filename, so both paths agree by construction. */
function hashImageData(data: string): string {
  return createHash("sha1").update(Buffer.from(data, "base64")).digest("hex");
}

/** Remember that `data` (base64) lives on disk at `filePath`. Called by the
 *  capture sites right after a successful write. Re-registering the same bytes
 *  (a retried save, a re-generated identical image) just refreshes the path. */
export function registerImageArtifact(data: string, filePath: string): void {
  if (!data || !filePath) return;
  const hash = hashImageData(data);
  artifactByHash.delete(hash);
  artifactByHash.set(hash, filePath);
  if (artifactByHash.size > MAX_ARTIFACTS) {
    const oldest = artifactByHash.keys().next().value;
    if (oldest !== undefined) artifactByHash.delete(oldest);
  }
}

/** The on-disk file for these bytes, when we wrote one earlier in this process
 *  and it is still there (it may have been deleted by the user meanwhile —
 *  then we fall back to the cache). */
export function lookupImageArtifact(data: string): string | undefined {
  const path = artifactByHash.get(hashImageData(data));
  if (!path) return undefined;
  if (!existsSync(path)) {
    artifactByHash.delete(hashImageData(data));
    return undefined;
  }
  return path;
}

/** File extension for a MIME type. The schema pins `image/...`, but the
 *  subtype is not limited to the four the composer allows (SVG, BMP and AVIF
 *  can arrive from an MCP tool), so unknown subtypes are passed through when
 *  they look like a sane extension and fall back to .png otherwise. */
function extForMimeType(mimeType: string): string {
  const sub = mimeType.slice("image/".length).toLowerCase().split("+")[0].split(";")[0];
  if (sub === "jpeg" || sub === "jpg") return "jpg";
  if (sub === "svg") return "svg";
  if (sub === "x-icon" || sub === "vnd.microsoft.icon") return "ico";
  return /^[a-z0-9]{1,8}$/.test(sub) ? sub : "png";
}

/** Write the displayed bytes to `<userData>/images/<sha1>.<ext>` and return the
 *  path. Idempotent: an existing file for the same bytes is reused as-is (so
 *  the file's mtime stays put and repeated clicks are free). Returns null when
 *  the write fails. */
export function materializeImage(data: string, mimeType: string): string | null {
  try {
    const dir = join(app.getPath("userData"), "images");
    const filePath = join(dir, `${hashImageData(data)}.${extForMimeType(mimeType)}`);
    if (existsSync(filePath)) return filePath;
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, Buffer.from(data, "base64"));
    log.info(`image cached for reveal: ${filePath}`);
    return filePath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`image cache write failed: ${msg}`);
    return null;
  }
}

/** Split a `data:image/<mime>;base64,<payload>` URL. The schema already
 *  constrains the shape; a payload that decodes to nothing is rejected here. */
function parseImageDataUrl(dataUrl: string): { data: string; mimeType: string } | null {
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,(.+)$/i.exec(dataUrl);
  if (!m || !m[2] || !m[1]) return null;
  return { data: m[2], mimeType: m[1].toLowerCase() };
}

/** Resolve the displayed image to a file on disk — the original artifact when
 *  this process saved it, otherwise a cache copy — then reveal it, selecting
 *  the file in Finder/Explorer. Never throws; failures come back as `ok:false`
 *  with a diagnostic message for the log. */
export function revealImageInFolder(dataUrl: string): { ok: boolean; path?: string; error?: string } {
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) {
    log.warn("image.revealInFolder refused (undecodable data URL)");
    return { ok: false, error: "图片数据无法解码" };
  }
  if (!parsed.mimeType.startsWith("image/")) {
    log.warn(`image.revealInFolder refused (not an image): ${parsed.mimeType}`);
    return { ok: false, error: `不是图片类型:${parsed.mimeType}` };
  }
  const target = lookupImageArtifact(parsed.data) ?? materializeImage(parsed.data, parsed.mimeType);
  if (!target) return { ok: false, error: "图片文件写入失败" };
  // showItemInFolder opens the containing folder and selects the item. No
  // error return; on failure the OS simply does nothing.
  shell.showItemInFolder(target);
  return { ok: true, path: target };
}
