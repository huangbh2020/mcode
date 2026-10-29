/**
 * Session forking logic — clone an existing session (and its messages / transcript)
 * to branch off into a new exploratory thread without polluting the original context.
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForkSessionInput } from "@contracts/ipc";
import type { MessageRecord, Session } from "@contracts/session";
import { uid } from "@main/utils.js";
import { log } from "@main/lib/logger.js";
import { ProjectRepo, SessionRepo, MessageRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { MCODE_CONFIG_DIR } from "@main/providers/claude-sdk/customEnv.js";
import { findClaudeProjectDir } from "@main/lib/claudeCli.js";
import {
  loadTranscript,
  alignPrompts,
  positionalPromptRow,
  planTailCut,
  serializeTranscript,
} from "@main/lib/claudeTranscript.js";

function extractUserRowText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const parts: string[] = [];
  for (const b of content) {
    if (
      b &&
      typeof b === "object" &&
      (b as { kind?: unknown }).kind === "text" &&
      typeof (b as { text?: unknown }).text === "string"
    ) {
      parts.push((b as { text: string }).text);
    }
  }
  return parts.join("\n");
}

export async function forkSession(input: ForkSessionInput): Promise<{ session: Session }> {
  const source = SessionRepo.get(input.sessionId);
  if (!source) {
    throw new Error(`Session not found: ${input.sessionId}`);
  }

  const project = ProjectRepo.get(source.projectId);
  if (!project) {
    throw new Error(`Project not found: ${source.projectId}`);
  }

  // List all messages in order
  const allMessages = MessageRepo.listBySession(source.id).messages;

  let keepMessages = allMessages;
  let targetIndex = allMessages.length - 1;

  if (input.messageId) {
    const rawId = input.messageId.replace(/^(plan_tail_|files_tail_|media_tail_)/, "");
    let idx = allMessages.findIndex((m) => m.id === input.messageId || m.id === rawId);
    if (idx < 0) {
      log.warn(`forkSession: message ${input.messageId} not found in DB, defaulting to full history`);
    } else {
      // Expand forward to include all trailing assistant messages of this turn
      // so the forked session always carries the complete answer/cards.
      let endIdx = idx;
      while (endIdx + 1 < allMessages.length && allMessages[endIdx + 1].role === "assistant") {
        endIdx++;
      }
      targetIndex = endIdx;
      keepMessages = allMessages.slice(0, targetIndex + 1);
    }
  }

  const newSessionId = uid("sess_");
  let newClaudeSessionId: string | null = null;

  // Clone Claude CLI transcript if available so the new session inherits full model context
  if (source.providerId === "claude-sdk" && source.claudeSessionId) {
    try {
      const cwd = source.worktreePath || project.path;
      const dir = findClaudeProjectDir(join(MCODE_CONFIG_DIR, "projects"), cwd);
      const srcFile = dir ? join(dir, `${source.claudeSessionId}.jsonl`) : null;

      if (srcFile && existsSync(srcFile)) {
        const rows = loadTranscript(srcFile);
        if (rows && rows.length > 0) {
          const generatedClaudeSessionId = randomUUID();
          const destFile = join(dir!, `${generatedClaudeSessionId}.jsonl`);

          if (targetIndex >= allMessages.length - 1) {
            // Full copy
            copyFileSync(srcFile, destFile);
            newClaudeSessionId = generatedClaudeSessionId;
          } else {
            // Partial copy: find cut point at the prompt AFTER the forked range
            const guiUserRows: { id: string; createdAt: number; text: string }[] = [];
            let lastUserRowIdxInGui = -1;
            for (let i = 0; i <= targetIndex; i++) {
              const m = allMessages[i];
              if (m.role === "user") {
                lastUserRowIdxInGui = guiUserRows.length;
                guiUserRows.push({
                  id: m.id,
                  createdAt: m.createdAt,
                  text: extractUserRowText(m.content),
                });
              }
            }

            const allGuiUserRows: { id: string; createdAt: number; text: string }[] = [];
            for (const m of allMessages) {
              if (m.role === "user") {
                allGuiUserRows.push({
                  id: m.id,
                  createdAt: m.createdAt,
                  text: extractUserRowText(m.content),
                });
              }
            }

            const nextUserGuiIdx = lastUserRowIdxInGui + 1;
            if (nextUserGuiIdx < allGuiUserRows.length) {
              const aligned = alignPrompts(allGuiUserRows, rows);
              const cutRowIdx =
                aligned.get(nextUserGuiIdx) ??
                positionalPromptRow(allGuiUserRows.length, nextUserGuiIdx, rows);

              if (cutRowIdx != null && cutRowIdx > 0) {
                const cutRows = planTailCut(rows, cutRowIdx);
                writeFileSync(destFile, serializeTranscript(cutRows), "utf8");
                newClaudeSessionId = generatedClaudeSessionId;
              } else {
                copyFileSync(srcFile, destFile);
                newClaudeSessionId = generatedClaudeSessionId;
              }
            } else {
              copyFileSync(srcFile, destFile);
              newClaudeSessionId = generatedClaudeSessionId;
            }
          }
        }
      }
    } catch (err) {
      log.warn(`forkSession: failed to clone Claude CLI transcript: ${(err as Error).message}`);
    }
  }

  const now = Date.now();
  const defaultTitle = `${source.title || "Chat"} (分叉)`;
  const newSession: Session = {
    id: newSessionId,
    projectId: source.projectId,
    providerId: source.providerId,
    claudeSessionId: newClaudeSessionId,
    kind: "chat",
    parentSessionId: source.id,
    title: input.title?.trim() || defaultTitle,
    status: "idle",
    model: source.model,
    effort: source.effort,
    permissionMode: source.permissionMode,
    customModelId: source.customModelId,
    archived: false,
    pinnedAt: null,
    contextSnapshot: source.contextSnapshot,
    todos: source.todos ? JSON.parse(JSON.stringify(source.todos)) : null,
    subagents: null,
    planDraft: source.planDraft ? JSON.parse(JSON.stringify(source.planDraft)) : null,
    usageHistory: source.usageHistory ? JSON.parse(JSON.stringify(source.usageHistory)) : null,
    turnFiles: null,
    envMode: input.useWorktree ? "worktree" : "local",
    wtStyle: input.useWorktree ? (source.wtStyle ?? "detached") : null,
    worktreePath: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: now,
    updatedAt: now,
  };

  const clonedMessages: MessageRecord[] = keepMessages.map((m) => ({
    id: uid("msg_"),
    sessionId: newSessionId,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
  }));

  SessionRepo.create(newSession);
  MessageRepo.replaceAll(newSessionId, clonedMessages);

  runtimeManager.bindSession(newSession);
  broadcastSessionChanged(newSession);
  log.info(`session ${source.id} forked to ${newSession.id} (${clonedMessages.length} messages copied)`);

  return { session: newSession };
}
