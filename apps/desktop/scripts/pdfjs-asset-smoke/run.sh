#!/usr/bin/env bash
# Headless smoke for the PDF preview's main-side asset pipeline
# (readPdfjsAssetGuarded + MEDIA_CONTENT_TYPES pdf entry + contract schema).
# The bundle is emitted INSIDE apps/desktop so the handler's
# createRequire(import.meta.url) resolves the workspace node_modules (same
# trick as terminal-session-smoke with node-pty).
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d ./scripts/pdfjs-asset-smoke/.tmp-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/pdfjs-asset-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:electron=./scripts/pdfjs-asset-smoke/stub-electron.ts \
  --alias:@main/lib/pathGuard.js=./scripts/pdfjs-asset-smoke/stub-pathguard.ts \
  --alias:@main/lib/logger.js=./scripts/pdfjs-asset-smoke/stub-misc.ts \
  --alias:@main/lib/rgSearch.js=./scripts/pdfjs-asset-smoke/stub-misc.ts \
  --alias:@main/lib/walkCache.js=./scripts/pdfjs-asset-smoke/stub-misc.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
