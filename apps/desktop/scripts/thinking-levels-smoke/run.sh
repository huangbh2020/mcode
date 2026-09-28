#!/usr/bin/env bash
# Headless smoke for the per-model thinking declarations (issue #10):
# contracts' inference/resolution/level-set pure functions, the save schema's
# thinking shape, the bridge's applyThinkingControl field emission, and
# buildCustomEnv's x-mcode-effort internal header. Pure functions — bundled
# with esbuild and run in Node, no stubs needed.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-thinking-levels-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/thinking-levels-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
