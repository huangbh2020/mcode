/**
 * Auto thread-title generation.
 *
 * On the first user message of a new session (when the title is still the
 * default "New session"), the sendTurn handler fires this routine in the
 * background (fire-and-forget, never awaited) to ask an LLM for a short
 * Chinese summary of the user's prompt and overwrite the placeholder title.
 *
 * Mirrors the one-shot `query()` pattern from `git.ts:generateCommitMessage`:
 *  - 60s abort timeout, `maxTurns: 1`
 *  - custom-model resolution via `resolveModelForGitOp` (shared with
 *    the git ops), so OpenAI-protocol configs get their bridge activated too
 *  - fixed system prompt guarantees a clean, short, punctuation-free title
 *
 * Failure is silent (log.warn only): this runs off the critical path, and the
 * placeholder title from the existing truncate logic already covers the UI.
 */
import {
  IPC,
  UI_TITLE_GEN_ENABLED_SETTING_KEY,
  UI_TITLE_GEN_MODEL_SETTING_KEY,
} from "@contracts/ipc";
import type { Session } from "@contracts/session";
import { SessionRepo, SettingRepo } from "@main/store/repositories.js";
import { sendToRenderer } from "@main/window.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { resolveModelForGitOp } from "@main/ipc/git.js";
import { buildCustomEnv, resolveActiveModel } from "@main/providers/claude-sdk/customEnv.js";
import { resolveSdkBinaryPath } from "@main/providers/claude-sdk/sdkBinaryPath.js";
import { log } from "@main/lib/logger.js";

/** Fixed system prompt - never overridden. Guarantees a clean short title. */
const TITLE_GEN_SYSTEM_PROMPT = [
  "你是一个线程标题生成器。你的唯一职责是根据用户的首条消息,生成一个简短、准确概括消息主题的中文标题。",
  "",
  "严格输出约束:",
  "1. 只输出标题本身——不要任何前导语、解释、引号、标点符号(例如「这是标题:」「根据你的消息…」等一律禁止)。",
  "2. 不要使用 Markdown 代码块标记(```...)或其他包裹符号。",
  "3. 标题长度不超过 30 个字符,应当能让人一眼看懂该线程在讨论什么。",
  "4. 用中文输出,即使用户消息是其他语言。",
  "5. 完全基于用户消息的实际内容;消息中没有的信息不得臆造。",
].join("\n");

/**
 * Generate a short title for `session` from its first user prompt and persist
 * it. Returns the generated title, or `null` if generation was skipped or
 * failed (the caller's placeholder title remains in place).
 *
 * Safe to call unconditionally from `sendTurn`: if the feature is disabled in
 * settings, this returns `null` immediately with no LLM cost.
 */
export async function generateSessionTitle(
  session: Session,
  firstPrompt: string,
): Promise<string | null> {
  // 1. Feature gate. Default off — absent/unknown value means "do nothing".
  const enabled = SettingRepo.get(UI_TITLE_GEN_ENABLED_SETTING_KEY);
  if (enabled !== "on") return null;
  if (!firstPrompt.trim()) return null;

  // 2. Resolve the model config. There is no default model — generation only
  //    runs when an explicit "configId:modelId" was picked in settings;
  //    otherwise the placeholder title stays.
  const stored = SettingRepo.get(UI_TITLE_GEN_MODEL_SETTING_KEY);
  let customModelId: string | undefined;
  let customModelRole: string | undefined;
  if (stored) {
    const idx = stored.indexOf(":");
    if (idx > 0) {
      customModelId = stored.slice(0, idx);
      customModelRole = stored.slice(idx + 1);
    } else {
      customModelId = stored;
    }
  }
  if (!customModelId) return null;

  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000); // 60s timeout

  let releaseBridge: (() => void) | undefined;
  try {
    let model: string | undefined;
    let env: import("@anthropic-ai/claude-agent-sdk").Options["env"];

    const resolved = await resolveModelForGitOp(customModelId, customModelRole);
    if (!resolved.ok) {
      log.warn(`titleGen: model resolve failed for ${session.id}: ${resolved.error}`);
      return null;
    }
    releaseBridge = resolved.releaseBridge;
    const cfg = resolved.config;
    model = resolveActiveModel(cfg);
    env = buildCustomEnv(cfg);

    // Resolve the real on-disk binary path (unpacks from asar in a packaged
    // app). See git.ts:generateCommitMessage for the full rationale.
    const binaryPath = resolveSdkBinaryPath();

    const q = query({
      prompt: firstPrompt,
      options: {
        abortController: ac,
        maxTurns: 1,
        model,
        env,
        // Fixed system prompt guarantees a clean, short title.
        systemPrompt: TITLE_GEN_SYSTEM_PROMPT,
        settingSources: ["project", "local"],
        includePartialMessages: false,
        ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
      },
    });

    // 3. Collect the assistant's text response.
    let title = "";
    for await (const m of q) {
      if (m.type === "assistant") {
        const content = (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
        if (Array.isArray(content)) {
          title = content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
        }
      }
      if (m.type === "result") break;
    }

    clearTimeout(timer);
    if (!title.trim()) {
      log.warn(`titleGen: empty response for ${session.id}`);
      return null;
    }

    // Clean up: strip markdown code fences + collapse whitespace + hard cap.
    title = title
      .trim()
      .replace(/^```\w*\n?/, "")
      .replace(/\n?```$/, "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80);

    if (!title) return null;

    // 4. Persist + notify the renderer so the sidebar/tabs (or the side-chat
    //    ask tab) refresh. broadcastSessionChanged reaches connected MOBILE
    //    clients — side chats aren't managed there, so they only send the
    //    desktop push event.
    SessionRepo.updateTitle(session.id, title);
    sendToRenderer(IPC.SESSION_TITLE_UPDATED, {
      channel: IPC.SESSION_TITLE_UPDATED,
      sessionId: session.id,
      title,
    });
    const updated = SessionRepo.get(session.id);
    if (updated && updated.kind !== "side") broadcastSessionChanged(updated);
    log.info(`titleGen: generated title for ${session.id}: "${title}"`);
    return title;
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.warn(`titleGen: failed for ${session.id}: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
    releaseBridge?.();
  }
}
