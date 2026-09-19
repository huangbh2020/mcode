#!/usr/bin/env bash
# Headless smoke for the automation schedule math (contracts/automation.ts):
# computeNextRun across the six schedule kinds, the hand-rolled cron parser
# (steps/ranges/lists, dom+dow union rule, 7=Sunday, invalid inputs) and the
# AutomationSchedule zod schema boundaries. Pure functions — bundled with
# esbuild and run in Node, no stubs needed.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-automation-schedule-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/automation-schedule-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
