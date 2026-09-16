#!/usr/bin/env bash
# Headless smoke for the auto-decompose node-config pipeline:
# model surface build (pi/codex hydration + registry merge), planner prompt
# rendering, and the per-node provider/model/effort/permissionMode whitelist
# clamp. The REAL ipc/orchestrator.ts handler is bundled with esbuild; every
# runtime dependency (electron / SQLite / provider SDKs / agent SDK) is
# aliased to stubs.ts. No Electron, no DB, no network.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-orch-clamp-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/orch-planner-clamp-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --alias:@main/ipc/orchestrator.js=./apps/desktop/src/main/ipc/orchestrator.ts \
  --alias:@contracts/ipc=./packages/contracts/src/ipc.ts \
  --alias:@contracts/orchestration=./packages/contracts/src/orchestration.ts \
  --alias:@main/orchestrator/OrchestratorService.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/orchestrator/profiles.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/orchestrator/templates.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/store/repositories.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/providers/registry.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/lib/sessionStart.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/lib/sessionCwd.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/lib/secretStore.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/lib/piModelsStore.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/lib/codexModelsStore.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/providers/claude-sdk/customEnv.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/providers/claude-sdk/sdkBinaryPath.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/ipc/git.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@main/lib/logger.js=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --alias:@anthropic-ai/claude-agent-sdk=./scripts/orch-planner-clamp-smoke/stubs.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# Guard: the real agent SDK must not have been pulled into the bundle (its
# sdkCompat metadata is distinctive); the alias above must have replaced it.
if grep -q "sdkCompat" "$OUT/smoke.mjs"; then
  echo "real @anthropic-ai/claude-agent-sdk leaked into the bundle" >&2
  exit 1
fi

node "$OUT/smoke.mjs"
