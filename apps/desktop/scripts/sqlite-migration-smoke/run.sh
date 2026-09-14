#!/usr/bin/env bash
# Headless smoke for the sql.js → better-sqlite3 persistence migration.
#
# Bundles scripts/sqlite-migration-smoke/main.ts with esbuild (tsconfig paths
# apply, so @main/* and @contracts/* resolve) and runs it under plain node —
# which means the better-sqlite3 binary in node_modules must match the NODE
# ABI at this moment. After `node scripts/ensure-better-sqlite3-electron-abi.mjs`
# swaps in the Electron prebuild, this smoke can't run until the next
# `pnpm install` (that is by design: the runtime binary is Electron's).
#
# By default the smoke builds a synthetic database. To prove the legacy file
# loads, point it at a snapshot of the real one (never the live file itself —
# a running app owns it):
#
#   LIVE_DB="$APPDATA/@mcode/desktop/claude-gui.db" scripts/sqlite-migration-smoke/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# The bundle must live under the package so `require("better-sqlite3")`
# (kept external) resolves against apps/desktop/node_modules at runtime.
OUT_DIR="node_modules/.cache/sqlite-migration-smoke"
mkdir -p "$OUT_DIR"
SMOKE_OUT="$OUT_DIR/smoke.mjs"

"$ESBUILD" scripts/sqlite-migration-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --packages=external \
  --alias:electron=./scripts/sqlite-migration-smoke/stub-electron.ts \
  --outfile="$SMOKE_OUT" --log-level=error

SMOKE_SOURCE_DB="${LIVE_DB:-}" node "$SMOKE_OUT"
rm -f "$SMOKE_OUT"
