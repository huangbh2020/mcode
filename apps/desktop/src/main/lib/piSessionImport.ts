/**
 * piSessionImport — surface terminal Pi sessions as regular Mcode sessions.
 *
 * The Pi CLI keeps every conversation as an append-only JSONL tree under
 * `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Mcode knows
 * nothing about those files, so a task discussed with Pi in the terminal is
 * invisible here and has to be re-explained from scratch. This module scans
 * that directory, matches files to known projects via the session header's
 * `cwd`, and imports each file as an ordinary chat session row
 * (provider "pi-sdk") plus its messages as regular DB rows — so the session
 * list, the transcript renderer, and search all work with zero frontend
 * changes.
 *
 * ## Resume
 * The GUI session's `claudeSessionId` slot (the provider-neutral
 * "provider session id") stores the pi session FILE PATH — the exact value
 * `PiAgentSdkProvider` feeds to `SessionManager.open()` on the next turn.
 * Importing therefore makes the session continuable for free: the first send
 * resumes the JSONL, the model sees the full terminal history, and pi keeps
 * appending to the same file.
 *
 * ## Freshness (delta sync)
 * Mcode turns on an imported session append to the SAME file the renderer
 * persists from — so DB rows and file entries overlap for everything Mcode
 * itself produced. A naive "re-import the file" would duplicate those turns.
 * The registry (`pi.sessionImports` settings key) therefore stores, per file,
 * the RAW entry count already accounted for:
 *  - fresh import      → session row + all entries converted; count = all.
 *  - file grew         → convert entries BEYOND the count (terminal-side
 *                        growth) and upsert them as new rows.
 *  - Mcode turn ended  → an observer (turn.done, debounced) re-parses the
 *                        file and advances the count WITHOUT importing —
 *                        the renderer already persisted those turns.
 *  - file shrank       → Pi rewrote it (migration/branch) → rebuild: delete
 *                        every `piimp-`-prefixed row of the session and
 *                        re-import from scratch (renderer rows survive).
 * A deterministic message id (`piimp-<piSessionId>-<entryId>`) keeps all of
 * this idempotent, and the same prefix is what the rebuild deletes.
 *
 * Deleting an imported session must not resurrect it on the next scan, so a
 * deleted row's file path moves to the registry's `dismissed` list.
 *
 * ## No SDK dependency
 * Parsing is hand-rolled (one JSON object per line, structural field reads)
 * so the scan works even when the managed Pi runtime isn't installed — the
 * SDK is only needed at RESUME time, by which point the user is actively
 * using Pi and has it installed.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { MessageRecord, Session } from "@contracts/session";
import { SessionRepo, MessageRepo, ProjectRepo, SettingRepo } from "@main/store/repositories.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { normPathKey } from "@main/lib/pathNorm.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { awaitDb } from "@main/store/db.js";
import { log } from "@main/lib/logger.js";

const IMPORT_SETTING_KEY = "pi.sessionImports";
/** Deterministic id prefixes — the same prefix marks imported rows for the
 *  rebuild path's targeted delete. Never collide with renderer uuids. */
const SESSION_ID_PREFIX = "piimp-";
const MESSAGE_ID_PREFIX = "piimp-";

/** One Pi session file, parsed from its first line (the header entry). */
interface PiFileHeader {
  type: string;
  version?: number;
  id?: string;
  cwd?: string;
  timestamp?: string;
}

/** Structural view of a Pi session entry. Only the fields the converter reads
 *  are declared; everything else (extensions, labels, …) is skipped. */
interface PiEntry {
  type: string;
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
    toolCallId?: string;
    isError?: boolean;
    details?: unknown;
    /** Assistant messages record the model that produced them. */
    provider?: string;
    model?: string;
  };
  name?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  /** model_change entries carry the switch target. */
  provider?: string;
  modelId?: string;
}

/** Minimal structural mirror of the renderer's Block union — just the kinds
 *  imported transcripts produce. MessageRecord.content is `unknown` in the
 *  contract, so these plain objects round-trip through the renderer's
 *  fromRecords untouched. */
type ImportBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool_use";
      toolCallId: string;
      toolName: string;
      input: unknown;
      status: "running" | "done" | "error";
      result?: unknown;
    }
  | { kind: "error"; message: string }
  | { kind: "image"; toolCallId?: string; data: string; mimeType: string }
  | { kind: "compact-summary"; trigger: "manual" | "auto"; preTokens: number; postTokens?: number };

/** Per-file import state (settings key `pi.sessionImports`). `entryCount` is
 *  the raw JSONL line count already accounted for — the boundary between
 *  "imported / renderer-persisted" history and new terminal growth. `v` is
 *  the {@link IMPORT_VERSION} the entry was last written at; entries without
 *  it predate the versioning and get a one-time re-import on the next scan. */
interface RegistryFileEntry {
  sessionId: string;
  entryCount: number;
  sizeBytes: number;
  v?: number;
}

/** Registry shape version — bump when the import output changes in a way
 *  existing rows must be RE-IMPORTED to pick up. v2 (2026-10-08): turnMeta
 *  wrapper on each turn's opener assistant row (drives the renderer's turn
 *  header + process collapse) and the picker-shaped model slot on the session
 *  row. Only sessions with `piimp-` rows re-import; native Mcode-created pi
 *  sessions (renderer-persisted rows) must not — re-importing their terminal
 *  entries would duplicate the transcript. */
const IMPORT_VERSION = 2;

interface PiImportRegistry {
  files: Record<string, RegistryFileEntry>;
  /** Session files whose GUI session the user deleted — never re-import. */
  dismissed: string[];
}

const EMPTY_REGISTRY: PiImportRegistry = { files: {}, dismissed: [] };

function loadRegistry(): PiImportRegistry {
  try {
    const raw = SettingRepo.get(IMPORT_SETTING_KEY);
    if (!raw) return { ...EMPTY_REGISTRY, files: {}, dismissed: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...EMPTY_REGISTRY, files: {}, dismissed: [] };
    const obj = parsed as Partial<PiImportRegistry>;
    return {
      files: obj.files && typeof obj.files === "object" ? obj.files : {},
      dismissed: Array.isArray(obj.dismissed) ? obj.dismissed.filter((p): p is string => typeof p === "string") : [],
    };
  } catch {
    return { ...EMPTY_REGISTRY, files: {}, dismissed: [] };
  }
}

function saveRegistry(reg: PiImportRegistry): void {
  try {
    SettingRepo.set(IMPORT_SETTING_KEY, JSON.stringify(reg));
  } catch (err) {
    log.error(`pi import: failed to persist registry: ${(err as Error).message}`);
  }
}

/** ~/.pi/agent/sessions — the same default the Pi CLI/SDK use. The env
 *  override exists for the headless smoke (and exotic agent-dir layouts). */
function piSessionsRoot(): string {
  const override = process.env["MCODE_PI_SESSIONS_DIR"];
  if (override && override.trim()) return override;
  return path.join(homedir(), ".pi", "agent", "sessions");
}

/** First line of a file without reading the whole thing (scan pass reads one
 *  line per candidate; full parses happen only for files being imported). */
function readFirstLine(filePath: string, maxBytes = 8192): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.toString("utf8", 0, bytes);
    const nl = text.indexOf("\n");
    const line = (nl >= 0 ? text.slice(0, nl) : text).trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Parse every JSONL line. Torn trailing lines (a crash mid-append) and
 *  malformed lines are skipped individually — the rest of the file stays
 *  usable. */
function parseEntries(filePath: string): PiEntry[] {
  const out: PiEntry[] = [];
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return out;
  }
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as PiEntry);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Longest-prefix project match: the session's cwd equals the project path or
 *  lives inside it (pi started in a subdirectory). Longest key wins so
 *  `a/b` beats `a` for a session started in `a/b/c`. Keys are normPathKey'd
 *  (separator + trailing-slash + case folding) on both sides. */
function matchProject(cwd: string, projects: Array<{ id: string; key: string }>): string | null {
  const key = normPathKey(cwd);
  let best: { id: string; len: number } | null = null;
  for (const p of projects) {
    if (key === p.key || key.startsWith(`${p.key}/`)) {
      if (!best || p.key.length > best.len) best = { id: p.id, len: p.key.length };
    }
  }
  return best?.id ?? null;
}

