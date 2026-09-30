#!/usr/bin/env bash
# Headless smoke for the project-level `.agent/skills` skill source (see
# apps/desktop/src/main/lib/agentSkills.ts + main/ipc/skills.ts): the
# injection probe (dir listing rules, hooks detection) and the list/read
# behavior for the new "agent" source — agent skills are DIRECTORY-named
# (the CLI registers plugin-adopted skills as `.agent:<dirName>`) and
# override same-named `.claude/skills` entries. repositories/logger/
# pluginManager are stubbed; no Electron, no DB, no SDK. See main.ts.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-agent-skills-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/agent-skills-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --alias:@main/ipc/skills.js=./apps/desktop/src/main/ipc/skills.ts \
  --alias:@main/lib/agentSkills.js=./apps/desktop/src/main/lib/agentSkills.ts \
  --alias:@main/lib/logger.js=./scripts/agent-skills-smoke/stubs.ts \
  --alias:@main/store/repositories.js=./scripts/agent-skills-smoke/stubs.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/agent-skills-smoke/stubs.ts \
  --alias:@contracts/ipc.js=./packages/contracts/src/ipc.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
