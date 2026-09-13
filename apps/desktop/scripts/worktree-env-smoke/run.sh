#!/usr/bin/env bash
# Headless smoke for the session-environment scope of the IDE surfaces (see main.ts).
#
# Creates a real git repo + linked worktree with the git CLI, then bundles the
# REAL main-side guards (pathGuard + ipc/files' listDirGuarded) with esbuild and
# runs them against it. electron and the repositories module are aliased to
# stubs (stub-electron.ts / stub-repositories.ts) — no Electron, no sql.js, and
# no project on disk is touched.
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! command -v git >/dev/null 2>&1; then
  echo "git is required for this smoke" >&2
  exit 1
fi

OUT=$(mktemp -d /tmp/mcode-worktree-env-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/worktree-env-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:electron=./scripts/worktree-env-smoke/stub-electron.ts \
  --alias:@main/store/repositories.js=./scripts/worktree-env-smoke/stub-repositories.ts \
  --alias:@main/lib/logger.js=./scripts/worktree-env-smoke/stub-logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
