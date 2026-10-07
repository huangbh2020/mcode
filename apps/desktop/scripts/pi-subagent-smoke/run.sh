#!/usr/bin/env bash
# Headless smoke for the Pi subagent coordinator
# (main/providers/pi-sdk/piSubagentRunner.ts): concurrency-bounded scheduling,
# REPLACE roster events, per-child transcript blocks, abort cascade, timeout,
# spawn-failure isolation, and the maxTasks cap — all against a stubbed
# spawnChild, so no model or Pi SDK is needed.
#
# Bundled with esbuild; piSubagentRunner has no runtime imports (types only),
# so the bundle is standalone. See main.ts for the covered scenarios.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d "$PWD/.pi-subagent-smoke-out.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/pi-subagent-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
