#!/usr/bin/env bash
# Headless smoke for the Pi models.json store (main/lib/piModelsStore.ts):
# the saveProvider merge contract — form-managed fields (thinkingLevelMap /
# reasoning / maxTokens / name; provider authHeader) are cleared when the
# form omits them (the "off→不支持 改不回默认" bug), hand-written fields the
# form never edits (compat / cost / headers / api·baseUrl overrides /
# modelOverrides) survive, and the apiKey lifecycle (create-required /
# never-in-file / preserve-on-empty / replace / decrypt).
#
# Bundled with esbuild. No electron / sqlite: repositories, secretStore and
# logger are aliased to in-memory stubs, and the models.json path is
# redirected by pointing HOME/USERPROFILE at a temp dir. See main.ts.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-pi-models-store-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# Redirect os.homedir() so the store reads/writes a sandbox models.json.
export HOME="$OUT/home"
export USERPROFILE="$OUT/home"
mkdir -p "$HOME"

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/pi-models-store-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/piModelsStore.js=./src/main/lib/piModelsStore.ts \
  --alias:@main/store/repositories.js=./scripts/pi-models-store-smoke/stub-store.ts \
  --alias:@main/lib/secretStore.js=./scripts/pi-models-store-smoke/stub-secret.ts \
  --alias:@main/lib/logger.js=./scripts/pi-models-store-smoke/stub-logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
