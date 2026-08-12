/**
 * Vite config for the mobile companion web bundle.
 *
 * This is a SEPARATE plain-SPA build (not part of electron-vite's main/
 * preload/renderer trio). It compiles `mobile/src` → `out-mobile/`, which the
 * main-process `MobileHttpServer` serves as static assets at the same origin
 * the mobile calls `/api/*` against (so there's no CORS).
 *
 * Build:   `pnpm build:mobile`  (see package.json)
 * Dev:     run this config directly with `vite -c mobile.vite.config.ts` and
 *          set `MCODE_MOBILE_DIST` to its dist so the desktop serves the live
 *          build. The HTTP server already allows the dev port's origin via
 *          `Access-Control-Allow-Origin: *`.
 *
 * The bundle reuses the workspace contracts (`@contracts/*`) for types and the
 * same Tailwind semantic tokens as the desktop renderer, so the two UIs share
 * one design language.
 */
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: resolve(__dirname, "mobile"),
  base: "./",
  // Same React + babel-plugin-react-compiler setup as the desktop renderer.
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", {}]],
      },
    }),
  ],
  resolve: {
    alias: {
      "@contracts": resolve(__dirname, "../../packages/contracts/src"),
      "@mobile": resolve(__dirname, "mobile/src"),
    },
  },
  build: {
    // Output inside `out/` so the bundle ships with the app via electron-
    // builder's existing `files: out/**/*` glob (no extraResources needed).
    // Resolved by serveMobileStatic.ts in both dev (cwd=out's parent) and prod
    // (__dirname = out/main/, so ../mobile = out/mobile).
    outDir: resolve(__dirname, "out/mobile"),
    emptyOutDir: true,
    // The bundle is served over LAN to phones — keep chunks few and small.
    target: "es2020",
    rollupOptions: {
      input: { index: resolve(__dirname, "mobile/index.html") },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
