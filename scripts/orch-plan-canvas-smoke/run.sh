#!/usr/bin/env bash
# Headless smoke for the in-session decompose canvas wiring (renderer side):
# drives the REAL sessionStore.ingestOrchEvent with a synthetic plan.proposed
# event plus the @agents skeleton flow. Only @renderer/lib/api.js is aliased
# to stubs.ts — the store module itself is bundled unmodified. No Electron,
# no DB, no network. See main.ts for the scenario.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-orch-stream-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/orch-plan-canvas-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --alias:@renderer/stores/sessionStore.js=./apps/desktop/src/renderer/stores/sessionStore.ts \
  --alias:@renderer/lib/api.js=./scripts/orch-plan-canvas-smoke/stubs.ts \
  --alias:@renderer/lib/monacoSetup.js=./scripts/orch-plan-canvas-smoke/stubs.ts \
  --external:monaco-editor \
  --alias:@contracts/orchestration=./packages/contracts/src/orchestration.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