/** Timestamp → ms, clamped monotonic non-decreasing across the entry list:
 *  the list orders by (created_at, id), and entry ids are random hex, so two
 *  entries in the same millisecond could otherwise render swapped. */
function makeStamper() {
  let last = 0;
  return (iso: string | undefined): number => {
    const ms = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(ms) && ms > last) last = ms;
    return last;
  };
}

function firstTextOfUserMessage(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    const p = part as { type?: string; text?: unknown } | null;
    if (p && p.type === "text" && typeof p.text === "string" && p.text.trim()) return p.text.trim();
  }
  return null;
}

/** The model this session last ran on, as a picker-shaped "provider/modelId"
 * id. Pi has no default model — the composer's send guard (resolveSendModel)
 * blocks a pi session whose model slot is "default", so an imported row MUST
 * carry the model the terminal actually used or the session is view-only.
 * Prefers the last assistant message's recorded provider/model (what truly
 * produced replies); falls back to the last model_change entry (a switch with
 * no reply after it). Null when the file records neither. */
function lastModelOf(entries: PiEntry[]): string | null {
  let fromAssistant: string | null = null;
  let fromChange: string | null = null;
  for (const entry of entries) {
    if (entry.type === "model_change") {
      if (typeof entry.provider === "string" && typeof entry.modelId === "string" && entry.provider.trim() && entry.modelId.trim()) {
        fromChange = `${entry.provider.trim()}/${entry.modelId.trim()}`;
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (
      msg?.role === "assistant" &&
      typeof msg.provider === "string" &&
      typeof msg.model === "string" &&
      msg.provider.trim() &&
      msg.model.trim()
    ) {
      fromAssistant = `${msg.provider.trim()}/${msg.model.trim()}`;
    }
  }
  return fromAssistant ?? fromChange;
}

interface ConvertResult {
  records: MessageRecord[];
  /** session_info display name if one appeared (last wins). */
  infoName: string | null;
  /** First user message text — the title fallback. */
  firstUserText: string | null;
  /** toolCall ids announced but never answered in this slice (the owning
   *  tool_use block stays status "running" — mirrors a live interrupted
   *  turn). Logged for diagnosis; the next delta usually carries the result
   *  as an orphan we drop (see the converter's pending map). */
  unresolvedToolCalls: string[];
}

/** Convert Pi session entries into Mcode message records.
 *
 *  Mapping (mirrors what PiMessageAdapter produces live):
 *  - user message  → user row: text parts → text blocks, images → image blocks
 *  - assistant     → assistant row: thinking/text/toolCall → thinking/text/
 *                    tool_use blocks; stopReason "error" → trailing error block
 *  - toolResult    → folded INTO the matching tool_use block (status done/
 *                    error, result = the AgentToolResult wrapper `{ content,
 *                    details }` exactly as the live Pi tool.result reducer
 *                    stores it); result images become image blocks right
 *                    after the tool_use card
 *  - compaction    → synthetic assistant row with a compact-summary block
 *  - session_info / model_change / thinking_level_change / custom / label →
 *    skipped (session_info.name feeds the title instead)
 *
 *  `piSessionId` is the id from the file header — message ids are derived
 *  from it deterministically so re-imports upsert instead of duplicating. */
function convertEntries(
  piSessionId: string,
  entries: PiEntry[],
): ConvertResult {
  const records: MessageRecord[] = [];
  const stamp = makeStamper();
  let infoName: string | null = null;
  let firstUserText: string | null = null;
  /** tool_use blocks awaiting their toolResult, by toolCall id. */
  const pending = new Map<string, { blocks: ImportBlock[]; toolCallId: string }>();
  const unresolved: string[] = [];
  let seq = 0;

  // Turn grouping — mirrors what the live store does for native sessions.
  // The renderer folds a turn's process blocks into a collapsed TurnPanel
  // with a model/time/duration/steps header, keyed on the OPENER assistant
  // message carrying `turnMeta { startedAt, endedAt, model }` (ChatPane's
  // groupMessagesForRender: `isOpener = !!m.turnMeta`). Without it every
  // assistant row renders as a standalone expanded card — the "imported
  // sessions don't collapse" bug. A user message starts a turn; the FIRST
  // assistant record after it carries the meta (startedAt = its own ts —
  // native semantics are "first assistant block arrival", the user bubble
  // isn't part of the duration), endedAt = the turn's last assistant ts,
  // model = the last assistant message's recorded "provider/modelId".
  let openTurn: { recordIdx: number; startedAt: number; lastAt: number; model: string | null } | null = null;

  const closeTurn = (): void => {
    if (!openTurn) return;
    const rec = records[openTurn.recordIdx];
    if (rec) {
      rec.content = {
        blocks: rec.content,
        turnMeta: {
          startedAt: openTurn.startedAt,
          endedAt: openTurn.lastAt,
          ...(openTurn.model ? { model: openTurn.model } : {}),
        },
      };
    }
    openTurn = null;
  };

  const pushRecord = (role: MessageRecord["role"], blocks: ImportBlock[], createdAt: number, entry: PiEntry): void => {
    const id = entry.id ? `${MESSAGE_ID_PREFIX}${piSessionId}-${entry.id}` : `${MESSAGE_ID_PREFIX}${piSessionId}-#${seq}`;
    seq++;
    records.push({ id, sessionId: `${SESSION_ID_PREFIX}${piSessionId}`, role, content: blocks, createdAt });
    if (role !== "assistant") return;
    const m = entry.message;
    const model =
      typeof m?.provider === "string" && typeof m?.model === "string" && m.provider.trim() && m.model.trim()
        ? `${m.provider.trim()}/${m.model.trim()}`
        : null;
    if (!openTurn) {
      openTurn = { recordIdx: records.length - 1, startedAt: createdAt, lastAt: createdAt, model };
    } else {
      openTurn.lastAt = createdAt;
      if (model) openTurn.model = model;
    }
  };

  for (const entry of entries) {
    if (entry.type === "session_info") {
      if (typeof entry.name === "string" && entry.name.trim()) infoName = entry.name.trim();
      continue;
    }

    if (entry.type === "compaction") {
      const createdAt = stamp(entry.timestamp);
      const block: ImportBlock = {
        kind: "compact-summary",
        // The file doesn't record why a compaction ran — "auto" reads neutral.
        trigger: "auto",
        preTokens: typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0,
        ...(typeof entry.estimatedTokensAfter === "number" ? { postTokens: entry.estimatedTokensAfter } : {}),
      };
      pushRecord("assistant", [block], createdAt, entry);
      continue;
    }

    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || typeof msg !== "object") continue;
    const createdAt = stamp(entry.timestamp);

    if (msg.role === "user") {
      const blocks: ImportBlock[] = [];
      const content = msg.content;
      if (typeof content === "string") {
        if (content.trim()) blocks.push({ kind: "text", text: content });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          const p = part as { type?: string; text?: unknown; data?: unknown; mimeType?: unknown } | null;
          if (!p || typeof p.type !== "string") continue;
          if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
            blocks.push({ kind: "text", text: p.text });
          } else if (p.type === "image" && typeof p.data === "string" && typeof p.mimeType === "string") {
            blocks.push({ kind: "image", data: p.data, mimeType: p.mimeType });
          }
        }
      }
      if (blocks.length === 0) continue;
      if (!firstUserText) firstUserText = firstTextOfUserMessage(content);
      // A user message starts a new turn — seal the previous one's meta.
      closeTurn();
      pushRecord("user", blocks, createdAt, entry);
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: ImportBlock[] = [];
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          const p = part as { type?: string; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; arguments?: unknown } | null;
          if (!p || typeof p.type !== "string") continue;
          if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
            blocks.push({ kind: "text", text: p.text });
          } else if (p.type === "thinking" && typeof p.thinking === "string" && p.thinking.trim()) {
            blocks.push({ kind: "thinking", text: p.thinking });
          } else if (p.type === "toolCall" && typeof p.id === "string" && typeof p.name === "string") {
            blocks.push({
              kind: "tool_use",
              toolCallId: p.id,
              toolName: p.name,
              input: p.arguments ?? {},
              status: "running",
            });
          }
        }
      }
      // A terminal model failure the terminal UI showed as an error — surface
      // it the same way (error block) instead of ending the transcript blank.
      if (msg.stopReason === "error") {
        blocks.push({
          kind: "error",
          message:
            msg.errorMessage && msg.errorMessage.trim().length > 0
              ? msg.errorMessage
              : "模型调用失败,未返回内容",
        });
      }
      if (blocks.length === 0) continue;
      for (const b of blocks) {
        if (b.kind === "tool_use") pending.set(b.toolCallId, { blocks, toolCallId: b.toolCallId });
      }
      pushRecord("assistant", blocks, createdAt, entry);
      continue;
    }

    if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
      const target = pending.get(msg.toolCallId);
      if (!target) continue; // orphan result (call in an earlier slice) — nothing to attach it to here
      pending.delete(msg.toolCallId);
      const parts = Array.isArray(msg.content) ? msg.content : [];
      const result: Record<string, unknown> = { content: parts };
      if (msg.details !== undefined) result.details = msg.details;
      const block = target.blocks.find(
        (b): b is Extract<ImportBlock, { kind: "tool_use" }> =>
          b.kind === "tool_use" && b.toolCallId === msg.toolCallId,
      );
      if (!block) continue;
      block.status = msg.isError ? "error" : "done";
      block.result = result;
      // Result images ride as sibling image blocks right after the tool_use
      // card — the exact shape the live tool.result reducer produces.
      for (const part of parts) {
        const p = part as { type?: string; data?: unknown; mimeType?: unknown } | null;
        if (p && p.type === "image" && typeof p.data === "string" && typeof p.mimeType === "string") {
          const idx = target.blocks.findIndex(
            (b) => b.kind === "tool_use" && b.toolCallId === msg.toolCallId,
          );
          target.blocks.splice(idx + 1, 0, {
            kind: "image",
            toolCallId: msg.toolCallId,
            data: p.data,
            mimeType: p.mimeType,
          });
        }
      }
    }
  }

  // Seal the trailing turn (assistant records with no following user message).
  closeTurn();
  for (const id of pending.keys()) unresolved.push(id);
  return { records, infoName, firstUserText, unresolvedToolCalls: unresolved };
}

