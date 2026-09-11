#!/usr/bin/env bash
# E2E: dead-proxy bypass for git clones (see e2e-proxy-fallback.ts).
# Requires direct GitHub connectivity on this machine.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-plugins-proxy.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/plugins-smoke/e2e-proxy-fallback.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/store/repositories.js=./scripts/plugins-smoke/stub-repositories.ts \
  --outfile="$OUT/e2e.mjs" --log-level=error

mkdir -p "$OUT/home"
# Scrub any real proxy vars so the dead ones in the script are the only source.
env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u all_proxy -u ALL_PROXY \
  HOME="$OUT/home" node "$OUT/e2e.mjs"
