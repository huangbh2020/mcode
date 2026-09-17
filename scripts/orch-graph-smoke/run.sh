#!/usr/bin/env bash
# Headless smoke for the canvas drag-to-rewire pure-function layer
# (renderer/lib/orchGraph.ts). The module is pure — bundled directly, no
# stubs. See main.ts for the scenarios.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-orch-graph-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/orch-graph-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --alias:@renderer/lib/orchGraph.js=./apps/desktop/src/renderer/lib/orchGraph.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
