#!/usr/bin/env bash
# Headless smoke for the terminal Pi session importer
# (main/lib/piSessionImport.ts): fresh import + block-shape fidelity
# (thinking/text/tool_use/toolResult folding/images/compaction), resume
# handle on the session row, skip rules, idempotent re-scan, terminal delta
# growth, the turn.done baseline bump (anti-duplication for Mcode-run turns),
# delete-dismissal, shrink rebuild, and same-ms ordering.
#
# Bundled with esbuild. No electron / sqlite / Pi SDK: repositories,
# sessionSync, RuntimeManager, db and logger are aliased to in-memory stubs,
# and the sessions root is redirected via MCODE_PI_SESSIONS_DIR. See main.ts
# for the covered scenarios.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-pi-import-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/pi-import-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/piSessionImport.js=./src/main/lib/piSessionImport.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/pi-import-smoke/stub-runtime.ts \
  --alias:@main/store/repositories.js=./scripts/pi-import-smoke/stub-store.ts \
  --alias:@main/store/db.js=./scripts/pi-import-smoke/stub-db.ts \
  --alias:@main/lib/sessionSync.js=./scripts/pi-import-smoke/stub-sessionSync.ts \
  --alias:@main/lib/logger.js=./scripts/pi-import-smoke/stub-logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
