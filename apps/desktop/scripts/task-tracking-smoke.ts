import assert from "node:assert/strict";
import { buildCustomEnv } from "../src/main/providers/claude-sdk/customEnv.js";
import { CLAUDE_TASK_TRACKING_NUDGE } from "../src/main/lib/systemPrompt.js";
import type { ApiConfig } from "@contracts/customModel";

console.log("Running task tracking smoke tests...");

// 1. Check customEnv injection
const testConfig: ApiConfig = {
  id: "cfg-1",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  protocol: "anthropic",
  apiKey: "sk-test",
  models: [{ id: "deepseek-chat", label: "DeepSeek Chat" }],
  selectedModel: "deepseek-chat",
};

const customEnv = buildCustomEnv(testConfig, { sessionId: "sess-1" });
assert.equal(
  customEnv.CLAUDE_CODE_ENABLE_TODO_TOOLS,
  "1",
  "CLAUDE_CODE_ENABLE_TODO_TOOLS must be '1' in customEnv",
);
console.log("✓ Test 1: customEnv injects CLAUDE_CODE_ENABLE_TODO_TOOLS=1");

// 2. Check systemPrompt nudge
assert.ok(
  CLAUDE_TASK_TRACKING_NUDGE.includes("TaskCreate"),
  "CLAUDE_TASK_TRACKING_NUDGE must mention TaskCreate",
);
assert.ok(
  CLAUDE_TASK_TRACKING_NUDGE.includes("TaskUpdate"),
  "CLAUDE_TASK_TRACKING_NUDGE must mention TaskUpdate",
);
console.log("✓ Test 2: CLAUDE_TASK_TRACKING_NUDGE contains TaskCreate & TaskUpdate guidance");

console.log("All task tracking smoke checks passed successfully!");
