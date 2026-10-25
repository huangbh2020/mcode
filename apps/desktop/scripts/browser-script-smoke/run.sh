#!/usr/bin/env bash
# Headless smoke for browser_script (agentBrowserTools.ts batch executor).
# The real tool chain runs; BrowserManager / electron / SettingRepo / logger /
# imageArtifacts / chromeRelay are esbuild-alias stubs backed by state.ts's
# recorder (the script path never uses backend:"chrome", so the relay is inert).
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-browser-script-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/browser-script-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:electron=./scripts/browser-script-smoke/stub-electron.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/browser-script-smoke/stub-manager.ts \
  --alias:@main/store/repositories.js=./scripts/browser-script-smoke/stub-settings.ts \
  --alias:@main/lib/logger.js=./scripts/browser-script-smoke/stub-logger.ts \
  --alias:@main/lib/imageArtifacts.js=./scripts/browser-script-smoke/stub-imageartifacts.ts \
  --alias:@main/browser/chromeRelay.js=./scripts/browser-script-smoke/stub-chromerelay.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
