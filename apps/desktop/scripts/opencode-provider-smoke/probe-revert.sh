#!/usr/bin/env bash
# LIVE probe for opencode conversation revision: two real turns (free Zen
# model) → provider.reviseConversation at the first turn → boundary-inclusive
# deletion + same-session promptability. Dev verification tool — not part of
# the assertion smoke (needs a live CLI + network).
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-opencode-revert.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/opencode-provider-smoke/probe-revert.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/opencode-provider-smoke/stub-logger.ts \
  --alias:@main/lib/mcpConfig.js=./scripts/opencode-provider-smoke/stub-mcp-config.ts \
  --alias:@main/lib/pathGuard.js=./scripts/opencode-provider-smoke/stub-path-guard.ts \
  --alias:cross-spawn=./scripts/opencode-provider-smoke/stub-cross-spawn.ts \
  --outfile="$OUT/probe.mjs" --log-level=error

node "$OUT/probe.mjs"
