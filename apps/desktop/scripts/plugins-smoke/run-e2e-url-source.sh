#!/usr/bin/env bash
# E2E: install real `{source:"url"}` entries (git repositories) from the
# official marketplace with the production plugin manager. Needs network.
# Usage: run-e2e-url-source.sh [count] [local-checkout-dir]   (see e2e-url-source.ts)
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-plugins-e2e-url.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/plugins-smoke/e2e-url-source.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/store/repositories.js=./scripts/plugins-smoke/stub-repositories.ts \
  --outfile="$OUT/e2e.mjs" --log-level=error

SMOKE_HOME="$OUT/home"
mkdir -p "$SMOKE_HOME"
# Both vars: win32 readers of os.homedir() use USERPROFILE, POSIX uses HOME.
HOME="$SMOKE_HOME" USERPROFILE="$SMOKE_HOME" node "$OUT/e2e.mjs" "${1:-3}" "${2:-}"
