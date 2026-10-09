#!/usr/bin/env bash
# Headless smoke for main/lib/taskOutputFile.ts (task_notification.output_file
# reader for the「运行命令」settle-time output display). Pure module — no
# stubs needed.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-task-output-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/task-output-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
