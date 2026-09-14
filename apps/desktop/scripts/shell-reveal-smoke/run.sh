#!/usr/bin/env bash
# Headless smoke for the shell surfaces ("reveal in file manager" et al., see main.ts).
#
# Bundles the REAL `registerShellHandlers` with esbuild and drives its handlers
# against a temp-dir fixture. electron, the repositories module, the logger and
# the image-artifact registry are aliased to recording stubs — no Electron, no
# sql.js, nothing actually opens in the OS.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-shell-reveal-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/shell-reveal-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:electron=./scripts/shell-reveal-smoke/stub-electron.ts \
  --alias:@main/store/repositories.js=./scripts/shell-reveal-smoke/stub-repositories.ts \
  --alias:@main/lib/logger.js=./scripts/shell-reveal-smoke/stub-logger.ts \
  --alias:@main/lib/imageArtifacts.js=./scripts/shell-reveal-smoke/stub-imageArtifacts.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
