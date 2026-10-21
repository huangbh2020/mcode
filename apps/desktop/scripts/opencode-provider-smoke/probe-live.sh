#!/usr/bin/env bash
# One-off live probe against the real local opencode v2 server (dev tool —
# not part of the assertion smoke). Bundles probe-live.ts with the same stubs
# as the smoke (logger only) and runs it against the user's own CLI.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-opencode-probe.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/opencode-provider-smoke/probe-live.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/opencode-provider-smoke/stub-logger.ts \
  --alias:cross-spawn=./scripts/opencode-provider-smoke/stub-cross-spawn.ts \
  --outfile="$OUT/probe.mjs" --log-level=error

node "$OUT/probe.mjs"
