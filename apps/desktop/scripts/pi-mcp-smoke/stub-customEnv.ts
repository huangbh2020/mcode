/**
 * Stub for @main/providers/claude-sdk/customEnv.js — redirects Mcode's config
 * dir (home of ~/.mcode/.claude.json) into the smoke's data dir. The real
 * module pulls electron's app.getPath; the smoke only needs this constant.
 * Read from env (not a globalThis planted by main.ts) because ESM evaluates
 * imports before the entry's top-level code runs.
 */
import { join } from "node:path";

const dataRoot = process.env.PI_MCP_SMOKE_DATA;
export const MCODE_CONFIG_DIR = dataRoot ? join(dataRoot, "mcode") : "/tmp/pi-mcp-smoke-missing-mcode-dir";
