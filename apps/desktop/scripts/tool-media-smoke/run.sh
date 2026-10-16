#!/usr/bin/env bash
# Headless smoke for the tool.media chain (script-generated inline video):
# SdkMessageAdapter's Bash-window video diff + lib/mediaDiff's rg inventory.
# Stubbed: logger, serviceScanner's window hooks, electron's app.getPath
# (rg then resolves from PATH — rg must be installed). See main.ts.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-tool-media-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/tool-media-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/tool-media-smoke/stub-logger.ts \
  --alias:@main/lib/serviceScanner.js=./scripts/tool-media-smoke/stub-service-scanner.ts \
  --alias:electron=./scripts/tool-media-smoke/stub-electron.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
