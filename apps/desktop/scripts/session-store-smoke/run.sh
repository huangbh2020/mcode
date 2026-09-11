#!/usr/bin/env bash
# Headless smoke for the renderer session store's `session.changed` reducer.
#
# Bundles scripts/session-store-smoke/main.ts with esbuild (tsconfig paths
# apply) and runs it in plain node with a stubbed window/document/localStorage
# (see prelude.ts). No electron, no React DOM — the store is exercised through
# useSessionStore.getState().ingestEvent, the same entry point the IPC event
# stream drives. See main.ts for the covered scenarios.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-session-store-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# The store's sole dynamic import is monacoSetup (LSP worker bootstrap), which
# drags in the whole monaco bundle + ?worker/.ttf assets that only vite can
# resolve. No code path in this smoke reaches it, so leave the specifier
# unresolved in the output rather than teaching esbuild monaco's asset graph.
"$ESBUILD" scripts/session-store-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
