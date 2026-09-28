#!/usr/bin/env bash
# Headless smoke for the "isolated" permission mode (project isolation):
# read-tool path extraction, the shared read-path guard decision, and the
# bash write-target guard now shared by both providers (Claude's canUseTool
# Bash branch was wired to it in the same change). Pure functions only —
# no stubs needed.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-project-isolation-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/project-isolation-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
