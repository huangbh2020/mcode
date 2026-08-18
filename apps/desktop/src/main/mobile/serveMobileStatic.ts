/**
 * serveMobileStatic — resolve + serve the shared renderer web bundle.
 *
 * The phone runs the SAME renderer bundle the desktop window loads
 * (electron-vite's `out/renderer`: index.html + hashed JS/CSS) — one build,
 * two transports. The main process serves these over the mobile HTTP server
 * so the phone loads a single origin and can call `/api/*` same-origin (no
 * CORS).
 *
 * Two entry pages are servered:
 *  - `index.html` — the full app (desktop window + mobile shell after
 *    pairing). Heavy: several MB of JS before first paint.
 *  - `pair.html` — a dependency-free pairing page (few KB) served for any URL
 *    carrying a `?nonce=…` pairing link (or `/pair`). Scanning the QR must
 *    show the verification-code form on the phone in about a second, even
 *    over a slow VPS/relay link — so it must NOT have to download the app
 *    bundle first. After a successful verify the page redirects to the bare
 *    origin (nonce stripped) to load the full app.
 *
 * Static assets are served precompressed (`.br`/`.gz` siblings emitted by the
 * vite build plugin in electron.vite.config.ts) when the client's
 * Accept-Encoding allows — the cold-start payload drops from ~5.5MB to ~1.3MB.
 *
 * Resolution order for the bundle root:
 *   1. `MCODE_WEB_DIST` env var (dev override, e.g. a live `vite build --watch`).
 *   2. `<app dev root>/out/renderer` — dev build (`pnpm dev` / `pnpm build`).
 *   3. packaged location next to the main bundle (production, inside asar —
 *      node's fs transparently reads asar paths).
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
  if (process.env["MCODE_WEB_DIST"]) out.push(process.env["MCODE_WEB_DIST"]);
  // dev: apps/desktop/out/renderer (cwd is apps/desktop under `pnpm dev`)
  out.push(join(process.cwd(), "out", "renderer"));
  // production: the main bundle ships in out/main/, so ../renderer = out/renderer
  out.push(join(__dirname, "..", "renderer"));
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
  log.warn("mobile: no built bundle found — serving placeholder. Run `pnpm dev` (or `pnpm build`) in apps/desktop.");
  return null;
}

/** Reset the cached root (used on reload / dev rebuild watch). */
export function invalidateMobileDistCache(): void {
  resolvedRoot = undefined;
}

function sendPlaceholder(res: ServerResponse): void {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mcode</title>
<body style="font:14px/1.6 system-ui;margin:2rem;color:#333">
<h2>Mcode (web bundle not built)</h2>
<p>Run <code>pnpm dev</code> (or <code>pnpm build</code>) in apps/desktop, then reload this page.</p>
<p>If you set <code>MCODE_WEB_DIST</code>, make sure it points at a folder containing <code>index.html</code>.</p>
</body>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/** Serve the standalone pairing page (`pair.html` from the built renderer
 *  bundle). Falls back to a tiny inline page when the bundle predates the
 *  multi-page build, so a stale `out/renderer` yields a diagnosable message
 *  instead of a bare 404. */
function servePairingPage(res: ServerResponse, root: string): void {
  const pairPath = join(root, "pair.html");
  try {
    const s = statSync(pairPath);
    if (s.isFile()) {
      streamFile(res, pairPath, ".html", s.size);
      return;
    }
  } catch {
    // pair.html missing — fall through to the inline fallback
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mcode</title>
<body style="font:14px/1.6 system-ui;margin:2rem;color:#333">
<h2>Mcode 配对页未构建</h2>
<p>请先在 apps/desktop 执行 <code>pnpm build</code> 重新构建 renderer，再扫码配对。</p>
</body>`);
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
  const rawUrl = req.url ?? "/";
  const urlPath = rawUrl.split("?", 2)[0];

  // The QR/link pairing URL carries a one-time `?nonce=…` (or the user hits
  // `/pair` directly). Serve the tiny standalone pair.html — NOT the desktop
  // bundle — so the phone's first paint shows the verification-code form in a
  // few KB instead of several MB over the VPS/relay link. The full app is
  // served for every other path; after pairing the page redirects to the bare
  // origin (nonce stripped) to load it.
  const isPairing =
    rawUrl.includes("nonce=") || urlPath === "/pair" || urlPath === "/pair.html";
  if (isPairing) {
    servePairingPage(res, root);
    return;
  }

  // Default to index.html for the bare root.
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  // Defend against path traversal: resolve under root and verify containment.
  const filePath = normalize(join(root, rel));
  if (!filePath.startsWith(normalize(root))) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  const acceptEncoding = req.headers["accept-encoding"];
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
        streamFile(res, join(root, "index.html"), ".html", idx.size, acceptEncoding);
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
      streamFile(res, join(filePath, "index.html"), ".html", idx.size, acceptEncoding);
      return;
    } catch {
      res.writeHead(404);
      res.end("not found");
      return;
    }
  }
  streamFile(res, filePath, extname(rel), stat.size, acceptEncoding);
}

/** Extensions worth precompressing (JS/CSS dwarf everything else in size). */
const COMPRESSIBLE_EXT = new Set([".js", ".mjs", ".css", ".json", ".svg"]);

/** Pick the best precompressed sibling (`.br`/`.gz`, emitted by the vite build
 *  plugin `precompressAssets()` in electron.vite.config.ts) honoring the
 *  client's Accept-Encoding. Returns null when the client wants no compression
 *  or no precompressed copy exists (e.g. a hand-built bundle) — the caller
 *  then serves the raw file. */
function pickPrecompressed(
  filePath: string,
  ext: string,
  acceptEncoding: string | undefined,
): { path: string; encoding: "br" | "gzip"; size: number } | null {
  if (!COMPRESSIBLE_EXT.has(ext.toLowerCase())) return null;
  const accept = (acceptEncoding ?? "").toLowerCase();
  if (accept.includes("*")) {
    // "any encoding" is rare from browsers; serve raw rather than guess — the
    // raw copy is always present and correct.
    return null;
  }
  const wantsBr = accept.includes("br");
  const wantsGzip = accept.includes("gzip");
  if (!wantsBr && !wantsGzip) return null;
  const encodings = wantsBr ? (["br", "gzip"] as const) : (["gzip"] as const);
  for (const enc of encodings) {
    const suffix = enc === "br" ? ".br" : ".gz";
    const candidate = `${filePath}${suffix}`;
    try {
      const s = statSync(candidate);
      if (s.isFile()) return { path: candidate, encoding: enc, size: s.size };
    } catch {
      // no precompressed copy — try the next encoding / give up
    }
  }
  return null;
}

function streamFile(
  res: ServerResponse,
  filePath: string,
  ext: string,
  size: number,
  acceptEncoding?: string,
): void {
  const mime = MIME[ext.toLowerCase()] ?? "application/octet-stream";
  const isHtml = ext === ".html";
  const compressed = isHtml ? null : pickPrecompressed(filePath, ext, acceptEncoding);
  const body = compressed ?? { path: filePath, size };
  // Asset filenames are content-hashed by Vite → immutable caching is safe;
  // HTML is uncached so a fresh nonce / route always revalidates.
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": body.size,
    "Cache-Control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
    ...(compressed
      ? { "Content-Encoding": compressed.encoding, Vary: "Accept-Encoding" }
      : {}),
  });
  createReadStream(body.path).on("error", () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }).pipe(res);
}
