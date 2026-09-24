#!/usr/bin/env bash
# Headless smoke for the agent runtime update feature (docs/agent-runtime-update.md):
# compat-list loading/verdicts (runtimeCompat.ts), the manual check verdict
# matrix + versioned installs + compat gates + keep-2 retention + rollback
# (runtimeInstaller.ts), all through a stubbed globalThis.fetch serving fake
# registry metadata and real tgz fixtures.
#
# Bundled with esbuild (tsconfig paths apply). No electron / sqlite / network:
# `electron`, `@main/window.js` and `@main/lib/logger.js` are aliased to
# in-memory stubs; the managed runtime root points into a temp dir. The
# launch-probe gate runs the REAL spawn path against fixture binaries (win32:
# copies of process.execPath, optionally marker-appended; posix: shell
# scripts). See main.ts for the covered scenarios.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-runtime-update-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

export SMOKE_REPO_ROOT="$(cd ../.. && pwd)"

"$ESBUILD" scripts/runtime-update-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:electron=./scripts/runtime-update-smoke/stub-electron.ts \
  --alias:@main/window.js=./scripts/runtime-update-smoke/stub-window.ts \
  --alias:@main/lib/logger.js=./scripts/runtime-update-smoke/stub-logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
