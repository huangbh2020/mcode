#!/usr/bin/env bash
# Headless smoke for the mobile payload optimizations: httpJson.ts (JSON RPC
# gzip negotiation) + sessionSync.toSlimSession (slim list rows). sessionSync
# imports sendToRenderer from @main/window.js, which pulls in electron — that
# one module is aliased to a local stub; everything under test runs for real.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-mobile-payload-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/mobile-payload-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/window.js=./scripts/mobile-payload-smoke/windowStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
