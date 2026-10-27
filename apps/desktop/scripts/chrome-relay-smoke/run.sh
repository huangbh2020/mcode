#!/usr/bin/env bash
# Headless smoke for main/browser/chromeRelay.ts (real-Chrome WS relay).
# The relay server + ws run REAL; a node ws client stands in for the
# mcode-connector extension. Electron/DB/window seams are esbuild-alias stubs.
# The bundle is written INSIDE apps/desktop (not a temp dir) because ws is
# --external and must resolve against the workspace node_modules at runtime.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT="scripts/chrome-relay-smoke/.smoke.mjs"
trap 'rm -f "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/chrome-relay-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:ws \
  --alias:electron=./scripts/chrome-relay-smoke/stub-electron.mjs \
  --alias:@main/store/repositories.js=./scripts/chrome-relay-smoke/stub-repo.mjs \
  --alias:@main/lib/logger.js=./scripts/chrome-relay-smoke/stub-logger.mjs \
  --alias:@main/window.js=./scripts/chrome-relay-smoke/stub-window.mjs \
  --outfile="$OUT" --log-level=error

node "$OUT"
