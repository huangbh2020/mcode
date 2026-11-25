#!/usr/bin/env bash
# Headless smoke for the composer's remembered-entry merge policy
# (renderer/lib/composerMemory.ts): a "default" incoming binding never
# downgrades the remembered (model, customModelId) pair, a non-default pick
# upgrades it as a pair, and effort/permissionMode always take the incoming
# values. Pure function — no stubs needed.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-composer-memory-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/composer-memory-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
