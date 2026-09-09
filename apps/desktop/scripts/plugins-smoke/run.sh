#!/usr/bin/env bash
# Headless smoke for the plugin subsystem.
#
# Bundles scripts/plugins-smoke/main.ts with esbuild (tsconfig paths apply),
# aliasing @main/store/repositories.js to the in-memory stub so the manager
# runs without electron/sql.js, and redirecting HOME so ~/.mcode/plugins is
# a scratch dir. See main.ts for the covered scenarios.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-plugins-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/plugins-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/store/repositories.js=./scripts/plugins-smoke/stub-repositories.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

SMOKE_HOME="$OUT/home"
mkdir -p "$SMOKE_HOME"
HOME="$SMOKE_HOME" node "$OUT/smoke.mjs"
