#!/usr/bin/env bash
# Headless smoke for the OpenCode (v2) GUI provider: server config builder,
# permission-bridge decision core + ask handlers, message adapter
# (session.next.* deltas / tool lifecycle / idle turn-end / usage / subagents),
# model projection, MCP entry mapping, and the terminal-adoption exclusion.
#
# The SDK's runtime import (server manager) is bundled but never invoked — no
# opencode server is started. Electron-adjacent modules (logger /
# repositories / sessionSync) are aliased to local stubs.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-opencode-provider-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/opencode-provider-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/opencode-provider-smoke/stub-logger.ts \
  --alias:@main/store/repositories.js=./scripts/opencode-provider-smoke/stub-repositories.ts \
  --alias:@main/lib/sessionSync.js=./scripts/opencode-provider-smoke/stub-session-sync.ts \
  --alias:@main/lib/mcpConfig.js=./scripts/opencode-provider-smoke/stub-mcp-config.ts \
  --alias:@main/lib/pathGuard.js=./scripts/opencode-provider-smoke/stub-path-guard.ts \
  --alias:cross-spawn=./scripts/opencode-provider-smoke/stub-cross-spawn.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
