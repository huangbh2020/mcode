#!/usr/bin/env bash
# Headless smoke for main/browser/domainGate.ts (per-domain approval gate for
# agent browser navigation). The gate runs real; SettingRepo and logger are
# esbuild-alias stubs.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-browser-domain-gate-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/browser-domain-gate-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/store/repositories.js=./scripts/browser-domain-gate-smoke/stub-store.ts \
  --alias:@main/lib/logger.js=./scripts/browser-domain-gate-smoke/stub-logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
