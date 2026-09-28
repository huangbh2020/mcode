#!/usr/bin/env bash
# Headless smoke for the GitHub PR/issue client (main/github/GitHubClient.ts):
# git-remote URL parsing, closing-keyword issue linking, and the REST
# normalization / request-shaping layer through a stubbed globalThis.fetch.
#
# Bundled with esbuild (tsconfig paths apply). No electron / sqlite / network:
# @main/lib/logger.js, @main/lib/secretStore.js and
# @main/store/repositories.js are aliased to in-memory stubs — the store stub
# hands out a base64 token so the settings token path is deterministic (the
# `gh` CLI fallback is never exec'd). See main.ts for the covered scenarios.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-github-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/github-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/github-smoke/stub-logger.ts \
  --alias:@main/lib/secretStore.js=./scripts/github-smoke/stub-secrets.ts \
  --alias:@main/store/repositories.js=./scripts/github-smoke/stub-store.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
