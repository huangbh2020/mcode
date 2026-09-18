#!/usr/bin/env bash
# Headless smoke for the terminal shell resolver's "is my setting honored?"
# answer (terminal/shellResolve.ts resolveEffectiveShell). The module under
# test is pure node — only its logger import is stubbed — so this needs no
# Electron, no node-pty and no DB. See main.ts for the assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-terminal-shell-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/terminal-shell-resolve-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --alias:@main/terminal/shellResolve.js=./apps/desktop/src/main/terminal/shellResolve.ts \
  --alias:@main/lib/binaryResolve.js=./apps/desktop/src/main/lib/binaryResolve.ts \
  --alias:@main/lib/logger.js=./scripts/terminal-shell-resolve-smoke/stubs.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
