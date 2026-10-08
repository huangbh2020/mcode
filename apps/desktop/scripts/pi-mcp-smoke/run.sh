#!/usr/bin/env bash
# Headless smoke for the Pi MCP bridge (main/providers/pi-sdk/piMcpBridge.ts):
# config mapping from Mcode's three MCP sources (user ~/.mcode/.claude.json,
# allowlist-gated project .mcp.json, management stash) — exposure forced to
# direct, project-over-user precedence, SSE/invalid entries degraded to errors
# — plus a REAL end-to-end registration: the SDK's built-in MCP extension
# connecting to a fixture stdio MCP server (newline-delimited JSON-RPC over
# stdio) and the tool surfacing as mcp__<server>__<tool> in the active tool
# list.
#
# Bundled with esbuild; @earendil-works/pi-coding-agent stays EXTERNAL (same
# as the main build) and resolves from dev node_modules. db / repositories /
# customEnv are aliased to in-memory stubs so the fixture files drive the
# config. See main.ts for the covered scenarios.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d "$PWD/.pi-mcp-smoke-out.XXXXXX")
DATA=$(mktemp -d "$PWD/.pi-mcp-smoke-data.XXXXXX")
trap 'rm -rf "$OUT" "$DATA"' EXIT
# Read by stub-customEnv at module-init (env is set before node starts —
# globalThis planted by main.ts would be too late, imports evaluate first).
export PI_MCP_SMOKE_DATA="$DATA"

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/pi-mcp-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/providers/pi-sdk/piMcpBridge.js=./src/main/providers/pi-sdk/piMcpBridge.ts \
  --alias:@main/store/db.js=./scripts/pi-mcp-smoke/stub-db.ts \
  --alias:@main/store/repositories.js=./scripts/pi-mcp-smoke/stub-repositories.ts \
  --alias:@main/providers/claude-sdk/customEnv.js=./scripts/pi-mcp-smoke/stub-customEnv.ts \
  --external:@earendil-works/pi-coding-agent \
  --outfile="$OUT/smoke.mjs" --log-level=error

# The bundled smoke resolves the fixture server via import.meta.url — put it
# next to the bundle.
cp scripts/pi-mcp-smoke/mcp-echo-server.mjs "$OUT/"

node "$OUT/smoke.mjs"
