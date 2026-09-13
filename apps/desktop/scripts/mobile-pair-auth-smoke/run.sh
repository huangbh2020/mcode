#!/usr/bin/env bash
# Headless smoke for the mobile pairing page's boot decision (see main.ts).
#
# Two esbuild passes: pair.ts is transpiled on its own (it must stay a separate
# module so main.ts can re-import it with a cache-busting query per scenario),
# then main.ts is bundled with tsconfig paths and run in plain node against a
# stubbed DOM/fetch. No electron, no browser, no server.
#
# The transpiled copy MUST keep the .mjs extension: Node caches a `.js` file
# loaded as CommonJS by path, so `?case=N` would stop re-evaluating boot()
# after the first scenario (silently — every later case then asserts against
# the previous case's DOM).
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-mobile-pair-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" src/renderer/pair.ts \
  --platform=node --format=esm --target=node22 \
  --outfile="$OUT/pair.mjs" --log-level=error

PAIR_MODULE_URL="file://$OUT/pair.mjs" "$ESBUILD" scripts/mobile-pair-auth-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

PAIR_MODULE_URL="file://$OUT/pair.mjs" node "$OUT/smoke.mjs"
