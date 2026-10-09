#!/usr/bin/env bash
# Headless smoke for providers/pi-sdk/piBashTracker.ts (Pi-side live bash-task
# tracking: roster mirroring, live output, per-command stop, settle paths).
# The tracker's SDK import is type-only, so no stubs are needed.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-pi-bash-tracker-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/pi-bash-tracker-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
