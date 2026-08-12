/**
 * serveMobileStatic — resolve + serve the prebuilt mobile web bundle.
 *
 * The mobile app is a separate Vite build (`mobile.vite.config.ts`) that emits
 * plain static assets (index.html + hashed JS/CSS). The main process serves
 * these over the mobile HTTP server so the phone loads a single origin and can
 * call `/api/*` same-origin (no CORS).
 *
 * Resolution order for the bundle root:
 *   1. `MCODE_MOBILE_DIST` env var (dev override, e.g. a live `vite build --watch`).
 *   2. `<app dev root>/out-mobile` — dev build (`pnpm build:mobile` from apps/desktop).
 *   3. packaged location next to the app resources (production).
 *
 * When no bundle is found we serve a placeholder explaining how to build it,
 * rather than a bare 404 — this makes "I started the PC but the phone shows
 * nothing" immediately diagnosable.
 */
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { app } from "electron";
import type { IncomingMessage, ServerResponse } from "node:http";
import { log } from "@main/lib/logger.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Candidate bundle roots, in priority order. */
function candidateRoots(): string[] {
  const out: string[] = [];
  if (process.env["MCODE_MOBILE_DIST"]) out.push(process.env["MCODE_MOBILE_DIST"]);
  // dev: apps/desktop/out/mobile (cwd is apps/desktop under `pnpm dev`)
  out.push(join(process.cwd(), "out", "mobile"));
  // production: the main bundle ships in out/main/, so ../mobile = out/mobile
  out.push(join(__dirname, "..", "mobile"));
  return out;
}

let resolvedRoot: string | null | undefined;

/** Resolve the bundle root once and cache it. Returns null when no bundle is
 *  present on disk. */
function resolveRoot(): string | null {
  if (resolvedRoot !== undefined) return resolvedRoot;
  for (const c of candidateRoots()) {
    try {
      const stat = statSync(join(c, "index.html"));
      if (stat.isFile()) {
        resolvedRoot = c;
        log.info(`mobile: serving bundle from ${c}`);
        return c;
      }
    } catch {
      // not present here, try next
    }
  }
  resolvedRoot = null;
  log.warn("mobile: no built bundle found — serving placeholder. Run `pnpm build:mobile`.");
  return null;
}

/** Reset the cached root (used on reload / dev rebuild watch). */
export function invalidateMobileDistCache(): void {
  resolvedRoot = undefined;
}

function sendPlaceholder(res: ServerResponse): void {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mcode Mobile</title>
<body style="font:14px/1.6 system-ui;margin:2rem;color:#333">
<h2>Mcode Mobile (bundle not built)</h2>
<p>Run <code>pnpm build:mobile</code> in the project root, then reload this page.</p>
<p>If you set <code>MCODE_MOBILE_DIST</code>, make sure it points at a folder containing <code>index.html</code>.</p>
</body>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/** Serve a static file from the mobile bundle, falling back to index.html for
 *  unknown non-asset paths (SPA history routing). Asset misses 404 so the
 *  browser doesn't get HTML for a missing .js file. */
export function serveMobileAsset(req: IncomingMessage, res: ServerResponse): void {
  const root = resolveRoot();
  if (!root) {
    sendPlaceholder(res);
    return;
  }
  const urlPath = (req.url ?? "/").split("?", 2)[0];
  // Default to index.html for the bare root.
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  // Defend against path traversal: resolve under root and verify containment.
  const filePath = normalize(join(root, rel));
  if (!filePath.startsWith(normalize(root))) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  // Serve the file if it exists; otherwise, for non-asset requests, fall back
  // to index.html (SPA). Asset extensions (.js/.css/...) 404 on miss.
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    const ext = extname(rel).toLowerCase();
    if (ext === "" || ext === ".html") {
      rel = "/index.html";
      try {
        const idx = statSync(join(root, "index.html"));
        streamFile(res, join(root, "index.html"), ".html", idx.size);
        return;
      } catch {
        res.writeHead(404);
        res.end("not found");
        return;
      }
    }
    res.writeHead(404);
    res.end("not found");
    return;
  }
  if (stat.isDirectory()) {
    // directory request → index.html
    try {
      const idx = statSync(join(filePath, "index.html"));
      streamFile(res, join(filePath, "index.html"), ".html", idx.size);
      return;
    } catch {
      res.writeHead(404);
      res.end("not found");
      return;
    }
  }
  streamFile(res, filePath, extname(rel), stat.size);
}

function streamFile(res: ServerResponse, filePath: string, ext: string, size: number): void {
  const mime = MIME[ext.toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": size,
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
  createReadStream(filePath).on("error", () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }).pipe(res);
}
