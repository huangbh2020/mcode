#!/usr/bin/env bash
# Headless smoke for main/lib/claudeTranscript.ts — the transcript-surgery
# half of conversation-level revision (edit / retract of sent messages):
# prompt-row identification across CLI versions (2.1.258's promptSource-only
# shape → 2.1.281+'s turnOrigin), LCS alignment through legacy edit-resend
# orphan rows, duplicate-text ordering, the timestamp floor, prefix
# compatibility of display text vs model prompt, positional fallback,
# tail cut / middle excision with parentUuid re-linking, serialization
# fidelity, and the wiped-empty detector. Pure module — no stubs needed.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-revise-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/revise-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
