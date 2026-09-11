#!/usr/bin/env bash
# Headless smoke for the per-turn MODEL record (see main.ts).
#
# Bundles scripts/model-anchor-smoke/main.ts with esbuild (tsconfig paths apply)
# and runs it in plain node with the shared session-store stub prelude. The
# store is driven through useSessionStore.getState().ingestEvent — the same
# entry point the IPC event stream uses — so the stamping chain is exercised for
# real rather than re-implemented by the test.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-model-anchor-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# Same monaco exclusion as session-store-smoke: the store's sole dynamic import
# drags in vite-only asset types and is never reached here.
"$ESBUILD" scripts/model-anchor-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
