#!/usr/bin/env bash
# Headless smoke for the terminal-session feature (kind="terminal" PTY
# sessions). Electron-adjacent modules are aliased to stubs; node-pty itself
# runs REAL (the bundle is emitted INSIDE apps/desktop so createRequire
# resolves the workspace's node-pty with its NAPI prebuild) — section C
# spawns a real shell and asserts the initCommand injection round-trip.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Bundle must live under apps/desktop for node_modules resolution (see
# header) — NOT /tmp like the pure-module smokes.
OUT=$(mktemp -d ./scripts/terminal-session-smoke/.tmp-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/terminal-session-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/terminal-session-smoke/stub-logger.ts \
  --alias:@main/window.js=./scripts/terminal-session-smoke/stub-window.ts \
  --alias:@main/terminal/envRefresh.js=./scripts/terminal-session-smoke/stub-env-refresh.ts \
  --alias:@main/lib/binaryResolve.js=./scripts/terminal-session-smoke/stub-binary-resolve.ts \
  --alias:@main/store/repositories.js=./scripts/terminal-session-smoke/stub-repositories.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/terminal-session-smoke/stub-runtime-manager.ts \
  --alias:@main/lib/sessionSync.js=./scripts/terminal-session-smoke/stub-session-sync.ts \
  --alias:@renderer/lib/api.js=./scripts/terminal-session-smoke/stub-renderer-api.ts \
  --alias:@renderer/stores/sessionStore.js=./scripts/terminal-session-smoke/stub-session-store.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
