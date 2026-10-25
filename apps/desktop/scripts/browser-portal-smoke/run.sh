#!/usr/bin/env bash
# Headless smoke for the global portal-popup watcher
# (renderer/lib/browserPortalWatcher.ts) — the MutationObserver safety net
# that classifies portaled popups by ARIA role and drives the browser-view
# suppression. The watcher runs against the real browserOcclusion registry;
# only the session store is stubbed (counter discipline is asserted through
# the recorded calls).
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-browser-portal-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/browser-portal-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@renderer/stores/sessionStore.js=./scripts/browser-portal-smoke/stub-store.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
