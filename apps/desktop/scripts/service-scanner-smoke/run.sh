#!/usr/bin/env bash
# Headless smoke for the agent-service scanner (main/lib/serviceScanner.ts).
#
# Bundles scripts/service-scanner-smoke/main.ts with esbuild (tsconfig paths
# apply). Electron-adjacent modules (window push / mobile bus / logger /
# RuntimeManager) are aliased to local stubs; the scanner itself runs for
# real, including its platform snapshots (CIM/ps + netstat/lsof/ss) and the
# killProcessTree stop path. See main.ts for the covered scenarios.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-service-scanner-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/service-scanner-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/service-scanner-smoke/stub-logger.ts \
  --alias:@main/window.js=./scripts/service-scanner-smoke/stub-window.ts \
  --alias:@main/mobile/MobileEventBus.js=./scripts/service-scanner-smoke/stub-mobile-bus.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/service-scanner-smoke/stub-runtime-manager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