/** Derive the display title: Pi's session_info name, else the first user
 *  message excerpt, else a date stamp (sessions always carry a first user
 *  message in practice — the fallback is for header-only files). */
function deriveTitle(infoName: string | null, firstUserText: string | null, headerTs: number): string {
  if (infoName) return infoName;
  if (firstUserText) {
    const collapsed = firstUserText.replace(/\s+/g, " ").trim();
    if (collapsed) return collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed;
  }
  const d = new Date(headerTs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Pi ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Build the plain chat session row for a pi session file. */
function buildSessionRow(guiSessionId: string, projectId: string, filePath: string, title: string, createdAt: number, modifiedAt: number, model: string): Session {
  return {
    id: guiSessionId,
    projectId,
    providerId: "pi-sdk",
    // The pi session FILE PATH — PiAgentSdkProvider passes this to
    // SessionManager.open() on the next turn, which is what makes the
    // imported session continuable with its full terminal history.
    claudeSessionId: filePath,
    kind: "chat",
    parentSessionId: null,
    title,
    status: "idle",
    // The picker-shaped model id the terminal ran on ("provider/modelId") —
    // "default" would trip the pi send guard and make the session view-only.
    model,
    effort: "default",
    permissionMode: "default",
    customModelId: null,
    archived: false,
    pinnedAt: null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    usageHistory: null,
    turnFiles: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt,
    updatedAt: modifiedAt,
  };
}

interface ScanOutcome {
  imported: number;
  updated: number;
}

/** Sync one project-matched pi session file against the DB. Handles fresh
 *  import, delta growth, and shrink-triggered rebuild. "imported"/"updated"
 *  mean display-visible changes; "baseline" means only the registry watermark
 *  moved (no display change — the registry must still be saved). */
function syncSessionFile(
  filePath: string,
  projectId: string,
  header: PiFileHeader,
  reg: PiImportRegistry,
): "imported" | "updated" | "baseline" | "unchanged" {
  const piSessionId = header.id;
  if (!piSessionId) return "unchanged";
  const guiSessionId = `${SESSION_ID_PREFIX}${piSessionId}`;

  const stat = statSync(filePath);
  const entries = parseEntries(filePath);
  // entries[0] is the header itself; message-bearing sessions have >1 line.
  const bodyEntries = entries.slice(1);

  const known = reg.files[filePath];
  const existing = SessionRepo.get(guiSessionId);

  if (!known && existing) {
    // A pi session file that maps to an existing GUI row we have no registry
    // baseline for — i.e. Mcode CREATED this session (or a previous DB lost
    // the registry). Baseline at the current file state without importing:
    // the renderer already persisted every display row those turns produced.
    reg.files[filePath] = { sessionId: guiSessionId, entryCount: entries.length, sizeBytes: stat.size, v: IMPORT_VERSION };
    return "baseline";
  }

  if (known && !existing) {
    // The user deleted the imported session — remember the dismissal so the
    // next scan (and every future one) doesn't resurrect it.
    delete reg.files[filePath];
    if (!reg.dismissed.includes(filePath)) reg.dismissed.push(filePath);
    return "baseline";
  }

  const dismissed = reg.dismissed.includes(filePath);
  if (dismissed) return "unchanged";

  if (!existing) {
    // Fresh import. Skip header-only files: an empty terminal session has
    // nothing to show and would only pollute the list.
    if (bodyEntries.length === 0) return "unchanged";
    const headerTs = header.timestamp ? Date.parse(header.timestamp) : stat.birthtimeMs;
    const createdAt = Number.isFinite(headerTs) ? headerTs : Date.now();
    const converted = convertEntries(piSessionId, bodyEntries);
    if (converted.records.length === 0) return "unchanged";
    const title = deriveTitle(converted.infoName, converted.firstUserText, createdAt);
    const row = buildSessionRow(
      guiSessionId, projectId, filePath, title, createdAt, stat.mtimeMs,
      lastModelOf(bodyEntries) ?? "default",
    );
    SessionRepo.create(row);
    MessageRepo.upsertMany(converted.records);
    reg.files[filePath] = { sessionId: guiSessionId, entryCount: entries.length, sizeBytes: stat.size, v: IMPORT_VERSION };
    broadcastSessionChanged(row);
    log.info(
      `pi import: imported session ${piSessionId} (${converted.records.length} messages) from ${filePath}`,
    );
    return "imported";
  }

  // Known session.
  const prev = known;

  // One-time migration: a registry entry written by an older import shape
  // (no {@link IMPORT_VERSION} stamp) gets its `piimp-` rows re-imported so
  // they pick up the current output (v2: turnMeta wrapper → the renderer's
  // turn header + process collapse). Native Mcode-created pi sessions have
  // no `piimp-` rows — they only get the stamp, since re-importing their
  // terminal entries would duplicate the renderer-persisted transcript.
  // Silent (no import/update count): the toast reports NEW sessions, not
  // re-shapes; the log line is the audit trail.
  if (prev.v !== IMPORT_VERSION) {
    const hasImportedRows = MessageRepo.listBySession(guiSessionId).messages.some((m) =>
      m.id.startsWith(MESSAGE_ID_PREFIX),
    );
    if (hasImportedRows) {
      const converted = convertEntries(piSessionId, bodyEntries);
      MessageRepo.deleteByIdPrefix(guiSessionId, MESSAGE_ID_PREFIX);
      MessageRepo.upsertMany(converted.records);
      if (converted.infoName) SessionRepo.updateTitle(guiSessionId, converted.infoName);
      log.info(
        `pi import: re-imported ${piSessionId} (${converted.records.length} messages) at the current import shape (v${IMPORT_VERSION})`,
      );
    }
    reg.files[filePath] = { sessionId: guiSessionId, entryCount: entries.length, sizeBytes: stat.size, v: IMPORT_VERSION };
    return "baseline";
  }

  // Self-heal rows imported before the model slot was populated (or whose
  // file recorded no model then): a pi row sitting on "default" can never
  // send — the composer's guard demands an explicit model. One-time per row:
  // after the patch lands the check is a no-op string compare.
  if (existing.model === "default") {
    const model = lastModelOf(bodyEntries);
    if (model) {
      SessionRepo.updateSettings(guiSessionId, { model });
      const healed = SessionRepo.get(guiSessionId);
      if (healed) broadcastSessionChanged(healed);
      log.info(`pi import: healed model slot for ${piSessionId} → ${model}`);
    }
  }

  // Shrink (Pi rewrote the file: migration/branch) → rebuild
  // the imported rows from scratch; renderer-persisted rows survive (they
  // belong to turns that really ran).
  if (stat.size < prev.sizeBytes || entries.length < prev.entryCount) {
    const converted = convertEntries(piSessionId, bodyEntries);
    MessageRepo.deleteByIdPrefix(guiSessionId, MESSAGE_ID_PREFIX);
    MessageRepo.upsertMany(converted.records);
    if (converted.infoName) SessionRepo.updateTitle(guiSessionId, converted.infoName);
    reg.files[filePath] = { sessionId: guiSessionId, entryCount: entries.length, sizeBytes: stat.size, v: IMPORT_VERSION };
    log.info(
      `pi import: rebuilt session ${piSessionId} (${converted.records.length} messages) after file rewrite: ${filePath}`,
    );
    return "updated";
  }

  if (entries.length > prev.entryCount) {
    const slice = entries.slice(prev.entryCount);
    const converted = convertEntries(piSessionId, slice);
    if (converted.records.length > 0) {
      MessageRepo.upsertMany(converted.records);
      // A session_info rename inside the delta updates the title.
      if (converted.infoName) SessionRepo.updateTitle(guiSessionId, converted.infoName);
      SessionRepo.touch(guiSessionId);
      if (converted.unresolvedToolCalls.length > 0) {
        log.warn(
          `pi import: delta for ${piSessionId} has ${converted.unresolvedToolCalls.length} unanswered tool call(s); their results may arrive in a later slice`,
        );
      }
    }
    reg.files[filePath] = { sessionId: guiSessionId, entryCount: entries.length, sizeBytes: stat.size, v: IMPORT_VERSION };
    return converted.records.length > 0 ? "updated" : "baseline";
  }

  // Nothing new — just refresh the size watermark (no-op in the common case).
  if (stat.size !== prev.sizeBytes) {
    reg.files[filePath] = { ...prev, sizeBytes: stat.size };
    return "baseline";
  }
  return "unchanged";
}

let scanInFlight = false;
let lastScanAt = 0;
const SCAN_MIN_INTERVAL_MS = 5_000;

/** Scan the Pi sessions directory and import/sync everything that belongs to
 *  a known project. `projectId` narrows to one project (manual trigger);
 *  omit to consider all. Synchronous on purpose — the files are small and
 *  better-sqlite3 is sync anyway — but callers may fire-and-forget. */
export function scanPiSessions(projectId?: string): ScanOutcome {
  const outcome: ScanOutcome = { imported: 0, updated: 0 };
  const root = piSessionsRoot();
  if (!existsSync(root)) return outcome;

  const projects = ProjectRepo.list()
    .filter((p) => !projectId || p.id === projectId)
    .map((p) => ({ id: p.id, key: normPathKey(p.path) }));
  if (projects.length === 0) return outcome;

  const reg = loadRegistry();
  let changed = false;

  let dirNames: string[] = [];
  try {
    dirNames = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    log.warn(`pi import: failed to list ${root}: ${(err as Error).message}`);
    return outcome;
  }

  for (const dirName of dirNames) {
    const dirPath = path.join(root, dirName);
    let files: string[] = [];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const fileName of files) {
      const filePath = path.join(dirPath, fileName);
      const firstLine = readFirstLine(filePath);
      if (!firstLine) continue;
      let header: PiFileHeader;
      try {
        header = JSON.parse(firstLine) as PiFileHeader;
      } catch {
        continue;
      }
      if (header.type !== "session" || !header.cwd) continue;
      const projectIdMatch = matchProject(header.cwd, projects);
      if (!projectIdMatch) continue;
      try {
        const r = syncSessionFile(filePath, projectIdMatch, header, reg);
        if (r === "imported") outcome.imported++;
        else if (r === "updated") outcome.updated++;
        changed = changed || r !== "unchanged";
      } catch (err) {
        log.error(`pi import: failed to sync ${filePath}: ${(err as Error).message}`);
      }
    }
  }

  if (changed) saveRegistry(reg);
  if (outcome.imported > 0 || outcome.updated > 0) {
    log.info(`pi import scan: imported=${outcome.imported} updated=${outcome.updated}`);
  }
  return outcome;
}

/** Fire-and-forget scan with an in-flight guard + a minimum interval, safe to
 *  call from hot IPC paths (session list loads). */
export function scheduleScan(projectId?: string): void {
  const now = Date.now();
  if (scanInFlight || now - lastScanAt < SCAN_MIN_INTERVAL_MS) return;
  scanInFlight = true;
  lastScanAt = now;
  // Defer off the IPC reply path; the reply never waits on the scan.
  setTimeout(() => {
    scanInFlight = false;
    try {
      scanPiSessions(projectId);
    } catch (err) {
      log.error(`pi import scan failed: ${(err as Error).message}`);
    }
  }, 0);
}

/** Advance (or create) the per-file entry-count baseline after an Mcode turn
 *  appended to the file — the renderer already persisted those turns, so the
 *  entries must NOT be imported again. Debounced per session: entries keep
 *  landing until the provider disposes the session, so the bump only reads
 *  the file after turn.done has settled. */
const BUMP_DEBOUNCE_MS = 3_000;
const bumpTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleBump(guiSessionId: string): void {
  if (bumpTimers.has(guiSessionId)) return;
  const t = setTimeout(() => {
    bumpTimers.delete(guiSessionId);
    try {
      bumpBaseline(guiSessionId);
    } catch (err) {
      log.error(`pi import baseline bump failed for ${guiSessionId}: ${(err as Error).message}`);
    }
  }, BUMP_DEBOUNCE_MS);
  t.unref?.();
  bumpTimers.set(guiSessionId, t);
}

function bumpBaseline(guiSessionId: string): void {
  const session = SessionRepo.get(guiSessionId);
  if (!session || session.providerId !== "pi-sdk" || !session.claudeSessionId) return;
  const filePath = session.claudeSessionId;
  if (!filePath.endsWith(".jsonl") || !existsSync(filePath)) return;
  const stat = statSync(filePath);
  const entries = parseEntries(filePath);
  if (entries.length === 0) return;
  const reg = loadRegistry();
  const prev = reg.files[filePath];
  if (prev && prev.entryCount >= entries.length && prev.sizeBytes >= stat.size) return;
  // v stamped: everything up to here was persisted by the live renderer
  // (whose rows already carry the current shape) — a version-less write
  // would make the next scan treat the session as a stale import and
  // "migrate" it back over the renderer's rows.
  reg.files[filePath] = { sessionId: guiSessionId, entryCount: entries.length, sizeBytes: stat.size, v: IMPORT_VERSION };
  saveRegistry(reg);
}

/** Attach the turn.done observer that keeps baselines current for Mcode-run
 *  pi turns (imported OR natively created). */
function attachRuntimeObserver(): void {
  runtimeManager.addObserver((e) => {
    if (e.type !== "turn.done") return;
    try {
      const session = SessionRepo.get(e.sessionId);
      if (session?.providerId === "pi-sdk") scheduleBump(e.sessionId);
    } catch {
      /* observer contract: never throw into the event fan-out */
    }
  });
}

/** App-start hook: register the observer and run the first scan once the DB
 *  is ready. Fire-and-forget; failures never block startup. */
export function initPiSessionImport(): void {
  attachRuntimeObserver();
  void (async () => {
    try {
      await awaitDb();
      scanPiSessions();
    } catch (err) {
      log.error(`pi import: initial scan failed: ${(err as Error).message}`);
    }
  })();
}
