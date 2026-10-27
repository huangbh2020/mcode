#!/usr/bin/env bash
# Headless smoke for the persistent-transport turn semantics: the adapter's
# logical turn end (result + no subagents + bounded bash patience) vs. the
# process-lifetime flushFinal, the feed-close idle signal, and cross-turn
# roster carryover. Stubbed: logger, serviceScanner's window hooks.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-settle-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/settle-transport-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/settle-transport-smoke/stub-logger.ts \
  --alias:@main/lib/serviceScanner.js=./scripts/settle-transport-smoke/stub-service-scanner.ts \
  --alias:electron=./scripts/settle-transport-smoke/stub-electron.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
