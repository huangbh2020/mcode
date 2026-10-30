#!/usr/bin/env bash
# Headless smoke for main/lib/gitQueue.ts — the per-repo git operation mutex
# + stale index.lock recovery behind the git IPC handlers.
#
# Bundles scripts/git-queue-smoke/main.ts with esbuild (tsconfig paths apply).
# @main/lib/logger.js (the only electron-adjacent import) is aliased to a
# local stub so warning emissions are observable. REAL git runs for the
# end-to-end cases: stale-lock removal + retry on a temp repo, fresh-lock
# passthrough, submodule-shaped .git/modules/<sub>/index.lock extraction, and
# concurrent queued adds. See main.ts for the covered scenarios.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-git-queue-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# NOTE: cjs, not esm — simple-git's CJS helpers (@kwsites/file-exists) do
# dynamic require("fs"), which an esm bundle refuses. The smoke has no
# top-level await, so cjs is fine.
"$ESBUILD" scripts/git-queue-smoke/main.ts \
  --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/git-queue-smoke/stub-logger.ts \
  --outfile="$OUT/smoke.cjs" --log-level=error

node "$OUT/smoke.cjs"
