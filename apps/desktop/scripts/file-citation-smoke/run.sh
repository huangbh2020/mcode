#!/usr/bin/env bash
# Headless smoke for renderer/lib/fileCitation.ts (parser for model-emitted
# `::zcode-file-citation{…}` directives) and
# renderer/lib/markdownFileCitations.ts (placeholder restoration). Drives the
# real react-markdown pipeline on samples copied from stored replies —
# including the malformed single-colon directive from the original report.
# Pure modules — no stubs needed.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-file-citation-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# cjs bundle: react-dom/server is CommonJS with dynamic require("util") —
# the same reason git-queue-smoke builds cjs.
"$ESBUILD" scripts/file-citation-smoke/main.ts \
  --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.cjs" --log-level=error

node "$OUT/smoke.cjs"
