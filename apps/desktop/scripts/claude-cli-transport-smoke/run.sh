#!/usr/bin/env bash
# Headless smoke for the direct Claude CLI transport: the real
# cliTransport / claudeCliQuery / hostMcpHttp / claudeExecutable modules
# driven against a fake `claude` process (fake-claude.mjs) that speaks the
# CLI's headless protocol. Covers the control-protocol round trips (tool
# approval, AskUserQuestion, plan dialog, elicitation, unknown kinds,
# cancel), host→CLI requests, failure shapes (error result, crash, abort,
# kill), the loopback MCP server, and the launch translation.
#
# No model, no network, no real claude needed.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-claude-cli-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/claude-cli-transport-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

FAKE_CLAUDE_JS="$(pwd)/scripts/claude-cli-transport-smoke/fake-claude.mjs" node "$OUT/smoke.mjs"
