#!/usr/bin/env bash
# Headless smoke for the split-view (会话分屏) state machinery in the renderer
# session store: addToSplit/removeFromSplit guard chains, focus handoff,
# displayMode interplay, openSessionFromSidebar slot takeover, unread gating
# for on-screen panes, sendPrompt's row-scoped slot binding for non-active
# targets, the drainPromptQueueIfIdle gate, and parseSplitSessionIds
# hydration validation. See main.ts for the covered scenarios.
#
# Same skeleton as scripts/session-store-smoke: esbuild bundle (tsconfig
# paths apply) run in plain node with stubbed window/document/localStorage
# (prelude.ts); the api stub additionally CAPTURES claude.sendTurn calls.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-split-view-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# The store's sole dynamic import is monacoSetup (LSP worker bootstrap), which
# drags in the whole monaco bundle + ?worker/.ttf assets that only vite can
# resolve. No code path in this smoke reaches it.
"$ESBUILD" scripts/split-view-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
