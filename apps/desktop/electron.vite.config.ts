import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { constants as zlibConstants, brotliCompressSync, gzipSync } from "node:zlib";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

/**
 * Emits a `.gz` and a `.br` copy of every text asset right next to the
 * original in the build output. The mobile HTTP server
 * (`src/main/mobile/serveMobileStatic.ts`) picks these up via
 * `Accept-Encoding` and serves them with Content-Encoding — zero runtime CPU
 * cost, and the phone's cold start over a VPS/relay link drops from ~5.5MB to
 * ~1.3MB. HTML is intentionally skipped: it's tiny and must stay uncached.
 *
 * Compression runs in `closeBundle` against the FINAL files on disk (after
 * Vite's HTML plugin has rewritten the entry chunks and written everything),
 * NOT against `output.code` from `generateBundle`: the in-memory snapshot is a
 * transient intermediate where Vite has already substituted dynamic-import
 * deps with a `__VITE_PRELOAD__` marker that only becomes defined once the
 * rewritten HTML is emitted — compressing that snapshot produces broken
 * `.gz/.br` files (ReferenceError: __VITE_PRELOAD__ is not defined on the
 * phone, while the desktop file:// load works fine). Compressing the written
 * files guarantees the served bytes are identical to what the desktop loads.
 */
function precompressAssets(): Plugin {
  let outDir = "";
  let writeCompleted = false;
  return {
    name: "mcode:precompress",
    apply: "build",
    configResolved(config) {
      // Only the renderer build is served over HTTP (mobile server). The main
      // and preload outputs are lib builds loaded by Electron from disk —
      // compressed copies there would be dead weight in the installer.
      if (config.build.lib) return;
      outDir = config.build.outDir;
    },
    writeBundle() {
      // closeBundle also fires on failed builds (after a partial write);
      // only compress when the write phase actually completed.
      writeCompleted = true;
    },
    closeBundle() {
      if (!outDir || !writeCompleted) return;
      const files = walkTextFiles(outDir);
      const started = Date.now();
      let count = 0;
      for (const file of files) {
        const source = readFileSync(file);
        if (source.length === 0) continue;
        writeFileSync(`${file}.gz`, gzipSync(source, { level: 9 }));
        writeFileSync(
          `${file}.br`,
          brotliCompressSync(source, {
            // q9 ≈ 98% of q11's ratio at a fraction of the wall time (the
            // renderer output is ~40MB of JS; q11 adds ~70s to every build).
            params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 },
          }),
        );
        count++;
      }
      if (count > 0) {
        console.log(`[mcode:precompress] ${count} files → .gz/.br in ${Date.now() - started}ms`);
      }
    },
  };
}

/** Recursively collect text assets (JS/CSS/JSON/SVG) under a directory.
 *  Skips any file that is itself a precompressed variant and HTML. */
function walkTextFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTextFiles(full));
    } else if (/\.(js|mjs|css|json|svg)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Absolute path to the monaco-editor package root. Used to alias the worker
 *  entry imports so Vite's `?worker` resolver finds them on disk regardless
 *  of monaco-editor's package.json `exports` field (whose `./*.js` wildcard
 *  mis-maps the `esm/vs/.../foo.worker.js` paths documented for Vite).
 *
 *  `require.resolve` follows pnpm's symlinks to the real package dir. */
const monacoPkgDir = resolve(
  __dirname,
  "node_modules/monaco-editor",
);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: "src/main/index.ts" },
      rollupOptions: {
        // contracts is a workspace source package — bundle it into main.
        // sql.js (asm.js build) is externalized and required at runtime like
        // electron/zod — its ~6MB asm.js file is too large to inline cleanly.
        // node-pty is a native addon — must load from node_modules at runtime
        // (never bundle the .node binary into the main chunk).
        external: ["electron", "zod", "sql.js", /^sql\.js\//, "node-pty"],
      },
    },
    resolve: {
      alias: {
        "@contracts": resolve("../../packages/contracts/src"),
        "@main": resolve("src/main"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // Two preload bundles:
      //  - index: the main window's preload (contextBridge API).
      //  - browserPicker: a minimal preload for the embedded browser
      //    WebContentsView, exposing only `window.mcodeBridge.pickElement`
      //    so the picker script (injected into the page's main world) can
      //    forward clicked elements to main without leaking any Node API.
      lib: { entry: { index: "src/preload/index.ts", browserPicker: "src/preload/browserPicker.ts" } },
      rollupOptions: { external: ["electron"] },
    },
    resolve: {
      alias: {
        "@contracts": resolve("../../packages/contracts/src"),
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      // Standard app mode (NOT lib mode): the renderer is loaded via
      // `window.loadFile()` and runs as a normal web page, so Vite must emit
      // the entry as a hashed ESM asset (`assets/index-xxxx.js`) referenced by
      // an external <script type="module">. lib mode would instead produce a
      // UMD bundle (`desktop.umd.cjs`) that <script type="module"> can't load
      // under file:// (wrong MIME: text/plain) and that violates the prod CSP.
      rollupOptions: {
        // Two HTML entries, two transports:
        //  - index: the full desktop/mobile-shell bundle (main.tsx).
        //  - pair: a dependency-free pairing page (pair.ts) served to phones
        //    that scan the QR link — a few KB instead of the full bundle.
        //    See main/mobile/serveMobileStatic.ts for the routing.
        input: {
          index: resolve("src/renderer/index.html"),
          pair: resolve("src/renderer/pair.html"),
        },
      },
    },
    resolve: {
      alias: {
        "@contracts": resolve("../../packages/contracts/src"),
        "@renderer": resolve("src/renderer"),
        // Monaco worker entries — alias the documented `esm/vs/...` import
        // paths straight to the on-disk files. Without this, monaco-editor's
        // `exports` wildcard re-maps them to a non-existent doubled path and
        // Vite's `?worker` resolver fails. The alias is path-prefix based, so
        // every worker import (`monaco-editor/esm/vs/.../x.worker?worker`)
        // lands at `${monacoPkgDir}/esm/vs/.../x.worker`.
        "monaco-editor/esm/vs": resolve(monacoPkgDir, "esm/vs"),
      },
    },
    // monaco-editor must be EXCLUDED from the dep optimizer: its worker
    // entries (`?worker` imports in monacoSetup.ts) can't be pre-bundled, and
    // including the package makes Vite route those imports into the (empty)
    // .vite/deps cache. Excluding lets the `?worker` imports flow through the
    // normal worker pipeline. The alias above still points them at the real
    // on-disk files.
    optimizeDeps: {
      exclude: ["monaco-editor"],
    },
    plugins: [
      react({
        babel: {
          plugins: [["babel-plugin-react-compiler", {}]],
        },
      }),
      precompressAssets(),
    ],
    worker: {
      // Monaco's workers are plain ESM modules; build them as ESM too so the
      // `?worker` imports resolve cleanly under Vite's worker pipeline.
      format: "es",
    },
  },
});
