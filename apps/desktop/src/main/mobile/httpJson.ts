/**
 * httpJson — gzip negotiation for the mobile server's JSON responses.
 *
 * The static SPA bundle ships precompressed (.br/.gz siblings picked by
 * Accept-Encoding in serveMobileStatic), but the API was sending every
 * response as a plain `JSON.stringify` buffer. A 200-message history page or
 * a session-list page is routinely multi-MB of highly repetitive chat JSON —
 * the exact payload shape gzip loves (5–10x) and the exact thing that fails
 * to arrive in one piece when the phone is on an off-LAN tunnel with a few
 * Mbps of bandwidth. Browsers decompress transparently (`fetch` never sees
 * the encoding), so no client change is needed.
 *
 * Extracted as its own module so the decision logic is smoke-testable
 * without spinning up the electron-backed server.
 */
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);

/** Responses at or below this size skip compression — the gzip framing
 * overhead outweighs the savings and small replies stay single-frame. */
export const JSON_GZIP_MIN_BYTES = 1024;

/** True when the Accept-Encoding header names gzip without disqualifying it
 * via `q=0`. Token-aware (split on commas, ignores other codings' params) so
 * `deflate, br` correctly reports false and `gzip;q=0, identity` false too. */
export function acceptsGzip(acceptEncoding: string | string[] | undefined): boolean {
  if (!acceptEncoding) return false;
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : acceptEncoding;
  for (const raw of header.split(",")) {
    const parts = raw.trim().split(";");
    if (parts[0]?.trim().toLowerCase() !== "gzip") continue;
    const q = parts
      .slice(1)
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith("q="));
    if (q && Number.parseFloat(q.slice(2)) === 0) return false;
    return true;
  }
  return false;
}

/** Encode a JSON response body per the request's Accept-Encoding. Returns
 * the payload to write plus the Content-Encoding to declare (undefined =
 * identity). Compression runs on the libuv threadpool (promisified zlib), so
 * a multi-MB page never blocks the Electron main thread; a compression
 * failure falls back to plain text rather than failing the response. */
export async function encodeJsonBody(
  acceptEncoding: string | string[] | undefined,
  json: string,
): Promise<{ body: Buffer | string; contentEncoding?: "gzip" }> {
  if (!acceptsGzip(acceptEncoding) || json.length < JSON_GZIP_MIN_BYTES) {
    return { body: json };
  }
  try {
    return { body: await gzipAsync(json), contentEncoding: "gzip" };
  } catch {
    return { body: json };
  }
}
