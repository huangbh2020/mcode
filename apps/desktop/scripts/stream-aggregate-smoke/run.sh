#!/usr/bin/env bash
# Headless smoke for the stream sidebar's aggregate cache under destructive
# mutations (delete / archive / pin / restore — see main.ts).
#
# Bundles the REAL sessionStore with esbuild and drives its actions in Node.
# The preload bridge (`@renderer/lib/api.js`) is aliased to a Proxy stub that
# records calls and serves canned main-process-shaped responses; everything
# else (zustand, i18n, worktree keys) is the real module. A banner provides
# the `window` global the renderer modules expect.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-stream-aggregate-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/stream-aggregate-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@renderer/lib/api.js=./scripts/stream-aggregate-smoke/stub-api.ts \
  --alias:@renderer/lib/monacoSetup.js=./scripts/stream-aggregate-smoke/stub-monacoSetup.ts \
  --banner:js="globalThis.window=globalThis.window||{};globalThis.navigator=globalThis.navigator||{userAgent:'node',maxTouchPoints:0};" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
