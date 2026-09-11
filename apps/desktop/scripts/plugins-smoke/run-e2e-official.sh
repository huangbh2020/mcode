#!/usr/bin/env bash
# E2E: parse a real marketplace checkout with the production plugin manager.
# Usage: run-e2e-official.sh <path-to-checkout>   (see e2e-official.ts)
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-plugins-e2e.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/plugins-smoke/e2e-official.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/store/repositories.js=./scripts/plugins-smoke/stub-repositories.ts \
  --outfile="$OUT/e2e.mjs" --log-level=error

HOME="$OUT/home" node "$OUT/e2e.mjs" "$1"
