import { create } from "zustand";
import type { Project, Session, MessageRecord, SessionTodoItem, SessionPlanDraft, SessionBookmark } from "@contracts/session";
import type {
  RuntimeEvent,
  PermissionMode,
  EffortLevel,
  AskUserQuestionItem,
  ApprovalRequestEvent,
  PlanApprovalRequestEvent,
  PlanUpdateEvent,
  SubagentSnapshot,
  SubagentTranscriptBlock,
  ContextSnapshot,
  TurnUsageRecord,
  SessionListEntry,
} from "@contracts/runtime";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import type { ContentTag } from "@renderer/lib/contentTag.js";
import { isValidSnapshot } from "@renderer/lib/contextWindow.js";
import { getLastCursor, type NavEntry } from "@renderer/lib/editorNav.js";
import type { CustomModelPublic } from "@contracts/customModel";
import { api } from "@renderer/lib/api.js";
import { isElectron } from "@renderer/lib/platform.js";
import { normWorktreeKey } from "@renderer/lib/worktree.js";
import { translate } from "@renderer/lib/i18n/core.js";
import { DEFAULT_EDITOR_THEME_CHOICE, parseEditorThemeChoice, type EditorThemeChoice, type EditorThemeId } from "@renderer/lib/editorThemes.js";
import {
  DISPLAY_MODE_SETTING_KEY,
  UI_LOCALE_SETTING_KEY,
  DEFAULT_PROVIDER_ID,
  UI_CHAT_FONT_SIZE_SETTING_KEY,
  UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY,
  UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY,
  UI_USER_MSG_COLOR_SETTING_KEY,
  UI_ACCENT_COLOR_SETTING_KEY,
  UI_RIGHT_PANEL_TAB_SETTING_KEY,
  UI_VOICE_INPUT_MODE_SETTING_KEY,
  UI_VOICE_LANG_SETTING_KEY,
  UI_VOICE_ENGINE_SETTING_KEY,
  UI_VOICE_MIC_PERMISSION_SETTING_KEY,
  UI_VOICE_MODEL_DIR_SETTING_KEY,
  UI_IDE_OPEN_FILES_SETTING_KEY,
  UI_IDE_ACTIVE_FILE_SETTING_KEY,
  UI_IDE_EXPANDED_DIRS_SETTING_KEY,
  UI_IDE_EDITOR_MODE_SETTING_KEY,
  UI_GIT_DIFF_OPEN_MODE_SETTING_KEY,
  UI_COMMIT_GEN_MODEL_SETTING_KEY,
  UI_COMMIT_GEN_PROMPT_SETTING_KEY,
  UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY,
  UI_COMPOSER_MODEL_SETTING_KEY,
  UI_TITLE_GEN_ENABLED_SETTING_KEY,
  UI_TITLE_GEN_MODEL_SETTING_KEY,
  AGENT_OUTPUT_STYLE_SETTING_KEY,
  UI_GIT_COLLAPSED_REPOS_SETTING_KEY,
  UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY,
  UI_PANE_WIDTHS_SETTING_KEY,
  UI_PROJECT_VIEW_SETTING_KEY,
  UI_PROJECT_GROUPS_SETTING_KEY,
  UI_LAST_PROJECT_SETTING_KEY,
  UI_LAST_SESSION_SETTING_KEY,
  UI_SHORTCUTS_SETTING_KEY,
  UI_CHAT_DENSITY_SETTING_KEY,
  UI_EDITOR_THEME_SETTING_KEY,
  AUTO_ARCHIVE_SETTING_KEY,
  DEFAULT_AUTO_ARCHIVE_CONFIG,
  parseAutoArchiveConfig,
  SESSION_WORKTREE_DEFAULT_SETTING_KEY,
  WORKTREE_NAMES_SETTING_KEY,
  ShortcutBindingsSchema,
  type AutoArchiveConfig,
  type DisplayMode,
  type Locale,
  type VoiceInputMode,
  type VoiceEngine,
  type ChatDensity,
  type ProjectView,
  type ProjectGroupsMeta,
  type ProjectGroupMeta,
  type RightPanelTab,
  type IdeEditorMode,
  type GitDiffOpenMode,
  type FileViewMode,
  type CustomCommand,
  type SkillInfo,
  type ProviderInfo,
  type ShortcutBindings,
  type Accelerator,
  type LspLanguageState,
  type LspStateChangedPayload,
  type PickedElement,
  type BrowserDevicePreset,
  type BrowserOrientation,
} from "@contracts/ipc";

/** One browser tab, shared across the sidebar and overlay containers. `id` is
 *  renderer-local; `browserId` is the main-process view id. All
 *  navigation/loading/pick state is per-tab. Lives in the store (not component
 *  state) so the sidebar and overlay containers can swap without losing tabs. */
export interface BrowserTab {
  id: string;
  browserId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  pickMode: boolean;
  /** Device emulation preset (desktop = full width, mobile = narrow). */
  device: BrowserDevicePreset;
  /** Custom viewport width — set when device === "custom". */
  customWidth?: number;
  /** Custom viewport height — set when device === "custom". */
  customHeight?: number;
  /** Screen orientation (portrait/landscape). "landscape" swaps width/height
   *  when emulating. Defaults to "portrait" when absent. */
  orientation?: BrowserOrientation;
}
import type { BuiltinModelOption, UserInputAnswers } from "@contracts/provider";
import { useToastStore } from "@renderer/stores/toastStore.js";

/** True for `.md` / `.markdown` files - used to default the editor into preview
 *  mode on first open. Kept here (not in lib/path) because it's a content-type
 *  decision, not a pure path operation. */
function isMarkdownPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/** True for image files the editor previews via the `app-resource://` protocol.
 *  Mirrors `isImage()` in FileEditor.tsx - kept here so `openFileInIde` can
 *  default images into preview mode without importing the component. SVG is
 *  text but renders as an image, so it's included. */
function isImagePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return [
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
    ".svg", ".tif", ".tiff", ".avif",
  ].some((ext) => lower.endsWith(ext));
}

/** True for binary file types the editor can neither edit nor preview (Office
 *  docs, archives, binaries, audio/video, fonts, PDF). Mirrors `isUnsupported()`
 *  in FileEditor.tsx. These default to preview mode so the user sees the
 *  "can't preview" notice instead of garbled Monaco content. */
function isUnsupportedPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return [
    ".doc", ".docx", ".rtf", ".xls", ".xlsx", ".ppt", ".pptx",
    ".odt", ".ods", ".odp",
    ".zip", ".gz", ".tar", ".tgz", ".rar", ".7z", ".bz2", ".xz",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".jar", ".wasm",
    ".mp3", ".mp4", ".webm", ".avi", ".mov", ".ogg", ".flac", ".wav", ".m4a",
    ".db", ".sqlite", ".sqlite3",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".pdf",
  ].some((ext) => lower.endsWith(ext));
}

/* ───────────────────── editor navigation history ───────────────────── */
/* Alt+← / Alt+→ back/forward across editor jumps (goto-definition, file
 * switches). The stacks live in store state (per project, ephemeral); the
 * helpers below are shared by the actions. */

/** Max entries per stack (matches VS Code's navigation-history cap). */
const NAV_HISTORY_CAP = 50;

/** True when two history entries point at the same spot (path + 1-based
 *  line/column). Used to dedup consecutive pushes and to skip snapshotting a
 *  "current" location that equals the reveal target. */
function sameNavEntry(a: NavEntry, b: NavEntry): boolean {
  return a.filePath === b.filePath && a.line === b.line && a.column === b.column;
}

/** True while a navigateBack/navigateForward reveal is running. openFileInIde
 *  and setIdeActiveFile record the outgoing location into the back stack on
 *  user-initiated navigation; a history-driven reveal must NOT record (the
 *  history actions manage both stacks themselves). Set/cleared synchronously
 *  around the openFileInIde call. */
let navHistoryRevealing = false;

/** Snapshot the ACTIVE project's current location (active file + its
 *  last-known cursor) as a history entry, or null when no file is active.
 *  The cursor comes from lib/editorNav (module state, see its docs). A
 *  pending not-yet-consumed reveal targeting the active file wins: during a
 *  rapid Alt+← Alt+← sequence the EditPane hasn't mounted/consumed the first
 *  reveal yet, and that reveal target is the location being left. */
function currentNavEntryFor(get: () => SessionState): NavEntry | null {
  const pid = get().activeProjectId;
  if (!pid) return null;
  const file = get().ideActiveFileByProject[pid] ?? null;
  if (!file) return null;
  const pending = get().idePendingReveal;
  if (pending && pending.filePath === file) {
    return { filePath: file, line: pending.line, column: pending.column };
  }
  const cursor = getLastCursor(file) ?? { line: 1, column: 1 };
  return { filePath: file, ...cursor };
}

/** Whether `sid`'s chat counts as "on screen" for unread-badge / toast
 *  gating in ingestEvent: non-active sessions are never on screen; the
 *  active one is — UNLESS the unified center bar (tabs displayMode, not in
 *  wide-panel mode where ChatColumn still shows the chat) has handed the
 *  center to the editor, hiding the active session's pane behind it. In
 *  that state noteworthy events (turn done / approval needed) must badge
 *  and toast again, or they'd be silently missed. */
function isSessionChatOnScreen(
  sid: string,
  s: Pick<SessionState, "activeSessionId" | "displayMode" | "centerTabFocus" | "widePanelOpen">,
): boolean {
  if (sid !== s.activeSessionId) return false;
  return !(s.displayMode === "tabs" && s.centerTabFocus === "editor" && !s.widePanelOpen);
}

/** True when `sid` belongs to a loaded side chat (any parent's bucket in
 *  sideChatsByParent). Side chats live outside the left-bar lists, so the
 *  unread-badge / global-toast machinery must skip them entirely: the ask
 *  tab is their only surface. */
function isSideChatSession(sid: string, s: Pick<SessionState, "sideChatsByParent">): boolean {
  for (const list of Object.values(s.sideChatsByParent)) {
    if (list?.some((x) => x.id === sid)) return true;
  }
  return false;
}

/** Target for the mobile shell's fullscreen viewer overlay. The web (phone)
 *  shell has no editor column / PlanViewer, so chat-stream touchpoints
 *  (FileLink, TurnFilesCard rows, plan cards) redirect here instead:
 *  - file: read-only file content (text via readFile + shiki, images inline)
 *  - diff: frozen turn `before` vs the current on-disk content (lineDiff)
 *  - plan: plan markdown rendered read-only
 * Desktop never sets this (the Electron-only UIs consume those touchpoints). */
export type MobileViewerTarget =
  | { kind: "file"; name: string; path: string }
  | { kind: "diff"; name: string; path: string; /** Undefined only on cards
   * persisted by builds predating the snapshot field — the viewer degrades
   * to a plain file view then. */ before?: string }
  | { kind: "plan"; plan: string };

/** A single content block within a message (mirrors how claude structures output). */
export type Block =
  | { kind: "text"; text: string; /** Names of skill pills embedded inline in
    *  this text (from the rich-text composer). The Markdown renderer uses this
    *  to render the corresponding `/name` occurrences as styled pills so they
    *  read the same in the stream as they did in the composer. Empty/absent
    *  for plain-text messages. */
    skillNames?: string[] }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; toolCallId: string; toolName: string; input: unknown; status: "running" | "done" | "error"; result?: unknown }
  | { kind: "error"; message: string }
  | { kind: "turn-incomplete"; /** Mirrors TurnIncompleteEvent.kind —
    * "dangling-tools" = the turn closed with unanswered tool_use;
    * "empty-response" = tools ran but the model never replied with text. */
    incompleteKind: "dangling-tools" | "empty-response";
    /** Display names of the tool calls that never got a result
     *  ("dangling-tools" only). */
    pendingToolNames: string[] }
  | { kind: "attachment"; preview: string; content: string; attachmentKind?: "paste" | "file" | "quote"; filePath?: string }
  | {
      kind: "plan";
      /** Stable id for the in-turn live plan block — "current" while the turn
       *  is streaming (single live plan per turn). Lets the store upsert /
       *  replace on each plan.update without spawning duplicate blocks. When
       *  the turn ends the block is frozen in place (its planId stays). */
      planId: string;
      /** The plan markdown text drafted by the model (EnterPlanMode →
       *  ExitPlanMode). Empty during the initial drafting phase before the
       *  model has produced any plan content. */
      plan: string;
      /** Lifecycle phase mirrored from PlanUpdateEvent: "drafting" while the
       *  model is still composing, "ready" once ExitPlanMode is approved,
       *  "cleared" is transient (handled as a remove, never persisted on a
       *  frozen block). */
      phase: PlanUpdateEvent["phase"];
      /** True while an ExitPlanMode approval is pending — drives the 待审阅
       *  badge on the inline card so it mirrors the composer approval sheet. */
      hasApproval?: boolean;
    }
  | {
      kind: "turn-files";
      /** Stable id for the in-turn live turn-files block — "current" while the
       *  turn is streaming. Same pattern as the plan block's planId: lets the
       *  store upsert/replace on each turn.files event without spawning
       *  duplicates. Stays on the block after the turn freezes. */
      filesId: string;
      /** Files touched in this turn (filePath / kind / adds / dels / before).
       *  Mirrors TurnFileEntry verbatim — the same shape crosses the
       *  turn.files event, the persisted block, and the TurnFilesCard props,
       *  so the card renders identically live and from-DB. */
      files: TurnFileEntry[];
      /** True ONLY on the LATEST turn's card — gates whether the 撤销本轮
       *  button renders as the "live" rewind (clears the card on success).
       *  Demoted to false the moment a new turn opens; older cards are
       *  still rewindable individually (see `rewound`). */
      isLatestTurn?: boolean;
      /** True once this turn's files have been rewound. The card stays in
       *  the stream (the conversation record is preserved — mirroring SDK
       *  checkpoint semantics where file rollback never rolls back the
       *  conversation), but renders as a dimmed, non-interactive "已撤销"
       *  state. Set by the `turn.rewound` handler when `targetFiles`
       *  matches this card's paths. */
      rewound?: boolean;
    }
  | {
      kind: "compact-summary";
      /** What triggered the compaction - manual `/compact` or auto. */
      trigger: "manual" | "auto";
      /** Token count before compaction. */
      preTokens: number;
      /** Token count after compaction (may be absent). */
      postTokens?: number;
      /** How long the compaction took, in ms (may be absent). */
      durationMs?: number;
    }
  | {
      kind: "image";
      /** The tool_use whose screenshot produced this image. Present on
       *  tool-produced images (renders next to its tool_use card, dedup by
       *  replace); ABSENT on user-attached images (the composer's 图片/paste
       *  flow), which sit standalone on the user message. */
      toolCallId?: string;
      /** Base64-encoded image bytes (no data: prefix). */
      data: string;
      /** Image MIME type — "image/png" for browser screenshots; the SendTurn
       *  allowlist (jpeg/png/gif/webp) for user-attached images. */
      mimeType: string;
    };

/** Turn-level timing metadata. Attached to the FIRST assistant message of
 *  a turn (the one created when the first text.delta / thinking / tool.use
 *  arrives) so the renderer can show "started at · duration" once per turn,
 *  above that message. `endedAt` is set when `turn.done` (or `error`) lands;
 *  while undefined the turn is still running and the duration ticks live.
 *
 *  Persisted as part of the message snapshot, so the stats survive reload. */
export interface TurnMeta {
  /** Wall-clock ms when the turn started (first assistant block arrived). */
  startedAt: number;
  /** Wall-clock ms when the turn ended (turn.done / error). Undefined while
   *  the turn is still streaming — the renderer treats this as "live". */
  endedAt?: number;
}

/**
 * Extract ALL images (base64 + mimeType) from a tool_result's content. A single
 * tool result may carry multiple image blocks (e.g. a multi-screenshot capture
 * session). Handles all shapes that can reach the store:
 *  - MCP format (Pi extension tools + Claude in-process MCP handlers):
 *      `{ type: "image", data, mimeType }`
 *  - Anthropic API format (claude binary round-trips tool_result content
 *    through the Messages API, which represents images as):
 *      `{ type: "image", source: { type: "base64", media_type, data } }`
 *  - The content array itself may be nested one level: Anthropic wraps the
 *    tool_result content blocks inside an outer array —
 *    `[{ type: "tool_result", content: [{ type: "image", ... }] }]`. We peek
 *    one level into any `tool_result` block's `content` too.
 *  - Pi wrapper: the Pi adapter forwards the tool execute() return value
 *    verbatim as `event.result`, which is `{ content: [...], details: {} }`
 *    (the AgentToolResult shape), NOT the bare content array. We unwrap a
 *    top-level `.content` array when the payload itself isn't an array.
 *
 * Returns every image found (as base64 + mimeType), in document order. Empty
 * array if none. Used by the `tool.result` reducer to attach inline image
 * blocks (the Claude path); the Pi path emits a dedicated `browser.image`
 * event per screenshot instead.
 */
function extractImagesFromToolResult(content: unknown): { data: string; mimeType: "image/png" }[] {
  const out: { data: string; mimeType: "image/png" }[] = [];
  const scan = (blocks: unknown[]): void => {
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "image") {
        // MCP format: top-level data + mimeType.
        if (typeof b.data === "string" && typeof b.mimeType === "string") {
          out.push({ data: b.data, mimeType: "image/png" });
          continue;
        }
        // Anthropic format: nested source.{media_type, data}.
        const src = b.source as Record<string, unknown> | undefined;
        if (
          src &&
          typeof src === "object" &&
          typeof src.data === "string" &&
          typeof src.media_type === "string"
        ) {
          out.push({ data: src.data as string, mimeType: "image/png" });
        }
        continue;
      }
      // Anthropic may wrap the image inside a tool_result block's content.
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        scan(b.content);
      }
    }
  };
  // Claude path: content is the bare content-block array.
  if (Array.isArray(content)) {
    scan(content);
  } else if (content && typeof content === "object") {
    // Pi path: content is the AgentToolResult wrapper { content: [...], details }.
    const inner = (content as { content?: unknown }).content;
    if (Array.isArray(inner)) scan(inner);
  }
  return out;
}

/** One queued prompt: a fully-prepared turn payload held back while the
 *  session is busy. When the session goes fully idle the head of the queue
 *  is drained and replayed through the normal `sendPrompt` path (so the user
 *  message, attachments, and turn lifecycle are identical to a live send).
 *
 *  `prompt` is the composed text (typed text + inlined @path / paste blocks)
 *  the SDK receives; `displayText` is just the typed text shown in the user
 *  bubble so attachment content isn't duplicated; `attachments` mirror the
 *  composer's tags so the sent message keeps its chip cards. */
export interface QueuedPrompt {
  id: string;
  prompt: string;
  displayText: string;
  attachments?: PromptAttachment[];
  /** User-attached images (downsized, ready to send). Empty/absent = text-only. */
  images?: PromptImage[];
  /** Names of skill pills embedded in the queued text (for stream rendering). */
  skillNames?: string[];
  /** Rich blocks for the user bubble, replacing the default single text block
   *  (plan handoff renders "note + plan card" instead of the raw kickoff
   *  text — `displayText` still carries the queue card's preview line). */
  displayBlocks?: Block[];
}

/** Attachment payload shared by sendPrompt and the queue (kept loose here so
 *  the queue type doesn't depend on the store's private attachment shape). */
export interface PromptAttachment {
  preview: string;
  content: string;
  attachmentKind?: "paste" | "file" | "quote";
  filePath?: string;
}

/** Execution target picked in the plan-approval sheet's 执行方式 row.
 *  "remodel" = end the blocked turn, rebind THIS session's model, fire the
 *  plan as a fresh turn in the same thread (transcript context carries).
 *  "newSession" = end the blocked turn and hand the plan to a brand-new
 *  session (optionally another SDK) as its first prompt — context rebuilds
 *  from the plan document. Approving in place is NOT part of this union; it
 *  goes through submitPlanApproval. */
export type PlanHandoffTarget =
  | { kind: "remodel"; model: string; customModelId: string | null }
  | { kind: "newSession"; providerId: string; model: string; customModelId: string | null };

/** Compose the kickoff prompt that hands an approved plan to a (possibly
 *  different) executor. The plan text is embedded verbatim (the staged editor
 *  draft when one exists) because the receiving agent may have no transcript
 *  access to it — for the new-session path this prompt is the ONLY context
 *  that carries. Model-facing prompt text, deliberately NOT in the i18n
 *  dictionaries (AGENTS.md: only UI chrome is translated). */
function buildPlanKickoffPrompt(plan: string, feedback: string | undefined, sameThread: boolean): string {
  const lead = sameThread
    ? "下面的计划已经用户审批通过（可能经过编辑）。请在当前会话直接执行它，无需再次规划或征求确认："
    : "下面的计划来自另一个会话，已经用户审批通过（可能经过编辑）。请在本会话执行它：先按计划中列出的文件快速核对现状，再按步骤执行，无需再次规划或征求确认。";
  const parts = [lead, "", "<approved-plan>", plan, "</approved-plan>"];
  if (feedback) parts.push("", `执行时注意：${feedback}`);
  return parts.join("\n");
}

/** User-attached image payload shared by sendPrompt and the queue — already
 *  downsized to the SendTurn allowlist (base64 without the data: prefix). */
export interface PromptImage {
  data: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

/** A snapshot of the composer's unsent content for one session. Written
 *  through to the store on every change and restored when the session's
 *  ChatPane remounts (single-mode session switch, tab close/reopen), so the
 *  user's typed text + attachment chips survive thread switches.
 *
 *  `text` is the plain-text-with-skills mirror (drives the empty-state/send
 *  button); `html` is the Tiptap document HTML so skill pills round-trip on
 *  restore (`getHTML()`/`setContent()`); `tags` are the file/paste/element
 *  chips above the editor. NOT persisted — in-memory only, cleared when the
 *  draft is sent or the session is deleted. */
export interface ComposerDraft {
  text: string;
  html: string;
  tags: ContentTag[];
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  blocks: Block[];
  createdAt: number;
  /** Present only on the first assistant message of a turn. Drives the
   *  per-turn "开始时间 · 工作时长" stat row above the answer. */
  turnMeta?: TurnMeta;
}

/** A single todo item from claude's TodoWrite tool. */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

/** Per-session plan-mode draft for the activity capsule. `plan: ""` and
 *  `phase: "cleared"` means "not in plan mode" — the capsule drops the Plan
 *  section entirely. */
export interface PlanDraft {
  plan: string;
  phase: PlanUpdateEvent["phase"];
}

/** One open diff tab inside the Git diff dialog (the "dialog" open-mode).
 *  `id` is a stable client-side id used as the React key + dedup key; we reuse
 *  the absolute file path so re-clicking the same file refreshes its tab
 *  instead of opening a duplicate. */
export interface GitDiffDialogTab {
  /** Stable id. Working-tree: `${absPath}::staged|work`; history: absPath
   *  (or commit-scoped id from the history view). Used as the dedup key. */
  id: string;
  /** Absolute path of the file being diffed. */
  filePath: string;
  /** Original-side content (the "before" blob). */
  before: string;
  /** Modified-side content. When omitted, DiffPane reads the working-tree
   *  file from disk (working-tree diffs). History / staged diffs supply both. */
  after?: string;
  /** Short label for the tab (file basename). */
  title: string;
  /** Repo the file belongs to (for context / grouping). */
  repoPath: string;
  /** Where the diff came from - working tree vs a history commit. */
  source: "working" | "history";
  /** For working-tree diffs: whether this is the staged (index) side.
   *  Staged and unstaged views of the same file are distinct tabs. */
  staged?: boolean;
}

/** Composer working-environment choice (the chip above the textarea). The
 *  two worktree forms differ ONLY in what materialization creates — a
 *  detached checkout ("wt-detached", experimental verification) or a
 *  generated `mcode/*` branch ("wt-branch", real feature work). Also the
 *  persisted string format of settings key `session.worktreeDefault`. */
export type EnvChoice = "local" | "wt-detached" | "wt-branch";

export interface SessionState {
  /* ── projects & sessions (tree cache) ──
   * sessions are cached per-project so the left-bar tree can render every
   * project's threads without a round-trip per expand. `sessions` is kept
   * as a convenience alias for the active project's sessions. */
  projects: Project[];
  activeProjectId: string | null;
  /** Active (non-archived) sessions per project — paginated: only the first
   *  `SESSION_PAGE_SIZE` rows are loaded on init / project expand, and
   *  `loadMoreSessions(projectId)` appends the next page. `sessions` is kept
   *  as a convenience alias for the active project's loaded page. */
  sessionsByProject: Record<string, Session[]>;
  /** `true` when a project has more active sessions on the server than are
   *  currently loaded into `sessionsByProject[pid]`. Drives the "加载更多"
   *  affordance under the project's thread list. */
  sessionsHasMoreByProject: Record<string, boolean>;
  /** Total active-session count per project (server-side). Lets the UI show
   *  "还有 N 条" alongside the load-more button. */
  sessionsTotalByProject: Record<string, number>;
  /** Archived sessions per project (unpaginated). Powers the bottom "已归档"
   *  bin, which is now grouped by project rather than a flat dump. Only
   *  populated for projects that have ≥1 archived session. */
  archivedSessionsByProject: Record<string, Session[]>;
  /** Pinned non-archived sessions across ALL projects (most recent pin
   *  first), hoisted out of their project's active list into the left bar's
   *  global pinned section ABOVE the project tree. Loaded once at init via
   *  `session.listPinned` and maintained incrementally by the pin/archive/
   *  delete mutations and the cross-client `session.changed` reducer. */
  pinnedSessions: Session[];
  /** Sessions of the active project (derived view; components may read either). */
  sessions: Session[];
  activeSessionId: string | null;
  /** Which projects are expanded in the tree (UI-only, not persisted). */
  expandedProjects: Record<string, boolean>;
  /** Per-project left-bar VIEW: false (default) = local threads only,
   *  true = worktree groups. Flipped by the project row's fork toggle;
   *  auto-flipped (to true) when a worktree thread activates so the active
   *  row is always visible. UI-only, not persisted. */
  worktreeViewByProject: Record<string, boolean>;
  /** Which worktree group nodes are expanded in the tree (UI-only, keyed by
   *  normalized worktree path; not persisted). */
  expandedWorktrees: Record<string, boolean>;
  /** Left-bar display names for worktree directories (normalized path →
   *  name). Persisted in the `settings` table; cosmetic only — missing
   *  entries fall back to the directory basename. */
  worktreeNames: Record<string, string>;
  /** Whether the "archived" section at the bottom of the tree is expanded. */
  archivedViewOpen: boolean;

  /* ── tab state (center pane) ──
   *  `openTabs` is the ordered list of sessionIds the user has open in the
   *  center pane. In `single` displayMode the renderer only mounts the
   *  `activeSessionId` chat pane (so the list is mostly informational); in
   *  `tabs` mode the list drives the SessionTabs strip and switching
   *  between them is the primary way to navigate. We always write the
   *  list (regardless of mode) so flipping the mode switch never loses
   *  the user's open sessions. */
  openTabs: string[];
  /** How the center pane renders. Persisted in the `settings` table. */
  displayMode: DisplayMode;
  /** Which tab kind owns the center content area in `tabs` displayMode: the
   *  active session's chat ("chat") or the editor — file / plan tab
   *  ("editor"). Only read in `tabs` mode; `single` mode keeps the legacy
   *  chat|editor split and ignores it. UI-only (not persisted). Treat
   *  "editor" as effective only while the editor has content (an active file
   *  or an active plan tab); consumers fall back to "chat" at render time
   *  when it doesn't. */
  centerTabFocus: "chat" | "editor";
  /** UI language for all translated chrome. `"zh"` (the project's original
   *  language) is the default. Persisted in the `settings` table; components
   *  subscribe via `useI18n()` and re-render live when it flips. */
  locale: Locale;
  /** Session auto-archive rules (master switch + default inactivity days +
   *  per-project overrides). Persisted as JSON in the `settings` table under
   *  `session.autoArchive`; read fresh by the main-process AutoArchiver on
   *  every tick, so a change here takes effect within an hour. */
  autoArchiveConfig: AutoArchiveConfig;
  /** Chat message-stream vertical density. Persisted in the `settings` table
   *  under `ui.chatDensity`; applied to <html> as the --chat-row-gap-* /
   *  --chat-block-gap CSS vars by lib/appearance.ts. */
  chatDensity: ChatDensity;
  /** How the left bar renders projects. `"flat"` (default) is a plain list;
   *  `"grouped"` clusters them under collapsible headers keyed by
   *  `Project.group`. Persisted in the `settings` table. */
  projectView: ProjectView;
  /** Per-group metadata (color + display order), keyed by group name.
   *  Persisted as a JSON blob in the `settings` table. Groups themselves
   *  aren't a DB entity (they're derived from `Project.group`), so their
   *  metadata lives here. */
  groupMeta: ProjectGroupsMeta;
  /** Chat content font size in px (12–20). Persisted in the `settings`
   *  table. Applied to <html> as the --chat-font-size CSS var by
   *  lib/appearance.ts so it cascades into the message rows + markdown. */
  chatFontSize: number;
  /** Global side-panel + settings font size in px (10–22). Despite the
   *  legacy field name, this drives the whole app chrome: the left project
   *  bar, the right files/git/terminal panels, AND the settings page all
   *  inherit it. Persisted in the `settings` table. Applied to <html> as the
   *  --right-panel-font-size CSS var (plus --rp-fs-* derived variants) by
   *  lib/appearance.ts, and also fed to the xterm terminal fontSize. */
  rightPanelFontSize: number;
  /** Character threshold above which a paste is promoted to a content-tag
   *  chip (50–5000). Persisted in the `settings` table. Drives
   *  `shouldPromoteToTag` in contentTag.ts via the composer's
   *  shouldPromotePaste prop. */
  pasteTagThresholdChars: number;
  /** Default voice-input mode: "continuous" (click to start/stop dictation)
   *  or "pushToTalk" (hold the mic to talk, release to stop). Persisted in
   *  the `settings` table; the composer mic button reads it as its default
   *  and can flip it per-use. */
  voiceInputMode: VoiceInputMode;
  /** Default speech-recognition language tag (e.g. "zh-CN" | "en-US"). */
  voiceLang: string;
  /** Preferred ASR engine ("zipformer" streaming | "parakeet" offline). Falls
   *  back to zipformer when the chosen engine/model is unavailable. */
  voiceEngine: VoiceEngine;
  /** Cached mic-permission outcome: "granted" | "denied" | "". Empty until the
   *  user first attempts voice input. Surfaces a clear "grant access" mic
   *  state instead of a silent failure. */
  voiceMicPermission: string;
  /** Absolute path to the user-selected local ASR model directory (empty = not
   *  configured). The app never downloads models — the user fetches the files
   *  themselves and points Settings → 语音输入 → 模型目录 here. */
  voiceModelDir: string;
  /** Custom user-message background color as an "R G B" triplet string
   *  (e.g. "124 58 237"), or null to use the theme default. Persisted in
   *  the `settings` table. Applied to <html> as --user-bubble. */
  userMessageColor: string | null;
  /** Custom global brand/accent color as an "R G B" triplet string
   *  (e.g. "5 150 105"), or null to use the theme default. Persisted in
   *  the `settings` table. Applied to <html> as --accent, which cascades
   *  into the `accent` Tailwind token used by buttons, links, selected
   *  states, focus rings, and the prompt-card accents. */
  accentColor: string | null;
  /** Monaco editor color-scheme choice, one scheme id per app theme (the
   *  file editor + plan viewer follow the effective light/dark mode; the
   *  dark scheme applies in dark mode, the light one in light mode).
   *  Persisted as JSON in the `settings` table under `ui.editorTheme`;
   *  themes themselves are registered by lib/monacoSetup.ts from
   *  lib/editorThemes.ts. Consumed by FileEditor's useMonacoTheme(). */
  editorTheme: EditorThemeChoice;
  /** User's keyboard-shortcut overrides: commandId → Accelerator. Only the
   *  entries the user has rebound live here; every other command falls back
   *  to its compiled-in `defaultAccelerator` (see lib/shortcuts.ts). Persisted
   *  in the `settings` table as one JSON blob. Hydrated in `initDeferred`. */
  shortcutOverrides: ShortcutBindings;

  messagesBySession: Record<string, ChatMessage[]>;
  /** Whether older messages remain unloaded on the server, per session.
   *  `undefined`/absent = not yet determined (session never loaded); `true` =
   *  more history is available above the current head; `false` = all loaded. */
  hasMoreMessagesBySession: Record<string, boolean>;
  /** In-flight FIRST-PAGE history fetch, per session. True between the
   *  activation/prefetch fetch starting and its IPC round-trip landing.
   *  The ChatPane reads this (bucket undefined + loading) to show a
   *  skeleton instead of the empty-thread welcome while persisted history
   *  streams in — no more "blank composer, then content pops in" flash. */
  loadingMessagesBySession: Record<string, boolean>;
  /** In-flight "load older" request, per session. Guards against stacking
   *  concurrent paginated fetches when the user holds the scroll at the top. */
  loadingOlderBySession: Record<string, boolean>;
  /** Per-session "persisted history hydrated" flag. True ONLY after
   *  prefetchSessionMessages has merged the DB's first page into the bucket
   *  (or the session was created locally, whose history is empty by
   *  definition). Bucket EXISTENCE is not enough as the guard: ingestEvent
   *  creates partial buckets on the fly for sessions never opened locally
   *  (e.g. a turn driven from the mobile companion while the desktop app was
   *  running but the thread wasn't open) — such a bucket holds only the live
   *  event window, and letting it suppress the first-page fetch hides every
   *  earlier persisted message (sent from this PC in a previous run, or from
   *  the phone) until an app restart re-hydrates from the DB. */
  historyLoadedBySession: Record<string, boolean>;
  /** Per-session running flag. Keyed by sessionId so a turn running in
   *  thread A doesn't lock the composer in thread B — the user can keep
   *  composing / inspecting other threads while a background turn streams.
   *  `false` / missing entry = idle. Reads should go through the
   *  `isRunningForActiveSession` selector below (or compute on the fly)
   *  so consumers always see "am I running?" relative to the active thread. */
  runningBySession: Record<string, boolean>;
  /** Per-session wall-clock ms stamped at send time - the time anchor for the
   *  "开始 · 用时" stat row BEFORE the first assistant content block arrives.
   *  Without this, the stat row only appears when the first delta/tool/plan
   *  lands (which can lag send by seconds while the model "thinks"), leaving
   *  the user with no running feedback. The three isNewTurn stamping sites
   *  (flushDeltas / tool.use / upsertLivePlanBlock) fall back to this value
   *  so the real turnMeta.continues the synthesized row's timing seamlessly.
   *  NOT persisted - it's transient: cleared on turn.done / error / interrupt
   *  / session delete, alongside runningBySession. */
  runningTurnStartedAt: Record<string, number>;
  /** Per-session "用户已手动停止"哨兵。interrupt() 置位,下一个真正启动的
   *  turn (sendPrompt / editAndResendMessage) 清除。存活期间,迟到的
   *  subagent.update / turn.done 不得复活 running 子代理或保留 running roster
   *  -- 用户的中断是权威意图。NOT persisted - 仅内存态,随 deleteSession
   *  一并清理。 */
  interruptedBySession: Record<string, boolean>;
  /** Per-session "turn ended but the work didn't finish" flag. Set by
   *  `turn.incomplete` (gateway returned an empty final response — the turn
   *  closed with dangling tool_use or no reply text); consumed by the very
   *  next turn.done, which then skips its misleading "回合完成" toast/unread
   *  bump (the turn.incomplete case already toasted a warning). Lifetime is
   *  effectively milliseconds — the adapter always emits turn.incomplete
   *  immediately before turn.done. NOT persisted. */
  turnIncompleteBySession: Record<string, boolean>;
  /** Per-session transient upstream-network issue (the OpenAI bridge's retry
   *  loop: connect timeout / reset / refused — see UpstreamIssueEvent). Set on
   *  `upstream.issue{kind:"retry"}`; cleared on kind:"ok", turn end (turn.done
   *  / error), interrupt, session delete, and a decay timer (a retry that goes
   *  quiet without any terminal event must not pin the hint forever). The chat
   *  renders it beside the streaming spinner so a 10s+ mid-turn stall is
   *  explained instead of looking like a hang. NOT persisted — live feedback. */
  upstreamIssueBySession: Record<string, { cause: string; attempt: number; attempts: number }>;
  /** Per-session unread event counter. Incremented in `ingestEvent` whenever a
   *  noteworthy event (turn done, error, blocking approval/question, background
   *  subagent completion) arrives for a session that is NOT the active session.
   *  Cleared to 0 when the user selects/opens that session (selectSession /
   *  openTab). Drives the red dot badge in the left bar + tab strip. NOT
   *  persisted - unread state is transient and shouldn't survive a restart. */
  unreadBySession: Record<string, number>;
  /** Per-repo git-change version, bumped by the `git.changed` runtime event
   *  (broadcast by the main process after ANY client's commit / stage /
   *  unstage / push / pull / discard / checkout). Git surfaces (mobile Git
   *  screen, desktop GitRepoCard, GitHistoryView) select the counter for the
   *  repo they're viewing and re-fetch when it moves — so a commit on the
   *  phone refreshes the desktop panel and vice versa, with no polling. NOT
   *  persisted — a missed bump just means one manual refresh. */
  gitChangeVersionByRepo: Record<string, number>;
  /** Whether the main window is currently focused (frontmost + not minimized +
   *  the renderer tab is visible). Fed from the Electron `window:focusChanged`
   *  push event + `document.visibilitychange`. The notification layer reads
   *  this to decide between an OS notification (window unfocused) vs an in-app
   *  toast (window focused). NOT persisted. */
  isWindowFocused: boolean;
  claudeInstalled: boolean | null;
  /** Settings modal visibility (opened from the LeftBar ⚙ footer and the CLI-missing CTA). */
  settingsOpen: boolean;
  /** Initial settings section to land on when the modal opens. Callers that
   *  know which section the user wants (e.g. the composer's "管理模型…"
   *  entry → "custom-models" / "pi-models") pass it to setSettingsOpen; null
   *  means "use the default section". Cleared on close. */
  settingsSection: string | null;
  /** "尚未配置模型" dialog visibility. Opened by sendPrompt / editAndResendMessage
   *  when the active provider has no configured model to send with (model is
   *  auto/"default" and nothing is configured). NOT persisted. */
  modelConfigPromptOpen: boolean;
  /** Command palette (Cmd/Ctrl+K) visibility. Toggled by the global hotkey
   *  wired in App.tsx and by any in-app "command palette" affordance. The
   *  palette itself (CommandPalette.tsx) reads this to mount/unmount. */
  commandPaletteOpen: boolean;
  /** File search dialog visibility. Opened from the Files panel search
   *  button, the `files.search` command, or the Cmd/Ctrl+Shift+F hotkey.
   *  The dialog (SearchDialog.tsx) reads this to mount/unmount. NOT persisted. */
  searchDialogOpen: boolean;
  /** Left sidebar visibility. Lifted from App.tsx local state so the
   *  command palette (and other store consumers) can toggle it. Workspace-only
   *  — the settings view pins it open. NOT persisted (matches original behavior). */
  leftOpen: boolean;
  /** Right (IDE) panel visibility. Lifted from App.tsx local state. NOT persisted.
   *  `ideFocusNonce` bumps still drive this to `true` (the App effect now
   *  calls setRightOpen(true) instead of touching local state). */
  rightOpen: boolean;
  /** Bottom terminal bar visibility. Lifted from App.tsx local state. NOT
   *  persisted. The bar stays mounted (keep-alive) regardless; this only
   *  controls whether it's expanded. */
  bottomTerminalOpen: boolean;
  /** Browser panel visibility. When true the BrowserPanel overlay mounts over
   *  the workspace and the embedded WebContentsView is shown; false hides both.
   *  NOT persisted (pure in-memory, like the other layout flags). */
  browserPanelOpen: boolean;
  /** Wide-panel (3:7) mode: hides the left sidebar + center editor so the
   *  workspace shows only the chat column (3) and the full right panel (7).
   *  Toggled from the right-panel rail fullscreen button / command palette.
   *  While on, the left sidebar can't be opened. NOT persisted (transient,
   *  like the other layout flags); on exit the pre-enter layout state is
   *  restored from widePanelSnapshot. */
  widePanelOpen: boolean;
  /** Right-panel share (%) of the wide-panel chat|right split; the chat column
   *  gets the remainder. Default 70 → the requested 3:7. Draggable via the
   *  split's Divider; double-click resets to the default. In-memory only. */
  widePanelPct: number;
  /** Layout state captured when wide-panel mode opened, restored on exit.
   *  rightPanelTab is deliberately NOT snapshotted — tab switches the user
   *  makes while in wide mode are respected on exit. */
  widePanelSnapshot: { leftOpen: boolean; rightOpen: boolean; rightWidth: number } | null;
  /** Number of open browser tabs (mirrors BrowserPanel's local tabs state so
   *  the Titlebar toggle button can show a count badge). Updated by the panel
   *  via setBrowserTabCount. NOT persisted. */
  browserTabCount: number;
  /** Device-toolbar visibility in the browser panel (the DevTools-style bar
   *  under the address bar with the device dropdown + custom dims + rotate).
   *  Toggled by the 📱 button in BrowserToolbar; a per-session in-memory flag
   *  (NOT persisted) like the other browser layout state. */
  browserDeviceToolbarOpen: boolean;
  /** Open browser tabs, shared between the sidebar (mobile-first) and overlay
   *  (PC fullscreen) containers. Each owns a main-process WebContentsView by
   *  browserId; the view pool survives container swaps. NOT persisted. */
  browserTabs: BrowserTab[];
  /** The currently active browser tab id (shared across containers). */
  browserActiveTabId: string | null;
  /** A URL staged by an external entry (e.g. file-tree "open in browser") to
   *  be loaded into the browser panel when no tab exists yet. BrowserPanel's
   *  first-tab effect consumes and clears it. NOT persisted. */
  pendingBrowserUrl: string | null;
  /** Suppression counter for the embedded browser's OS-level WebContentsView.
   *  The native view always floats above renderer DOM, so a renderer-DOM
   *  overlay that must cover it (image lightbox, etc.) increments this while
   *  open; BrowserPanel reacts by hiding the view, and restores it when the
   *  counter returns to zero. A counter (not a boolean) composes correctly
   *  when multiple overlays are open at once. NOT persisted. */
  browserViewSuppressed: number;
  /* ── Draggable pane sizes ──
   *  Persisted as one JSON blob (UI_PANE_WIDTHS_SETTING_KEY) and re-clamped
   *  on hydrate. Updated live during drag (synchronous set); the DB write is
   *  debounced so a drag doesn't hammer the settings table. */
  /** Left sidebar share of the window width, as a percentage 0–100
   *  (default/min 12 — a compact ~259px sidebar on a 2160px window). */
  leftWidthPct: number;
  /** Right IDE panel width in px. */
  rightWidth: number;
  /** Bottom terminal bar height in px (when expanded). */
  bottomTerminalHeight: number;
  /** Editor-column share of the center pane, as a percentage 0–100. The chat
   *  column gets the remainder. Only meaningful when a file is open. */
  editorWidthPct: number;
  /** Permission mode for the next session. The 6-value union
   *  (default / acceptEdits / plan / bypassPermissions / dontAsk / auto)
   *  mirrors the Claude Agent SDK's accepted literals; the composer chip
   *  only surfaces the 4 user-facing ones. See PermissionMode in
   *  @contracts/runtime for the full list. */
  permissionMode: PermissionMode;
  /** Default working environment for NEW sessions: "local" (project root),
   *  "wt-detached" (isolated detached checkout — experimental verification)
   *  or "wt-branch" (isolated checkout on a generated `mcode/*` branch —
   *  real feature work). The worktree materializes on the first turn.
   *  Persisted (settings key `session.worktreeDefault`, same three-value
   *  strings; the legacy boolean "true" hydrates as "wt-detached") so the
   *  choice sticks across restarts. Flipping the chip while the ACTIVE
   *  session is still an un-materialized intent edits THAT session instead
   *  (see setEnvChoice) — the slot itself only seeds new rows. */
  envChoice: EnvChoice;
  /** Provider powering the next session ("claude-sdk" / "pi-sdk"). Chosen in
   *  the composer's provider chip; persisted on the session row at creation.
   *  Once a session has messages, this is read-only (a session's provider is
   *  fixed at creation). */
  providerId: string;
  /** Model for the next session ("default" = let claude pick). → --model. */
  model: string;
  /** Custom-model config bound to the active session (null = built-in). */
  customModelId: string | null;
  /** Last user-picked model per provider ("记住每个 SDK 上次选的模型").
   *  Written by setModel / setCustomModel / setProvider (which stashes the
   *  outgoing provider's selection); read when switching SDKs back so the
   *  composer re-selects the model the user last used with that provider
   *  instead of snapping to "default". Persisted as part of the composer
   *  selection setting. Entries whose model was deleted are dropped (see
   *  validateComposerSelection / rememberProviderModel). */
  lastModelByProvider: Record<string, { model: string; customModelId: string | null }>;
  /** User-defined custom-model configs (desensitized — tokens masked). */
  customModels: CustomModelPublic[];
  /** Registered AI backends from `provider.list`. Empty until initDeferred. */
  providers: ProviderInfo[];
  /** Pi SDK models the user can pick (from ~/.pi/agent/models.json +
   *  injected apiKeys). Populated by `reloadPiAvailableModels` — used by
   *  ModelDropdown when the active provider is pi-sdk, since pi's
   *  `capabilities.builtinModels` is empty (models are dynamic). */
  piAvailableModels: BuiltinModelOption[];
  /** Discovered skills for the composer `/` menu. Cached per active project
   *  (global ~/.claude/skills + the project's .claude/skills); refreshed on
   *  init and project switch. Empty list = no skills installed. */
  skills: SkillInfo[];
  /** Reasoning effort for the next session ("default" = don't pass --effort).
   *  Defaults to "high" so new sessions get the most thinking out of the
   *  box — users can cycle down to Auto if they want claude to pick. */
  effort: EffortLevel;
  /** Latest task list per session (from claude's TodoWrite; null = none yet). */
  todosBySession: Record<string, TodoItem[]>;
  /** Per-session plan-mode draft (empty = not in plan mode). Drives the
   *  Plan section of the activity capsule. */
  planBySession: Record<string, PlanDraft>;
  /** Per-session plan text selected for viewing in the editor column as a
   *  plan tab. null = no plan tab open. Set when the user clicks a plan title
   *  in the activity popover or a plan card in the message stream; cleared on
   *  close / session reset. Ephemeral (not persisted). */
  planDrawerPlanBySession: Record<string, string | null>;
  /** Per-session flag: when true AND planDrawerPlanBySession[sid] is non-null,
   *  the editor column shows the PlanViewer (plan tab is "active"). Switching
   *  to a file tab sets this false (but keeps the plan text so the plan tab
   *  can be re-activated). Ephemeral. */
  planTabActiveBySession: Record<string, boolean>;
  /** Per-session edited draft of a pending plan approval. When the user edits
   *  the plan in the Monaco editor (opened from the approval prompt via
   *  "编辑计划"), the edited text is staged here so PlanApprovalPrompt picks
   *  it up as its draft - the user still confirms via 批准并执行, so editing
   *  in the editor never auto-approves. Cleared on submitPlanApproval /
   *  closePlanDrawer / session reset. Ephemeral (not persisted). */
  planApprovalDraftBySession: Record<string, string>;
  /** Mobile-shell fullscreen viewer target (see {@link MobileViewerTarget}).
   *  null = closed. Ephemeral (not persisted). */
  mobileViewer: MobileViewerTarget | null;
  /** Per-session subagent roster (REPLACE semantics from `subagent.update`).
   *  Empty array = no subagents active. Includes recently-completed ones
   *  until the next turn clears them. */
  subagentsBySession: Record<string, SubagentSnapshot[]>;
  /** Per-session subagent live transcripts (the side-panel subagent viewer).
   *  Outer key = sessionId, inner key = the spawning Task tool_use id (same
   *  id as SubagentSnapshot.toolUseId). NOT persisted — process-lifetime
   *  data rebuilt each turn; cleared when a new turn starts (mirroring the
   *  roster's rebuild cycle). */
  subagentTranscriptsBySession: Record<string, Record<string, SubagentTranscriptBlock[]>>;
  /** Per-session context-window snapshot (from `token-usage.updated` events).
   *  The adapter already did all the math (usedTokens / maxTokens / pct /
   *  warning), so the renderer only stores + renders. Keyed by sessionId so
   *  each tab shows its own occupancy. Hydrated from the session row on
   *  select/open (the snapshot is persisted), then kept live as
   *  `token-usage.updated` events stream in. */
  contextSnapshotBySession: Record<string, ContextSnapshot>;
  /** Per-session, append-only log of finalized turn usage snapshots.
   *  Appended at `turn.done` from the latest ContextSnapshot, so each entry
   *  is the post-turn token/cost breakdown for one completed turn. Used by
   *  the activity capsule's "上下文消耗" section to show a per-turn history
   *  + a session total. Ephemeral (not persisted): a restart starts empty,
   *  same as todos/subagents. */
  usageHistoryBySession: Record<string, TurnUsageRecord[]>;
  /** Per-session pending AskUserQuestion. Keyed by sessionId so a
   *  question popping up in tab B doesn't clobber tab A's. The sessionId
   *  lives on the inner record for cross-checking at render time.
   *
   *  `requestId` correlates the answer back to the provider's pending
   *  user-input Deferred — submitting answers resolves that Deferred so
   *  the SAME turn continues (it does NOT start a new turn). Absent only
   *  for the sentinel-fallback path (no Deferred to resolve). */
  pendingQuestionBySession: Record<string, { questions: AskUserQuestionItem[]; requestId?: string }>;
  /** Per-session tool-approval queue. The head (index 0 of the sub-array
   *  for the session) is what's rendered in the composer overlay. The
   *  top-level array holds all sessions' pending approvals; UI filters
   *  by sessionId. */
  pendingApprovals: ApprovalRequestEvent[];
  /** Per-session pending ExitPlanMode approval. Unlike tool approvals
   *  (which queue), plan approval is one-at-a-time per session — the model
   *  calls ExitPlanMode once per plan. `null` = no plan awaiting decision.
   *  Keyed by sessionId so each tab tracks its own. */
  pendingPlanApprovalBySession: Record<string, PlanApprovalRequestEvent>;

  /** Files modified or created in the most recent turn (for the
   *  "本轮文件" rewind card). Per-session: a new turn in session A does
   *  not overwrite session B's card. The card is cleared on
   *  `turn.rewound` for the same session. */
  turnFilesBySession: Record<string, TurnFileEntry[]>;

  /** Per-session user-placed message bookmarks (selection → "添加书签").
   *  Persisted on the session row; hydrated on select/open so the capsule
   *  segment + timeline markers survive a reopen. Per-session for the same
   *  tab-isolation reason as turnFilesBySession. Stale entries (their
   *  message was truncated away by an edit-resend) are kept until the user
   *  deletes them — the popover renders them greyed out. */
  bookmarksBySession: Record<string, SessionBookmark[]>;

  /** Per-session ephemeral queue of absolute file paths the user wants added
   *  to the composer as file-reference tags (e.g. from the file-tree context
   *  menu's "Add to chat" action). The owning ChatPane drains its session's
   *  queue via {@link drainChatFileQueue} and converts the paths to tags.
   *  NOT persisted - it's a one-shot hand-off channel, not session data. */
  chatFileQueueBySession: Record<string, string[]>;

  /** Per-session ephemeral queue of DOM elements picked from the embedded
   *  browser panel. The owning ChatPane drains its session's queue via
   *  {@link drainChatElementQueue} and converts each to an element tag. Same
   *  one-shot hand-off pattern as chatFileQueueBySession. NOT persisted. */
  chatElementQueueBySession: Record<string, PickedElement[]>;

  /** Per-session FIFO prompt queue. Populated when the user "排队" a prompt
   *  while the session is busy; auto-drained (head sent) when the session
   *  goes fully idle (no running turn AND no running background subagent).
   *  Keyed by sessionId so the queue survives tab switches — draining lives
   *  in the store's event handlers, where there's no component to hold it.
   *  NOT persisted: ephemeral run-ahead buffer, not session history. */
  promptQueueBySession: Record<string, QueuedPrompt[]>;

  /** Per-session composer draft (typed-but-unsent content + attachment chips).
   *  Written through by the ChatPane on every composer change; restored when
   *  the session's pane remounts (single-mode thread switch, tab close/reopen)
   *  so the user's input survives thread switches. NOT persisted — in-memory
   *  only, cleared once the draft is sent or the session is deleted. */
  composerDraftBySession: Record<string, ComposerDraft>;

  /* ── Side chat (right-panel ask tab) ──
   *  Side chats are full sessions with kind="side" + parentSessionId, hidden
   *  from every left-bar list (repo queries exclude them). They run fully
   *  concurrent with their parent — RuntimeManager keys everything by
   *  sessionId — and are managed here, keyed by their PARENT session id. */
  /** Loaded side-chat lists, keyed by parent (main) session id. Hydrated on
   *  demand when the ask tab opens or the active main session changes
   *  (hydrateSideChats); NOT part of sessionsByProject. Ordered by
   *  created_at DESC (newest Q&A thread first), matching the repo query. */
  sideChatsByParent: Record<string, Session[]>;
  /** The side chat currently open in the ask tab's chat view; null = the
   *  list view is showing. NOT reset on main-session switch — the panel
   *  derives "activeSideChat belongs to the current parent" and falls back
   *  to the list view when it doesn't, so switching threads can't strand
   *  the user in another thread's chat view. */
  activeSideChatId: string | null;
  /** One-shot seed text waiting to be dropped into a side chat's composer,
   *  keyed by the SIDE chat's session id. Written by askInSideChat (the
   *  message-stream selection toolbar's "发送到侧边对话" action), consumed and
   *  drained by the side chat's own ChatPane instance. One-shot channel,
   *  not persisted — same hand-off pattern as chatFileQueueBySession. */
  sideChatSeedBySession: Record<string, string>;
  /** One-shot "open this subagent's transcript" request from outside the
   *  side panel (the ActivityPopover's subagent row click). Carries the
   *  PARENT session id (ownership check) + the subagent's taskId; consumed
   *  and drained by SideChatPanel. Not persisted. */
  pendingSubagentView: { sessionId: string; taskId: string } | null;
  /** One-shot "open this session and jump to this message" request.
   *  Producers: the Ctrl+K palette's bookmark result click, and the turn
   *  flow panel's step rows (locate-in-chat navigation). Consumed by the
   *  target session's ChatPane once the message stream holds the target
   *  message (openTab's history prefetch is async); cleared without jumping
   *  when the history is loaded but the message is gone (stale bookmark /
   *  truncated by an edit-resend). Not persisted. */
  pendingBookmarkJump: {
    sessionId: string;
    messageId: string;
    excerpt?: string;
  } | null;

  /* ── IDE right-panel state ──
   *  Editor state (open files, active file, view mode, expanded tree dirs)
   *  is PER-PROJECT: switching to project B shows B's open files, and
   *  switching back to A restores A's. This mirrors the per-session bucket
   *  pattern (messagesBySession, todosBySession). Keyed by projectId.
   *
   *  A few IDE prefs remain global (not per-project) because they express a
   *  user preference, not project state: rightPanelTab, ideEditorMode,
   *  ideFocusNonce. */
  /** Active tab in the right panel. Persisted so reopening the app restores
   *  the last-used inspector. Only "files" is implemented in P4; the other
   *  three round-trip for forward-compat. */
  rightPanelTab: RightPanelTab;
  /** Per-project terminal quick-commands. Outer key = projectId, value = that
   *  project's saved commands. Persisted as a JSON object (keyed by projectId)
   *  in the settings table; read/written by the terminal toolbar's commands
   *  menu and the settings → terminal panel. */
  customCommandsByProject: Record<string, CustomCommand[]>;
  /** Per-project ordered list of absolute file paths open in the Monaco
   *  editor area. Drives the OpenTabsBar. Persisted as a JSON object keyed
   *  by projectId. */
  ideOpenFilesByProject: Record<string, string[]>;
  /** Per-project currently-active file (member of the project's open list,
   *  or null). Persisted as a JSON object keyed by projectId. */
  ideActiveFileByProject: Record<string, string | null>;
  /** Per-project per-file view mode ("diff" shows before-vs-current; "edit"
   *  is the normal editor). Outer key = projectId, inner key = filePath.
   *  NOT persisted — resets each session, since the `before` snapshot only
   *  exists for the latest turn anyway. */
  ideFileViewModeByProject: Record<string, Record<string, FileViewMode>>;
  /** How opening a file affects the open-file list:
   *   - "tabs"    (default): each file accumulates as a tab.
   *   - "replace": opening a file replaces whatever was open (≤1 file at a
   *     time). Persisted in the settings table. Global (not per-project). */
  ideEditorMode: IdeEditorMode;
  /** Where a git-diff click opens the diff viewer:
   *   - "center"  (default): center-area Monaco editor (existing behavior).
   *   - "dialog": a floating modal dialog with multiple diff tabs.
   *  Persisted in the settings table. Global (not per-project). */
  gitDiffOpenMode: GitDiffOpenMode;
  /** Diff tabs currently open in the Git diff dialog (the "dialog" open-mode).
   *  Ephemeral (NOT persisted) - restarting clears them. Dedup by file path. */
  gitDiffDialogTabs: GitDiffDialogTab[];
  /** Active tab id in the Git diff dialog, or null when none. Ephemeral. */
  gitDiffDialogActiveId: string | null;
  /** Whether the Git diff dialog is currently shown. Closing it keeps the
   *  tabs; the Git panel toolbar button re-opens it. Ephemeral. */
  gitDiffDialogOpen: boolean;
  /** How the Git diff dialog presents its open diff files:
   *   - "tabs"   (default): show a top tab strip + the left file list.
   *   - "single": hide the tab strip; navigate via the left file list only.
   *  Ephemeral (NOT persisted) - restarting resets to "tabs". */
  gitDiffDialogViewMode: "tabs" | "single";
  /** Per-project absolute directory paths expanded in the file tree.
   *  Persisted as a JSON object keyed by projectId so each project's tree
   *  re-opens to where the user left it. */
  ideExpandedDirsByProject: Record<string, string[]>;
  /** Per-project per-file git diff pair for the center Monaco DiffEditor.
   *  - Working-tree clicks stash `{ before }` only → DiffPane reads disk as after.
   *  - History clicks stash `{ before, after }` → DiffPane uses both blobs (no disk).
   *  Ephemeral (NOT persisted). Outer key = projectId, inner key = abs filePath. */
  gitDiffByProject: Record<string, Record<string, { before: string; after?: string }>>;
  /** Per-project per-file "open-as-diff" before-snapshot override. When a
   *  turn-files card opens a file for review it passes the card's frozen
   *  `before` (works for HISTORICAL turns too, whose snapshot is gone from
   *  turnFilesBySession). FileEditor uses this as a fallback diff source.
   *  Ephemeral (NOT persisted) - a stale before is harmless: the worst case
   *  is an outdated left pane until the user closes the file. */
  ideDiffBeforeByProject: Record<string, Record<string, string>>;
  /** Custom-model id used for git-commit-message generation, or null for
   *  built-in. Persisted in the settings table. */
  commitGenModel: string | null;
  /** Prompt template for commit-message generation. Persisted. Empty = use
   *  the built-in default (defined in the main-process handler). */
  commitGenPrompt: string;
  /** Custom-model id used for AI git-conflict resolution, or null for the
   *  built-in model. Stored as `"configId:roleKey"`. Persisted in the settings
   *  table; independent of commitGenModel so the two can use different models. */
  conflictResolveModel: string | null;
  /** Whether auto thread-title generation is enabled. When true, the main
   *  process fires a one-shot LLM call on a session's first user message to
   *  generate a short Chinese title. Persisted in the settings table. */
  titleGenEnabled: boolean;
  /** Custom-model id used for auto thread-title generation, or null for the
   *  built-in model. Stored as `"configId:roleKey"`. Persisted in the settings
   *  table; independent of the other gen models. */
  titleGenModel: string | null;
  /** Selected Claude output style name (built-in id or custom style name), or
   *  null = never configured → the CLI default style. Persisted in the
   *  settings table; injected per-turn by the Claude provider. */
  outputStyle: string | null;
  /** Per-repo collapsed state in the Git panel. Persisted in the settings
   *  table as a JSON-encoded Record<string, boolean>. */
  collapsedGitRepos: Record<string, boolean>;
  /** Monotonically-increasing counter bumped whenever something requests the
   *  right panel's attention (e.g. the 审查 button on a turn-files card).
   *  App.tsx watches this via effect and opens the panel if collapsed —
   *  decoupling the store (which can't reach into App's local state) from
   *  the visibility toggle. */
  ideFocusNonce: number;

  /** Pending "reveal in file tree" target — set by the turn-files card's
   *  定位到工作树 button. FileTree expands the target's ancestor dirs and
   *  scrolls it into view whenever this object's identity changes (the nonce
   *  makes every request a new object, like ideRevealNonce). Not
   *  consumed/cleared — the effect only reacts to change, a stale value is
   *  inert. Not persisted. */
  ideTreeReveal: { filePath: string; nonce: number } | null;

  /** Pending goto-definition reveal target. When non-null, the EditPane for
   *  `filePath` should scroll to (line, column) and place the caret there on
   *  mount/nonce-bump, then clear this. Driven by `openFileInIde` line/col. */
  idePendingReveal: { filePath: string; line: number; column: number } | null;
  /** Monotonic counter bumped whenever idePendingReveal is set, so an
   *  already-mounted EditPane re-runs its reveal effect. */
  ideRevealNonce: number;

  /** Per-project editor navigation-history BACK stack (Alt+←). Each entry is
   *  a location the user navigated AWAY from (goto-definition invocation,
   *  file switch). Ephemeral — NOT persisted; resets each session. */
  navBackByProject: Record<string, NavEntry[]>;
  /** Per-project editor navigation-history FORWARD stack (Alt+→). Filled by
   *  navigateBack (the location left behind), cleared by any new push. */
  navForwardByProject: Record<string, NavEntry[]>;

  /** Language server states, hydrated from `api.lsp.list()` in initDeferred.
   *  Empty array until first load completes. Not persisted (re-fetched each
   *  startup from the main process). */
  lspLanguages: LspLanguageState[];

  /** Language-server lifecycle phase per `${workspacePath}::${language}`,
   *  driven by `lsp:event` stateChanged pushes (see LspStateChangedPayload).
   *  The editor toolbar reads it to show a loading pill while a server starts
   *  and a failure notice when it couldn't start. Ephemeral. */
  lspPhasesByWorkspace: Record<string, { phase: "starting" | "running" | "stopped" | "importing"; error?: string; detail?: string }>;

  /** True once `init()` has started - guards against React StrictMode's
   *  double-effect in dev firing init twice. */
  _initStarted: boolean;

  // actions
  init: () => Promise<void>;
  /** Deferred (non-critical) hydration kicked off by `init()` after the
   *  first-paint essentials are done. Loads health-check, custom models,
   *  appearance extras, and IDE/git panel prefs - none of which are needed
   *  for the first visible frame. */
  initDeferred: () => Promise<void>;
  addProjectFromFolder: () => Promise<string | null>;
  selectProject: (projectId: string) => Promise<void>;
  toggleProjectExpanded: (projectId: string) => void;
  /** Flip a project's left-bar view between local threads and worktree
   *  groups (drives the project row's fork toggle). */
  setProjectWorktreeView: (projectId: string, on: boolean) => void;
  /** Toggle a worktree group node's expanded state in the left-bar tree
   *  (keyed by raw worktree path; normalized internally). */
  toggleWorktreeExpanded: (worktreePath: string) => void;
  /** Set (or clear, empty name) the left-bar display name for a worktree
   *  directory. Optimistic local patch + fire-and-forget settings write. */
  renameWorktree: (worktreePath: string, name: string) => Promise<void>;
  setArchivedViewOpen: (open: boolean) => void;
  /** Fetch the next page of active sessions for a project and append it to
   *  `sessionsByProject[projectId]`. No-op when there are no more to load. */
  loadMoreSessions: (projectId: string) => Promise<void>;
  startSession: (projectId?: string, overrides?: { providerId?: string; model?: string; customModelId?: string | null; worktreePath?: string }) => Promise<void>;
  /** Switch the active session (and load its history if not cached).
   *  Always replaces the center pane content. In `single` displayMode
   *  this is the only navigation primitive; in `tabs` mode it's used
   *  by SessionTabs to flip between already-open tabs. */
  selectSession: (sessionId: string) => Promise<void>;
  /** Open a session as a tab. If it's already in `openTabs` this is a
   *  no-op except for the activeSessionId flip; otherwise it's appended
   *  to the end of the list. This is the LeftBar's "click a thread"
   *  entry point in both display modes — the difference is purely
   *  cosmetic (single mode hides the tab strip, tabs mode shows it). */
  openTab: (sessionId: string) => Promise<void>;
  /** Load a session's first page of persisted messages WITHOUT activating
   *  it. Used for hover-prefetch from the sidebar so that by the time the
   *  click lands the bucket is already warm (or in flight) and the center
   *  pane swaps in with content instead of a blank frame. No-op when the
   *  bucket exists or a fetch is already running. */
  prefetchSessionMessages: (sessionId: string) => Promise<void>;
  /** Fetch the next page of older messages for a session and prepend them.
   *  No-op when nothing more is available or a fetch is already in flight. */
  loadOlderMessages: (sessionId: string) => Promise<void>;
  /** Remove a session from the tab strip. If it was the active tab,
   *  focus shifts to the previous one (or the next, if there is no
   *  previous); running turns are NOT cancelled — they keep streaming
   *  in the background and the user can re-open the tab to see them. */
  closeTab: (sessionId: string) => void;
  /** Reorder the tab strip by moving the tab at `from` to index `to`.
   *  Pure order shuffle: activeSessionId is untouched, config sync is
   *  unaffected (it keys off the session row, not tab order), and the
   *  order is not persisted (openTabs is in-memory only). */
  reorderTab: (from: number, to: number) => void;
  deleteProject: (id: string) => Promise<void>;
  archiveProject: (id: string, archived: boolean) => Promise<void>;
  /** Assign a project to a group (left-bar "grouped" view). Pass null to
   *  remove it from any group. */
  setProjectGroup: (id: string, group: string | null) => Promise<void>;
  /** Rename a project (display-only; the on-disk folder is untouched). The
   *  returned project replaces the stale copy in state. */
  renameProject: (id: string, name: string) => Promise<void>;
  /** Pin/unpin a project. Pinning MOVES the row: out of the flat list / its
   *  group and into the pinned section above the left bar's project tree
   *  (most recent pin first); unpinning returns it to its drag-order spot.
   *  Refetches the whole list afterwards — the row's position changes, and
   *  the DB's ordering is the single source of truth for it. */
  setProjectPinned: (id: string, pinned: boolean) => Promise<void>;
  /** Persist a drag-to-reorder. `orderedIds` is the full visible project id
   *  list in the new order. */
  reorderProjects: (orderedIds: string[]) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  archiveSession: (id: string, archived: boolean) => Promise<void>;
  /** Rename a session (persist a user-edited title). Updates the row in
   *  `sessionsByProject` if it's in the loaded page slice, so the left bar
   *  + tab strip reflect the new title immediately. The store does NOT trim
   *  the title - the caller should pass a non-empty trimmed string. */
  renameSession: (id: string, title: string) => Promise<void>;
  /** Pin/unpin a session within its project (project-scoped: pinned sessions
   *  sort to the top of the project's session list). Persists via IPC, patches
   *  the cached row with the server-fresh copy, then re-sorts the project's
   *  loaded window so pinned rows float to the top immediately. */
  setSessionPinned: (id: string, pinned: boolean) => Promise<void>;
  /** Add a message bookmark (message-level anchor + display excerpt).
   *  Optimistically updates the per-session bucket (the fly-to-capsule
   *  animation needs instant feedback), persists the full list via IPC, and
   *  rolls the bucket back if the write fails. */
  addBookmark: (
    sessionId: string,
    bookmark: { messageId: string; excerpt: string; role: "user" | "assistant" },
  ) => Promise<void>;
  /** Remove a bookmark by id (same optimistic-then-persist flow as
   *  {@link addBookmark}). */
  removeBookmark: (sessionId: string, bookmarkId: string) => Promise<void>;
  /** Set a bookmark's user-defined display name. Empty/whitespace title
   *  clears the rename (lists fall back to the excerpt). The excerpt is
   *  never rewritten — it anchors the jump's precise text highlight. Same
   *  optimistic-then-persist flow as {@link removeBookmark}. */
  renameBookmark: (sessionId: string, bookmarkId: string, title: string) => Promise<void>;
  /** Apply a title update pushed from main (auto title-gen). Patches the
   *  in-memory session lists directly - the DB row is already updated by the
   *  main process, so no IPC round-trip. Mirrors renameSession's patching. */
  applySessionTitleUpdate: (sessionId: string, title: string) => void;
  sendPrompt: (
    prompt: string,
    attachments?: { preview: string; content: string; attachmentKind?: "paste" | "file" | "quote"; filePath?: string }[],
    /** Text shown in the user message's text block. Defaults to `prompt`,
     *  but when attachments are present the caller passes just the typed
     *  text (without the inlined attachment content) so the card + text
     *  don't duplicate the same payload. The full `prompt` (with
     *  attachments inlined) is still what gets sent to the SDK. */
    displayText?: string,
    /** Names of skill pills embedded inline in the text (for stream rendering
     *  — the Markdown renderer turns the matching `/name` occurrences into
     *  styled pills). Absent for plain-text messages. */
    skillsUsed?: string[],
    /** User-attached images (downsized base64 content blocks). Rendered as
     *  image blocks on the user message and inlined into the provider request.
     *  An image-only turn passes an empty `prompt`. */
    images?: PromptImage[],
    /** Rich blocks for the user bubble, replacing the default single text
     *  block. The plan handoff uses this to render "note + plan card" instead
     *  of dumping the raw kickoff prompt — `prompt` still carries the full
     *  text to the model. Absent for ordinary typed messages. */
    displayBlocks?: Block[],
    /** Explicit target session. Defaults to the global activeSessionId; the
     *  side-chat pane passes ITS own sessionId so its sends never leak into
     *  the foreground main session (and vice versa). */
    sessionId?: string,
  ) => Promise<boolean>;
  /** Resolves true when the prompt was accepted into the stream (the caller
   *  may then clear the composer), false when a guard blocked it (no session,
   *  session running, or the "尚未配置模型" dialog was raised — in which case
   *  the caller should keep the composer's input so nothing is lost). */
  /** Edit a previously-sent user message in place and resend it. Truncates
   *  the session's message history at the target message (removing it and
   *  everything after it - including the AI's reply), persists the
   *  truncated history, then sends the edited prompt as a fresh user
   *  message. The session must NOT be running when this is called.
   *
   *  `images` is the surviving image list from the inline editor (empty
   *  array = the user deleted them all). When omitted, the original
   *  message's images are preserved verbatim.
   *
   *  Takes an explicit `sessionId` (not activeSessionId) so it works
   *  correctly across multiple open tabs. */
  editAndResendMessage: (
    sessionId: string,
    messageId: string,
    newPrompt: string,
    attachments?: { preview: string; content: string; attachmentKind?: "paste" | "file" | "quote"; filePath?: string }[],
    displayText?: string,
    skillsUsed?: string[],
    images?: PromptImage[],
  ) => Promise<void>;
  interrupt: (sessionId?: string) => Promise<void>;
  ingestEvent: (e: RuntimeEvent) => void;
  /** Update the window-focus flag. Called from useClaudeEvents on Electron
   *  `window:focusChanged` + `document.visibilitychange`. When the window
   *  regains focus, the active session's unread counter is cleared (the user
   *  is looking at it now). */
  setWindowFocused: (focused: boolean) => void;
  setSettingsOpen: (open: boolean, section?: string) => void;
  /** Toggle the "尚未配置模型" dialog open/closed (send-time guard). */
  setModelConfigPromptOpen: (open: boolean) => void;
  /** Toggle the Cmd/Ctrl+K command palette open/closed. */
  setCommandPaletteOpen: (open: boolean) => void;
  /** Toggle the file search dialog open/closed. Opened from the Files panel
   *  search button, the `files.search` command, or the Cmd/Ctrl+Shift+F
   *  global hotkey. NOT persisted (pure in-memory, like the command palette). */
  setSearchDialogOpen: (open: boolean) => void;
  /** Toggle the left sidebar open/closed (direct set). NOT persisted. */
  setLeftOpen: (open: boolean) => void;
  /** Toggle the right IDE panel open/closed (direct set). NOT persisted. */
  setRightOpen: (open: boolean) => void;
  /** Toggle the bottom terminal bar open/closed (direct set). NOT persisted. */
  setBottomTerminalOpen: (open: boolean) => void;
  /** Toggle the browser panel open/closed (direct set). NOT persisted. */
  setBrowserPanelOpen: (open: boolean) => void;
  /** Enter/exit wide-panel (3:7) mode. Entering hides the left sidebar + closes
   *  any open browser overlay and snapshots the pre-enter layout; exiting
   *  restores leftOpen / rightOpen / rightWidth from that snapshot. */
  setWidePanelOpen: (open: boolean) => void;
  /** Apply an incremental delta to the wide-panel percentage (the right
   *  panel's share of the chat|right split). Divider sits left of the right
   *  column, so a right drag (positive delta) shrinks it — same sign convention
   *  as adjustEditorWidthPct. */
  adjustWidePanelPct: (deltaPx: number) => void;
  /** Reset the wide-panel split to the default 3:7 (double-click on divider). */
  resetWidePanelPct: () => void;
  /** Set the browser device-toolbar visibility (DevTools-style bar under the
   *  address bar). NOT persisted. */
  setBrowserDeviceToolbarOpen: (open: boolean) => void;
  /** Update the open-browser-tab count (drives the Titlebar badge). */
  setBrowserTabCount: (count: number) => void;
  /** Replace the whole browser-tabs list (shared sidebar/overlay state). */
  setBrowserTabs: (tabs: BrowserTab[]) => void;
  /** Set the active browser tab id. */
  setBrowserActiveTabId: (id: string | null) => void;
  /** Increment/decrement the browser-view suppression counter. While > 0 the
   *  active WebContentsView is hidden so renderer-DOM overlays (image lightbox,
   *  etc.) can cover it. Call `suppressBrowserView(false)` in a cleanup to
   *  restore. NOT persisted. */
  suppressBrowserView: (suppressed: boolean) => void;
  /** Append a new browser tab. */
  addBrowserTab: (tab: BrowserTab) => void;
  /** Remove a browser tab by its renderer-local id; returns nothing. */
  removeBrowserTab: (id: string) => void;
  /** Patch one browser tab by its main-process browserId. */
  patchBrowserTab: (browserId: string, patch: Partial<BrowserTab>) => void;
  /** Open the browser sidebar and load `url` (a fully-qualified URL such as a
   *  `file://` path) into the active tab. If no tab exists yet, the URL is
   *  stashed as `pendingBrowserUrl` and loaded once BrowserPanel creates its
   *  first tab. */
  openUrlInBrowser: (url: string) => void;
  /** Adopt a browser view created by an agent tool (not by BrowserPanel's
   *  createTab) into the renderer's tab list, so BrowserPanel's show/hide/
   *  bounds logic can manage it. Idempotent: if a tab for this browserId
   *  already exists, just updates its url/title/device and activates it. */
  adoptAgentBrowserTab: (
    browserId: string,
    info: {
      url?: string;
      title?: string;
      device?: BrowserDevicePreset;
      orientation?: BrowserOrientation;
    },
  ) => boolean;
  /** Apply an incremental delta (in percentage points of the window width) to
   *  the left sidebar share (clamped, then a debounced DB write). The caller
   *  converts the divider's px delta via the container width. */
  adjustLeftWidthPct: (deltaPct: number) => void;
  /** Apply an incremental delta to the right panel width. */
  adjustRightWidth: (deltaPx: number) => void;
  /** Apply an incremental delta to the bottom terminal height. */
  adjustBottomTerminalHeight: (deltaPx: number) => void;
  /** Apply an incremental delta to the editor-column percentage. The delta
   *  is in px; the caller converts to pct via the container width. */
  adjustEditorWidthPct: (deltaPx: number) => void;
  /** Reset a pane width to its default (double-click on the divider). */
  resetLeftWidthPct: () => void;
  resetRightWidth: () => void;
  resetBottomTerminalHeight: () => void;
  resetEditorWidthPct: () => void;
  /** Update the center-pane display mode. Persists to the `settings`
   *  table so the choice survives restart. */
  setDisplayMode: (mode: DisplayMode) => Promise<void>;
  /** Switch the unified center tab bar's focus (tabs displayMode) between
   *  the chat view and the editor view. Most flips flow through natural
   *  actions (selectSession / openFileInIde / setIdeActiveFile / ...);
   *  this is the direct escape hatch for chrome that toggles the view. */
  setCenterTabFocus: (focus: "chat" | "editor") => void;
  /** Update the UI language. Persists to the `settings` table so the
   *  choice survives restart; translated components re-render live. */
  setLocale: (locale: Locale) => Promise<void>;
  /** Update the session auto-archive rules. Persists to the `settings`
   *  table; the main-process AutoArchiver picks the change up on its next
   *  tick. */
  setAutoArchiveConfig: (config: AutoArchiveConfig) => Promise<void>;
  /** Update the chat message-stream density. Persists to the `settings`
   *  table so the choice survives restart. */
  setChatDensity: (mode: ChatDensity) => Promise<void>;
  /** Toggle the left-bar project view between flat and grouped. Persists
   *  to the `settings` table so the choice survives restart. */
  setProjectView: (mode: ProjectView) => Promise<void>;
  /** Set a group's color ("R G B" triplet or null for default). */
  setGroupColor: (name: string, rgb: string | null) => void;
  /** Persist a new group order (full ordered name list). */
  setGroupOrder: (orderedNames: string[]) => void;
  /** Migrate group metadata when a group is renamed. */
  renameGroupMeta: (oldName: string, newName: string) => void;
  /** Write the current groupMeta to the settings blob. */
  persistGroupMeta: (meta: ProjectGroupsMeta) => void;
  /** Update the chat content font size (clamped to 12–20 px). Persists to
   *  the `settings` table. */
  setChatFontSize: (px: number) => Promise<void>;
  /** Update the right-panel base font size (clamped to 10–22 px). Persists
   *  to the `settings` table. */
  setRightPanelFontSize: (px: number) => Promise<void>;
  /** Update the paste-to-card threshold (clamped to 50–5000 chars). Persists
   *  to the `settings` table. */
  setPasteTagThresholdChars: (n: number) => Promise<void>;
  /** Set the default voice-input mode (continuous | pushToTalk). Persists to
   *  the `settings` table. */
  setVoiceInputMode: (mode: VoiceInputMode) => Promise<void>;
  /** Set the default speech-recognition language tag ("zh-CN" | "en-US"). */
  setVoiceLang: (lang: string) => Promise<void>;
  /** Set the preferred ASR engine ("zipformer" | "parakeet"). */
  setVoiceEngine: (engine: VoiceEngine) => Promise<void>;
  /** Cache the mic-permission outcome ("granted" | "denied" | ""). */
  setVoiceMicPermission: (perm: string) => Promise<void>;
  /** Set the user-selected local ASR model directory (absolute path). */
  setVoiceModelDir: (dir: string) => Promise<void>;
  /** Update the user-message background color (R G B triplet, or null =
   *  theme default). Persists to the `settings` table. */
  setUserMessageColor: (rgb: string | null) => Promise<void>;
  /** Set the global brand/accent color ("R G B" triplet, or null for the
   *  theme default). Persists to the `settings` table. */
  setAccentColor: (rgb: string | null) => Promise<void>;
  /** Set the Monaco editor color scheme for one app mode ("dark"|"light").
   *  The whole per-mode choice persists to the `settings` table as one JSON
   *  blob; mounted editors re-render live via useMonacoTheme(). */
  setEditorTheme: (mode: "dark" | "light", id: EditorThemeId) => Promise<void>;
  /** Bind (or rebind) a keyboard shortcut for `commandId`. Pass `null` to
   *  clear the override and fall back to the compiled-in default. Persists
   *  the whole override map to the `settings` table as one JSON blob. */
  setShortcutOverride: (commandId: string, accel: Accelerator | null) => void;
  /** Clear every shortcut override, restoring all defaults. Persists. */
  resetAllShortcuts: () => void;
  /** True while the shortcut recorder is capturing a chord. The global
   *  keydown listener checks this to suppress dispatch (otherwise pressing
   *  a bound chord mid-recording would both record it AND fire its command). */
  shortcutRecording: boolean;
  setShortcutRecording: (recording: boolean) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  /** Pick the working-environment chip. When the ACTIVE session is an
   *  un-materialized intent, the choice edits THAT session's envMode + wtStyle
   *  (updateSettings) instead of the global default — the chip reads as
   *  "this thread's environment" until the first turn locks it. Otherwise
   *  (local/absent/materialized sessions) it sets the persisted default for
   *  NEW sessions. */
  setEnvChoice: (choice: EnvChoice) => void;
  /** Switch the provider for the NEXT session (no effect once a session has
   *  messages — a session's provider is fixed at creation). */
  setProvider: (id: string) => void;
  /** Re-fetch the registered provider list from main. Called on init. */
  reloadProviders: () => Promise<void>;
  /** Re-fetch the list of models the pi SDK can authenticate with the
   *  currently-configured keys. Populates `piAvailableModels` (read by
   *  ModelDropdown when the active provider is pi-sdk). Called on init and
   *  after any PiModelsPanel save/delete. */
  reloadPiAvailableModels: () => Promise<void>;
  setModel: (model: string) => void;
  setEffort: (effort: EffortLevel) => void;
  setCustomModel: (id: string | null, model?: string) => void;
  reloadCustomModels: () => Promise<void>;
  /** Re-fetch language server states from main. Called on init and after any
   *  lsp mutation (install/toggle/setPath). Best-effort; failures are logged
   *  and leave the existing state. Also re-applies the TS-Worker diagnostic
   *  suppression when the typescript server is enabled. */
  reloadLspLanguages: () => Promise<void>;
  /** Kick off the active project's Java server in the background
   *  (LspManager.prewarm): the one-time Maven/Gradle import then runs while
   *  the user browses instead of blocking the first Java file they open.
   *  No-op when java is disabled / no active project / on web. Main-side
   *  ensureServer is idempotent, so repeated calls are cheap. */
  prewarmJavaLspForActiveProject: () => void;
  /** Re-fetch the skill list for the active project from main (scans
   *  ~/.claude/skills + the project's .claude/skills). Safe to call anytime;
   *  no-op silently when there is no active project. */
  reloadSkills: () => Promise<void>;
  dismissQuestion: () => void;
  /** Submit answers to the head AskUserQuestion for the active session.
   *  Calls `claude:respondQuestion` which resolves the provider's pending
   *  user-input Deferred — the SAME turn then continues (the model receives
   *  the answers and proceeds). This is the correct path: it does NOT start
   *  a new turn. For sentinel-fallback requests (no Deferred), main composes
   *  the answers into a prompt and starts a follow-up turn itself. */
  submitQuestion: (
    answers: UserInputAnswers,
    /** Owning session; defaults to the global activeSessionId. The side-chat
     *  pane passes its own id so answering ITS question doesn't resolve the
     *  foreground session's pending card. */
    sessionId?: string,
  ) => Promise<void>;
  /** Approve or deny the head of the approval queue. Called by the
   *  composer overlay; resolves the matching canUseTool on the main side
   *  and shifts the head off. If the queue has more items, the next one
   *  auto-promotes. */
  decideApproval: (requestId: string, granted: boolean, always?: boolean) => Promise<void>;
  /** Submit the user's approve/reject decision on a pending ExitPlanMode
   *  plan. Resolves the provider's pending plan-approval Deferred via
   *  `claude:respondPlanApproval` so the SAME turn continues — approve →
   *  SDK exits plan mode and starts executing; reject → SDK stays in plan
   *  mode and the model can revise. On success the pending card clears;
   *  on IPC failure it stays so the user can retry. */
  submitPlanApproval: (requestId: string, approved: boolean, editedPlan?: string, reason?: string, feedback?: string) => Promise<void>;
  /** Hand a pending plan approval to a different executor instead of
   *  approving in place. "remodel" interrupts the blocked turn, rebinds this
   *  session's model, and fires the plan as a fresh turn in the same thread;
   *  "newSession" interrupts it and creates a new session (optionally another
   *  SDK) seeded with the plan as its first prompt. The pending ExitPlanMode
   *  dialog is never answered — the turn is aborted, so no request.resolved
   *  event will arrive and the local pending state is cleared here. Must run
   *  from the foreground tab (config-slot rebind + sendPrompt are
   *  active-session scoped). */
  handoffPlanApproval: (sessionId: string, requestId: string, target: PlanHandoffTarget, feedback?: string) => Promise<void>;
  /** Open a plan tab in the editor column for a session, showing the given
   *  plan markdown. Activates the plan tab (planTabActive = true). Called
   *  when the user clicks a plan card or a plan title in the activity
   *  popover. Ephemeral view state (not persisted). */
  openPlanDrawer: (sessionId: string, plan: string) => void;
  /** Open the mobile shell's fullscreen viewer (file / diff / plan). No-op
   *  target routing on the desktop shell — nothing consumes it there. */
  openMobileViewer: (target: MobileViewerTarget) => void;
  /** Close the mobile shell's fullscreen viewer. */
  closeMobileViewer: () => void;
  /** Close the plan tab for a session (removes the plan text entirely). */
  closePlanDrawer: (sessionId: string) => void;
  /** Set whether the plan tab is the active tab in the editor column. When
   *  true the editor shows PlanViewer; when false it shows the active file.
   *  Does NOT clear the plan text - the plan tab stays in the tab bar. */
  setPlanTabActive: (sessionId: string, active: boolean) => void;
  /** Stage an edited plan draft (from the Monaco editor) for a pending
   *  ExitPlanMode approval. PlanApprovalPrompt reads this as its initial
   *  draft so edits made in the editor flow back to the approval sheet
   *  without auto-approving. */
  setPlanApprovalDraft: (sessionId: string, draft: string) => void;
  /** Update the plan text shown in the plan tab (PlanViewer). For historical
   *  (already-frozen) plan edits this updates the local view model only - it
   *  does NOT rewrite the frozen message-stream block or persist. */
  updatePlanDrawerPlan: (sessionId: string, plan: string) => void;
  /** Rewind the most recent turn: restore all files Edit/Write touched
   *  to their pre-turn state. The IPC call returns the list of restored
   *  paths; we leave the UI state update to the `turn.rewound` event
   *  that main emits after restore completes (single source of truth
   *  for "files are back"). The call is fire-and-await; failures log
   *  to console and leave state untouched so the user can retry.
   *
   *  `targetFiles` (the requested path set) is forwarded to main so the
   *  `turn.rewound` event carries it; the handler then marks the matching
   *  card `rewound: true` in place — for both latest-turn and historical
   *  rewinds. The card is never removed, so the stream keeps a trace. */
  rewindTurn: (files: TurnFileEntry[], targetFiles: string[]) => Promise<void>;

  /** Reveal a file in the IDE right panel's file tree: switches the panel to
   *  the files tab, bumps ideFocusNonce (App's effect opens the panel if
   *  collapsed), and sets ideTreeReveal so the tree expands the file's
   *  ancestor dirs and scrolls to it. Desktop only — the mobile shell has no
   *  file tree. */
  revealInFileTree: (filePath: string) => void;
  refreshClaudeHealth: () => Promise<void>;

  /** Enqueue a file path to be added to the active session's composer as a
   *  file-reference tag. The owning ChatPane drains its queue (see
   *  {@link drainChatFileQueue}) and converts the path to a tag. No-op if no
   *  active session. Duplicate paths within the queue are kept; the composer
   *  dedups by absolute path when materializing tags. */
  enqueueChatFile: (filePath: string) => void;
  /** Read and clear the active session's pending chat-file queue, returning
   *  the paths so the caller can turn them into tags. Returns an empty array
   *  if no active session or queue is empty. */
  drainChatFileQueue: (sessionId?: string) => string[];

  /** Enqueue a DOM element picked from the embedded browser to be added to the
   *  active session's composer as an element tag. The owning ChatPane drains
   *  its queue (see {@link drainChatElementQueue}). No-op if no active session. */
  enqueueChatElement: (element: PickedElement) => void;
  /** Read and clear the active session's pending chat-element queue, returning
   *  the elements so the caller can turn them into tags. Empty array if no
   *  active session or queue is empty. */
  drainChatElementQueue: (sessionId?: string) => PickedElement[];

  /** Append a prepared prompt to a session's FIFO queue. Called by the
   *  composer's "排队" action while the session is busy. Generates the id;
   *  the caller passes prompt/displayText/attachments. The head is drained
   *  automatically when the session next goes fully idle. */
  enqueuePrompt: (sessionId: string, item: Omit<QueuedPrompt, "id">) => void;
  /** Remove a single queued prompt by id (the ✕ on a queue chip). */
  removeQueuedPrompt: (sessionId: string, id: string) => void;
  /** Drop the entire queue for a session (the "清空" button). */
  clearPromptQueue: (sessionId: string) => void;
  /** If `sessionId` is fully idle (no running turn + no running background
   *  subagent) and its queue is non-empty, send the head prompt via
   *  `sendPrompt` and drop it from the queue. No-op otherwise. Called from
   *  the `turn.done` / `error` / sendTurn-failure paths so a queued prompt
   *  fires the moment the previous turn truly ends. Safe to call any time. */
  drainPromptQueueIfIdle: (sessionId: string) => void;
  /** Send a specific queued prompt immediately as a new turn. If the session
   *  is currently busy (running turn or running background subagent), it is
   *  interrupted first — `await interrupt()` clears `runningBySession` before
   *  sendPrompt runs. Only the targeted item is dropped; the rest stay queued.
   *  sendPrompt resets the interruptedBySession sentinel, so the old turn's
   *  late turn.done{interrupted} is filtered by the existing race guard. */
  sendQueuedPromptNow: (sessionId: string, id: string) => Promise<void>;
  /** Reorder a session's queue to match `newOrder` (a list of ids). Any ids
   *  present in the queue but missing from newOrder are appended at the end
   *  in their original order, so a malformed caller can't drop items. */
  reorderPromptQueue: (sessionId: string, newOrder: string[]) => void;

  /** Persist a session's composer draft (typed-but-unsent content) so it
   *  survives the ChatPane unmounting (thread switch / tab close). The owning
   *  ChatPane calls this on every content change (write-through). */
  saveComposerDraft: (sessionId: string, draft: ComposerDraft) => void;
  /** Drop a session's stored composer draft (empty composer / after send). */
  clearComposerDraft: (sessionId: string) => void;

  /* ── IDE right-panel actions ── */
  /** Switch the active right-panel tab. Persists to settings. */
  setRightPanelTab: (tab: RightPanelTab) => void;

  /* ── Side chat (right-panel ask tab) actions ── */
  /** Reveal the right panel and focus the sidechat tab (the ask-tab entry
   *  point behind the rail button / global shortcut). Does NOT create a
   *  session — creation is an explicit "+ 新问答" in the panel's list view. */
  openSideChatPanel: () => void;
  /** Fetch a main session's side chats into sideChatsByParent (idempotent
   *  refresh — also re-syncs titles/status after background changes). */
  hydrateSideChats: (parentSessionId: string) => Promise<void>;
  /** Create a fresh side chat under the ACTIVE main session, enter its chat
   *  view. Reuses the composer's global config slots (the user's current
   *  model/provider), mirroring sendPrompt's send-model guard. */
  createSideChat: () => Promise<void>;
  /** Enter a side chat's chat view (lazy-loads its persisted history). */
  selectSideChat: (sessionId: string) => Promise<void>;
  /** Leave the chat view, back to the ask tab's list view. */
  closeSideChatView: () => void;
  /** Send a main-session text selection to the side chat: ensures an active
   *  side chat exists for the ACTIVE main session (creating one if needed),
   *  reveals the right panel's ask tab, and seeds the side chat's composer
   *  with the text (see sideChatSeedBySession). No-op without an active
   *  main session or a configured model (createSideChat raises the config
   *  dialog in that case). */
  askInSideChat: (text: string) => Promise<void>;
  /** Clear a side chat's pending seed after its ChatPane consumed it. */
  drainSideChatSeed: (sessionId: string) => void;
  /** Open a subagent's read-only transcript in the right panel's sidechat
   *  tab (from the ActivityPopover's subagent row). Reveals the panel and
   *  posts a one-shot request SidePanel consumes to enter the view. */
  openSubagentTranscript: (sessionId: string, taskId: string) => void;
  /** Clear the one-shot subagent-view request after consumption. */
  clearPendingSubagentView: () => void;
  /** Queue a one-shot jump-to-bookmark for `sessionId`'s ChatPane (the
   *  palette's bookmark result). The caller is responsible for opening the
   *  session (selectProject/openTab) — this only stages the jump. */
  setPendingBookmarkJump: (jump: {
    sessionId: string;
    messageId: string;
    excerpt?: string;
  }) => void;
  /** Clear the one-shot bookmark jump (consumed, or abandoned as stale). */
  clearPendingBookmarkJump: () => void;

  /** Replace a single project's saved terminal quick-commands. Persists the
   *  whole per-project map (JSON-encoded) to settings. Both the terminal
   *  commands menu (quick-add) and the settings -> terminal panel call this.
   *  No-op if `projectId` is null (no active project). */
  setCustomCommandsByProject: (projectId: string, commands: CustomCommand[]) => void;
  /** Append a new command to a project's list. Generates a stable id. */
  addCustomCommand: (projectId: string, cmd: Omit<CustomCommand, "id">) => void;
  /** Replace an existing command (matched by id) within a project's list. */
  updateCustomCommand: (projectId: string, cmd: CustomCommand) => void;
  /** Remove a command (matched by id) from a project's list. */
  removeCustomCommand: (projectId: string, id: string) => void;
  /** Open a file in the Monaco editor (dedup + append to ideOpenFiles, set
   *  active). `opts.diff` opens it in diff mode (used by the 审查 button when
   *  a before-snapshot exists). `opts.line`/`opts.column` (1-based) request a
   *  goto-definition reveal once the editor mounts. Also bumps ideFocusNonce
   *  so App opens the right panel if it's collapsed. */
  openFileInIde: (
    filePath: string,
    opts?: { diff?: boolean; before?: string; line?: number; column?: number },
  ) => void;
  /** Clear a consumed pending reveal (called by EditPane after applying it). */
  clearIdePendingReveal: () => void;
  /** Push a location onto the active project's editor navigation-history back
   *  stack (dedups a consecutive identical entry, clears the forward stack).
   *  Called by openFileInIde/setIdeActiveFile when the user navigates away,
   *  and by the LSP providers for same-file jumps (Monaco navigates those
   *  natively, bypassing the store). */
  pushNavHistory: (entry: NavEntry) => void;
  /** Alt+← — go back to the previous editor location (cross-file or
   *  same-file). No-op when the back stack is empty. */
  navigateBack: () => void;
  /** Alt+→ — go forward again after one or more navigateBack calls. No-op
   *  when the forward stack is empty. */
  navigateForward: () => void;
  /** Remove a file from the editor's open list; active shifts to the
   *  previous file (or next, or null). */
  closeFileInIde: (filePath: string) => void;
  /** Remove every open file that lives under `dirPath` (prefix match), and
   *  drop expanded-dir records under it too. Used by the file-tree "删除"
   *  action when a directory is trashed, so stale editor tabs disappear. */
  closeFilesUnderDir: (dirPath: string) => void;
  /** Migrate editor state after a rename. For a file, the single open path is
   *  rewritten oldPath -> newPath (active / view-mode / diff-before keys too).
   *  For a directory, every open path and expanded-dir record under it is
   *  re-prefixed. Used by the file-tree "重命名" action. */
  renamePathInIde: (oldPath: string, newPath: string, isDir: boolean) => void;
  /** Close every open file EXCEPT the given one; the given file becomes
   *  active. Used by the tab context menu's "关闭其他". */
  closeOtherFilesInIde: (keepFilePath: string) => void;
  /** Close all open files; active becomes null (editor column hides). Used
   *  by the tab context menu's "关闭全部". */
  closeAllFilesInIde: () => void;
  /** Set the active file (must already be open). */
  setIdeActiveFile: (filePath: string) => void;
  /** Hide the editor column by clearing the active file, WITHOUT removing it
   *  from the open-files list. The editor column disappears; re-opening any
   *  file restores it. Used by the toolbar's editor-column toggle button. */
  clearIdeActiveFile: () => void;
  /** Move an open file within the editor's tab strip (drag-to-reorder).
   *  No-op for out-of-range / same index. Persists. */
  reorderIdeFile: (from: number, to: number) => void;
  /** Set a file's view mode (edit/diff). */
  setIdeFileViewMode: (filePath: string, mode: FileViewMode) => void;
  /** Switch the editor open-mode (tabs vs replace). Persists. When switching
   *  to "replace", if more than one file is open, keeps only the active one. */
  setIdeEditorMode: (mode: IdeEditorMode) => void;
  /** Set the git-diff open-mode (center vs dialog). Persists to settings. */
  setGitDiffOpenMode: (mode: GitDiffOpenMode) => void;
  /** Open (or refresh) a diff tab in the Git diff dialog. Dedups by file path
   *  (re-clicking the same file refreshes its before/after and activates it),
   *  then opens the dialog. Ephemeral (not persisted). */
  openGitDiffDialogTab: (tab: GitDiffDialogTab) => void;
  /** Remove a diff tab from the Git diff dialog. If the active tab is closed,
   *  activation shifts to an adjacent tab; if none remain the dialog closes. */
  closeGitDiffDialogTab: (id: string) => void;
  /** Set the active diff tab in the Git diff dialog. */
  setGitDiffDialogActive: (id: string | null) => void;
  /** Show/hide the Git diff dialog. Closing keeps the tabs so they can be
   *  re-opened from the Git panel toolbar button. */
  setGitDiffDialogOpen: (open: boolean) => void;
  /** Set the Git diff dialog's view mode: "tabs" (tab strip + file list) or
   *  "single" (file list only, no tab strip). Ephemeral (not persisted). */
  setGitDiffDialogViewMode: (mode: "tabs" | "single") => void;
  /** Toggle a directory's expanded state in the file tree. Persists. */
  toggleDirExpanded: (dirPath: string) => void;
  /** Explicitly set a directory's expanded state. Persists. */
  setDirExpanded: (dirPath: string, open: boolean) => void;
  /** Write content to disk via file.writeFile. Returns ok. Does NOT touch
   *  editor state — the caller (FileEditor) keeps its own dirty tracking. */
  saveFileContent: (filePath: string, content: string) => Promise<boolean>;
  /** Stash a git diff "before" content for a file so the center editor can
   *  show a Monaco diff against the working tree. Keyed by the active project.
   *  Ephemeral. Equivalent to `setGitDiffPair(path, { before })`. */
  setGitDiffBefore: (filePath: string, before: string) => void;
  /** Stash a before/after pair for Monaco diff. When `after` is set the
   *  DiffPane uses it directly (history commits); when omitted it reads disk. */
  setGitDiffPair: (filePath: string, pair: { before: string; after?: string }) => void;
  /** Clear a file's git diff pair (e.g. after the file is staged or discarded). */
  clearGitDiffBefore: (filePath: string) => void;
  /** Set the custom-model id used for commit-message generation. Persists. */
  setCommitGenModel: (modelId: string | null) => void;
  /** Set the prompt template for commit-message generation. Persists. */
  setCommitGenPrompt: (prompt: string) => void;
  /** Set the custom-model id used for AI git-conflict resolution. Persists. */
  setConflictResolveModel: (modelId: string | null) => void;
  /** Toggle auto thread-title generation on/off. Persists. */
  setTitleGenEnabled: (enabled: boolean) => void;
  /** Set the custom-model id used for auto thread-title generation. Persists. */
  setTitleGenModel: (modelId: string | null) => void;
  /** Set the Claude output style (null = CLI default). Persists. */
  setOutputStyle: (style: string | null) => void;
  /** Toggle a git repo card's collapsed state. Persists. */
  toggleCollapsedGitRepo: (repoPath: string) => void;
}

/** Map of messageId → msg for fast delta accumulation. */
function findMsg(list: ChatMessage[], messageId: string): ChatMessage | undefined {
  return list.find((m) => m.id === messageId);
}

/* ─── ChatMessage ↔ MessageRecord ───
 * The DB stores `content` as JSON. New rows store an object
 * `{ blocks, turnMeta? }`; legacy rows stored just the `blocks` array, which
 * we detect with Array.isArray for backward compatibility. Reloading a
 * session round-trips the exact blocks (and turn timing) the renderer built. */
function toRecords(sessionId: string, messages: ChatMessage[]): MessageRecord[] {
  return messages.map((m) => ({
    id: m.id,
    sessionId,
    role: m.role,
    content: m.turnMeta ? { blocks: m.blocks, turnMeta: m.turnMeta } : m.blocks,
    createdAt: m.createdAt,
  }));
}

/** Drop net-zero entries (`adds === 0 && dels === 0`) from `turn-files`
 *  blocks, and the block itself when nothing remains. Such entries are noise:
 *  a byte-identical rewrite, or a created file that was deleted again before
 *  the turn ended. FileSnapshot.freeze() filters them at the source now, but
 *  blocks persisted BEFORE that fix still carry them — prune at hydration so
 *  historical cards read the same as newly recorded ones. Returns the input
 *  array untouched when there is nothing to prune (cheap path for the common
 *  case). */
function pruneUnchangedTurnFileBlocks(blocks: Block[]): Block[] {
  let changed = false;
  const next: Block[] = [];
  for (const b of blocks) {
    if (b.kind !== "turn-files") {
      next.push(b);
      continue;
    }
    const files = b.files.filter((f) => f.adds > 0 || f.dels > 0);
    if (files.length === b.files.length) {
      next.push(b);
      continue;
    }
    changed = true;
    if (files.length > 0) next.push({ ...b, files });
    // files.length === 0 → the whole card was noise; drop the block.
  }
  return changed ? next : blocks;
}

function fromRecords(records: MessageRecord[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const r of records) {
    // Legacy rows: content is the blocks array. New rows: content is
    // { blocks, turnMeta? }. Degrade gracefully on unknown shapes.
    let blocks: Block[] = [];
    let turnMeta: TurnMeta | undefined;
    if (Array.isArray(r.content)) {
      blocks = r.content as Block[];
    } else if (r.content && typeof r.content === "object") {
      const obj = r.content as { blocks?: Block[]; turnMeta?: TurnMeta };
      if (Array.isArray(obj.blocks)) blocks = obj.blocks;
      if (obj.turnMeta) turnMeta = obj.turnMeta;
    }
    const pruned = pruneUnchangedTurnFileBlocks(blocks);
    // A message that consisted ONLY of pruned-to-nothing turn-files card(s)
    // would linger as a blank row — drop it (mirrors the plan-block pruning
    // in freezeOrPrunePlanBlocks). Messages that were already empty stay as
    // they were (pre-existing shape, rendering handles them).
    if (pruned.length === 0 && blocks.length > 0) continue;
    out.push({
      id: r.id,
      sessionId: r.sessionId,
      role: r.role === "user" ? "user" : "assistant",
      blocks: pruned,
      createdAt: r.createdAt,
      ...(turnMeta ? { turnMeta } : {}),
    });
  }
  return out;
}

/** Stable empty arrays so selectors never return a fresh [] (Zustand Object.is). */
export const EMPTY_MESSAGES: ChatMessage[] = [];
export const EMPTY_TODOS: TodoItem[] = [];
export const EMPTY_TURN_FILES: TurnFileEntry[] = [];
/** Stable empty chat-file queue reference (selector must return a stable array). */
export const EMPTY_CHAT_QUEUE: string[] = [];
/** Stable empty chat-element queue reference (selector must return a stable array). */
export const EMPTY_ELEMENT_QUEUE: PickedElement[] = [];
/** Stable empty prompt-queue reference (selector must return a stable array). */
export const EMPTY_PROMPT_QUEUE: QueuedPrompt[] = [];
const EMPTY_CUSTOM_MODELS: CustomModelPublic[] = [];
/** Stable empty map for lastModelByProvider (selector-stability rule). */
const EMPTY_LAST_MODEL_BY_PROVIDER: Record<string, { model: string; customModelId: string | null }> = {};
const EMPTY_PROVIDERS: ProviderInfo[] = [];
const EMPTY_PI_MODELS: BuiltinModelOption[] = [];
const EMPTY_SKILLS: SkillInfo[] = [];
const EMPTY_SESSIONS: Session[] = [];
export const EMPTY_SUBAGENTS: SubagentSnapshot[] = [];
/** Stable empty usage-history reference (selector must return a stable array). */
export const EMPTY_USAGE: TurnUsageRecord[] = [];
/** Stable empty bookmark-list reference (selector-stability rule). */
export const EMPTY_BOOKMARKS: SessionBookmark[] = [];
/** Stable cleared-plan reference — used both as the initial state and as
 *  the "not in plan mode" placeholder returned by selectors. */
export const EMPTY_PLAN: PlanDraft = { plan: "", phase: "cleared" };

/* ─── upstream-issue hint decay ──────────────────────────────────────
 * The bridge's retry statuses are transient by nature, but the happy-path
 * "ok" clear can be missed (the retried request belongs to a different
 * session sharing the bridge, or the SDK gave up before it). Each retry
 * (re)arms a decay timer so the hint can never linger forever. */
const upstreamIssueDecayTimers = new Map<string, ReturnType<typeof setTimeout>>();
const UPSTREAM_ISSUE_DECAY_MS = 30_000;

/** Drop a session's upstream-issue hint + its decay timer. Safe to call when
 *  neither exists. `set` is the store's setter — the helper builds the
 *  reference-preserving no-op patch when the bucket has nothing to clear. */
function clearUpstreamIssue(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  sid: string,
): void {
  const t = upstreamIssueDecayTimers.get(sid);
  if (t) {
    clearTimeout(t);
    upstreamIssueDecayTimers.delete(sid);
  }
  set((s) => {
    if (!(sid in s.upstreamIssueBySession)) return {};
    const bucket = { ...s.upstreamIssueBySession };
    delete bucket[sid];
    return { upstreamIssueBySession: bucket };
  });
}

/**
 * Persist the per-project IDE buckets (open files / active file / expanded
 * dirs) to the settings table. Each is stored as a JSON object keyed by
 * projectId. `viewMode` is NOT persisted here (it's ephemeral — see the field
 * doc).
 *
 * Every IDE action used to fire all THREE writes even when only one bucket
 * changed (a dir toggle also re-serialized openFiles + activeFile). Two fixes:
 * the flush is debounced (same pattern as the pane-width persist — bursts like
 * the reveal effect expanding several ancestor dirs coalesce), and each bucket
 * is diffed against the last value actually written so only changed buckets
 * hit the DB. Trailing debounce reads state at flush time, so the `get`
 * accessor is stashed rather than a snapshot.
 */
const IDE_BUCKETS_PERSIST_DEBOUNCE_MS = 400;
let ideBucketsPersistTimer: ReturnType<typeof setTimeout> | null = null;
let ideBucketsLastWritten: {
  openFiles: string;
  activeFile: string;
  expandedDirs: string;
} | null = null;
function persistIdeBuckets(get: () => SessionState): void {
  if (ideBucketsPersistTimer) clearTimeout(ideBucketsPersistTimer);
  ideBucketsPersistTimer = setTimeout(() => {
    ideBucketsPersistTimer = null;
    const s = get();
    const next = {
      openFiles: JSON.stringify(s.ideOpenFilesByProject),
      activeFile: JSON.stringify(s.ideActiveFileByProject),
      expandedDirs: JSON.stringify(s.ideExpandedDirsByProject),
    };
    const last = ideBucketsLastWritten;
    if (last?.openFiles !== next.openFiles) {
      void api.setting
        .set({ key: UI_IDE_OPEN_FILES_SETTING_KEY, value: next.openFiles })
        .catch((err) => console.error("setting.set(ideOpenFiles) failed:", err));
    }
    if (last?.activeFile !== next.activeFile) {
      void api.setting
        .set({ key: UI_IDE_ACTIVE_FILE_SETTING_KEY, value: next.activeFile })
        .catch((err) => console.error("setting.set(ideActiveFile) failed:", err));
    }
    if (last?.expandedDirs !== next.expandedDirs) {
      void api.setting
        .set({ key: UI_IDE_EXPANDED_DIRS_SETTING_KEY, value: next.expandedDirs })
        .catch((err) => console.error("setting.set(ideExpandedDirs) failed:", err));
    }
    ideBucketsLastWritten = next;
  }, IDE_BUCKETS_PERSIST_DEBOUNCE_MS);
}

/** Min/max chat content font size (px). The slider in Settings uses the
 *  same bounds; setChatFontSize clamps to this range defensively. */
export const CHAT_FONT_SIZE_MIN = 12;
export const CHAT_FONT_SIZE_MAX = 20;

/** Clamp a font-size value to the allowed slider range. */
export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return 14;
  return Math.min(CHAT_FONT_SIZE_MAX, Math.max(CHAT_FONT_SIZE_MIN, Math.round(px)));
}

/** Min/max right-panel (files / git / terminal) base font size (px). The
 *  slider in Settings uses the same bounds; setRightPanelFontSize clamps to
 *  this range defensively. */
export const RIGHT_PANEL_FONT_SIZE_MIN = 10;
export const RIGHT_PANEL_FONT_SIZE_MAX = 22;

/** Clamp a right-panel font-size value to the allowed slider range. */
export function clampRightPanelFontSize(px: number): number {
  if (!Number.isFinite(px)) return 14;
  return Math.min(
    RIGHT_PANEL_FONT_SIZE_MAX,
    Math.max(RIGHT_PANEL_FONT_SIZE_MIN, Math.round(px)),
  );
}

/** Min/max paste-to-card promotion threshold (characters). Pasting more than
 *  this many chars (or spanning more than the hardcoded 3-line threshold)
 *  promotes the content to a chip above the composer. The Settings "常规"
 *  panel uses the same bounds; setPasteTagThresholdChars clamps to this
 *  range defensively. */
export const PASTE_TAG_THRESHOLD_CHARS_MIN = 50;
export const PASTE_TAG_THRESHOLD_CHARS_MAX = 5000;

/** Clamp a paste-tag threshold value to the allowed range. */
export function clampPasteTagThresholdChars(n: number): number {
  if (!Number.isFinite(n)) return 200;
  return Math.min(
    PASTE_TAG_THRESHOLD_CHARS_MAX,
    Math.max(PASTE_TAG_THRESHOLD_CHARS_MIN, Math.round(n)),
  );
}

/* ─── Draggable pane-width bounds + clamps ───
 * Each pane's width is persisted (UI_PANE_WIDTHS_SETTING_KEY) and re-clamped
 * on hydrate so a corrupted/out-of-range stored value can't collapse a pane
 * below its usable minimum or stretch it past the screen. */

/** Min 12 ≈ 259px on a 2160px window — the user-tuned compact floor. The
 *  default (20%) is the fresh-window starting width; users can drag it down
 *  to the floor and it persists. */
export const LEFT_WIDTH_PCT_MIN = 12;
export const LEFT_WIDTH_PCT_MAX = 40;
export const LEFT_WIDTH_PCT_DEFAULT = 20;
export const RIGHT_WIDTH_MIN = 240;
export const RIGHT_WIDTH_MAX = 640;
/** Right-panel width that fits the sidebar browser's default iPhone 14 Pro
 *  emulation (393 CSS pt) plus the 48px icon rail + border. When the browser
 *  tab is FIRST opened (no tabs yet), the panel is widened to at least this so
 *  the mobile view isn't clamped narrower than a real phone. Never shrinks a
 *  wider panel; falls inside RIGHT_WIDTH_MAX. */
export const RIGHT_WIDTH_BROWSER_FIT = 442;
export const BOTTOM_TERMINAL_HEIGHT_MIN = 80;
export const BOTTOM_TERMINAL_HEIGHT_MAX = 600;
export const EDITOR_WIDTH_PCT_MIN = 20;
export const EDITOR_WIDTH_PCT_MAX = 80;

/** Clamp helper for the four persisted pane sizes. Falls back to defaults on
 *  any non-finite value so the layout never breaks. */
/** NOTE: the pct clamps deliberately do NOT round — percentage shares must
 *  stay fractional. A per-mousemove drag delta is a fraction of a percent
 *  (1px on a 2900px window ≈ 0.034%); rounding to integers turned every
 *  small delta into 0 (dead handle) until one big move jumped a whole
 *  percent (~29px) — the classic janky resizable. Fractional values keep
 *  the handle tracking the cursor pixel-for-pixel. */
export function clampLeftWidthPct(pct: number): number {
  if (!Number.isFinite(pct)) return LEFT_WIDTH_PCT_DEFAULT;
  return Math.min(
    LEFT_WIDTH_PCT_MAX,
    Math.max(LEFT_WIDTH_PCT_MIN, pct),
  );
}
export function clampRightWidth(px: number): number {
  if (!Number.isFinite(px)) return 360;
  return Math.min(RIGHT_WIDTH_MAX, Math.max(RIGHT_WIDTH_MIN, Math.round(px)));
}
export function clampBottomTerminalHeight(px: number): number {
  if (!Number.isFinite(px)) return 280;
  return Math.min(
    BOTTOM_TERMINAL_HEIGHT_MAX,
    Math.max(BOTTOM_TERMINAL_HEIGHT_MIN, Math.round(px)),
  );
}
export function clampEditorWidthPct(pct: number): number {
  // No rounding — see clampLeftWidthPct for why fractional pcts matter.
  if (!Number.isFinite(pct)) return 50;
  return Math.min(EDITOR_WIDTH_PCT_MAX, Math.max(EDITOR_WIDTH_PCT_MIN, pct));
}
/** Wide-panel split bounds. widePanelPct is the right panel's share of the
 *  chat|right split; DEFAULT 70 gives the requested 3:7. The bounds keep the
 *  chat column usable (min 30% = the left panel's floor) and the right panel
 *  dominant. In-memory (not persisted). */
export const WIDE_PANEL_PCT_MIN = 40;
export const WIDE_PANEL_PCT_MAX = 70;
export const WIDE_PANEL_PCT_DEFAULT = 70;

/** Clamp helper for the wide-panel percentage. Falls back to the default on
 *  any non-finite value. */
export function clampWidePanelPct(pct: number): number {
  // No rounding — see clampLeftWidthPct for why fractional pcts matter.
  if (!Number.isFinite(pct)) return WIDE_PANEL_PCT_DEFAULT;
  return Math.min(WIDE_PANEL_PCT_MAX, Math.max(WIDE_PANEL_PCT_MIN, pct));
}

/** Matches a well-formed space-separated "R G B" triplet (0–255 each),
 *  e.g. "124 58 237". Used to validate the user-message color setting
 *  (which feeds the --user-bubble CSS var). */
const RGB_TRIPLET_RE = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*$/;

/** True if `abs` is inside `root` (prefix match on path segments, not a raw
 *  string prefix — so "/foo/bar" doesn't match root "/foo/ba"). Renderer-side
 *  mirror of main's `safeResolveOk`: used to filter persisted IDE paths at
 *  hydration time. Handles the root === abs case (a file/dir AT the root). */
function isPathWithinRoot(root: string, abs: string): boolean {
  if (abs === root) return true;
  // Ensure the root is a directory boundary in the comparison.
  const r = root.endsWith("/") || root.endsWith("\\") ? root : root + "/";
  return abs.startsWith(r);
}

/** Page size for the left-bar thread list. The first page is fetched on
 *  init / project expand; further pages are appended on "加载更多". */
const SESSION_PAGE_SIZE = 5;

/** Messages per page when lazily loading session history. Large enough that a
 *  typical conversation fills the viewport in one fetch, small enough that
 *  very long threads (thousands of rows) stay snappy on first open. */
const MESSAGE_PAGE_SIZE = 200;

/** Find a session across the active per-project caches, the archived bin,
 *  and the global pinned bucket by id. The archived cache is consulted so
 *  that config hydration still finds a session a user just restored (and so
 *  deleted/restored fallbacks don't miss rows that were moved between
 *  caches); the pinned bucket because pinned rows LEAVE their project's
 *  active list and live in the global pinned section instead. */
function findSession(
  sessionsByProject: Record<string, Session[]>,
  archivedByProject: Record<string, Session[]>,
  pinnedSessions: Session[],
  id: string,
): Session | undefined {
  for (const list of Object.values(sessionsByProject)) {
    const hit = list?.find((s) => s.id === id);
    if (hit) return hit;
  }
  const pinnedHit = pinnedSessions.find((s) => s.id === id);
  if (pinnedHit) return pinnedHit;
  for (const list of Object.values(archivedByProject)) {
    const hit = list?.find((s) => s.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** Immutably patch a single cached session row (looked up by id across both
 *  the active and archived per-project caches) with a partial update, and
 *  return a new `sessionsByProject` (or archived) map reflecting the change.
 *
 *  Used to keep the in-memory session cache in sync with live updates that
 *  arrive via events (e.g. `token-usage.updated` refreshing a row's
 *  `contextSnapshot`) without reloading the whole list. Returns the original
 *  map reference when the session isn't cached (no-op), so callers can spread
 *  it unconditionally. */
function patchSessionInCache(
  byProject: Record<string, Session[]>,
  projectId: string,
  sessionId: string,
  patchFields: Partial<Session>,
): Record<string, Session[]> {
  const list = byProject[projectId];
  if (!list) return byProject;
  const idx = list.findIndex((s) => s.id === sessionId);
  if (idx === -1) return byProject;
  const nextList = list.slice();
  nextList[idx] = { ...nextList[idx], ...patchFields };
  return { ...byProject, [projectId]: nextList };
}

/** Keep the global pinned bucket ordered by pin recency (most recent pin
 *  first). The server already returns this order (`listPinned` orders by
 *  pinned_at DESC), so this only matters after local mutations. */
function sortPinnedByRecency(list: Session[]): Session[] {
  return list.slice().sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
}

/** Insert a session into an unpinned active list at its `updated_at` position
 *  (server order is updated_at DESC, ties created_at DESC). Used when a
 *  session returns from the pinned section to its project's loaded window. */
function insertByActivity(list: Session[], session: Session): Session[] {
  const i = list.findIndex((x) => x.updatedAt < session.updatedAt);
  return i === -1 ? [...list, session] : [...list.slice(0, i), session, ...list.slice(i)];
}

/** In-memory move for a pin toggle (shared by the local action and — via the
 *  `session.changed` reducer's idempotent echo — other clients' pin toggles):
 *  the server-fresh row moves between the owning project's active window and
 *  the global pinned bucket. Pinning takes the row OUT of sessionsByProject
 *  (totals shrink accordingly); unpinning re-inserts it at its updated_at
 *  position. If the owning project's window isn't loaded, the active list is
 *  untouched — loadSessions will fetch the row with the right filters. */
function applySessionPinnedState(s: SessionState, session: Session): Partial<SessionState> {
  const patch: Partial<SessionState> = {};
  const projectId = session.projectId;
  const isPinned = !session.archived && session.pinnedAt != null;

  // Global pinned bucket — upsert or evict, kept sorted by pin recency.
  const withoutPinned = s.pinnedSessions.filter((x) => x.id !== session.id);
  patch.pinnedSessions = isPinned
    ? sortPinnedByRecency([session, ...withoutPinned])
    : withoutPinned;

  // Project active window (if loaded).
  const activeList = s.sessionsByProject[projectId];
  if (activeList) {
    let next: Session[];
    let totalDelta = 0;
    if (isPinned || session.archived) {
      // Leaving the active window — pinned rows render in the global pinned
      // section, archived rows in the bin.
      next = activeList.filter((x) => x.id !== session.id);
      if (next.length !== activeList.length) totalDelta = -1;
    } else if (activeList.some((x) => x.id === session.id)) {
      next = activeList.map((x) => (x.id === session.id ? { ...x, ...session } : x));
    } else {
      next = insertByActivity(activeList, session);
      totalDelta = 1;
    }
    patch.sessionsByProject = { ...s.sessionsByProject, [projectId]: next };
    if (totalDelta !== 0) {
      const total = Math.max((s.sessionsTotalByProject[projectId] ?? 0) + totalDelta, 0);
      patch.sessionsTotalByProject = { ...s.sessionsTotalByProject, [projectId]: total };
      patch.sessionsHasMoreByProject = {
        ...s.sessionsHasMoreByProject,
        [projectId]: total > next.length,
      };
    }
  }

  // Archived bin row (a pinned-then-archived row still lives there) — keep
  // the cached copy fresh.
  const archivedList = s.archivedSessionsByProject[projectId];
  if (archivedList && archivedList.some((x) => x.id === session.id)) {
    patch.archivedSessionsByProject = {
      ...s.archivedSessionsByProject,
      [projectId]: archivedList.map((x) => (x.id === session.id ? { ...x, ...session } : x)),
    };
  }

  if (s.activeProjectId === projectId && patch.sessionsByProject) {
    patch.sessions = patch.sessionsByProject[projectId] ?? s.sessions;
  }
  return patch;
}

/** Materialize a full {@link Session} row from a slim list-sync entry. Heavy
 *  per-session payloads are null on a fresh row — a freshly-created session
 *  has them null anyway; updates merge the entry OVER the cached row instead
 *  (see the `session.changed` reducer). */
function materializeSessionEntry(entry: SessionListEntry): Session {
  return {
    ...entry,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    usageHistory: null,
    turnFiles: null,
    bookmarks: null,
    subagentTranscripts: null,
  };
}

/** Per-session buckets + queues to drop when ANY session is hard-deleted —
 *  shared verbatim by the main-session and side-chat paths of
 *  applySessionDeletedState. Pure: copies every touched bucket, removes the
 *  id's entry (and any timers / queue rows keyed by it), returns the patch
 *  fragment. Runs synchronously inside set() callbacks. */
function dropSessionBuckets(s: SessionState, id: string) {
  const messagesBySession = { ...s.messagesBySession };
  delete messagesBySession[id];
  const hasMoreMessagesBySession = { ...s.hasMoreMessagesBySession };
  delete hasMoreMessagesBySession[id];
  const loadingMessagesBySession = { ...s.loadingMessagesBySession };
  delete loadingMessagesBySession[id];
  const loadingOlderBySession = { ...s.loadingOlderBySession };
  delete loadingOlderBySession[id];
  const historyLoadedBySession = { ...s.historyLoadedBySession };
  delete historyLoadedBySession[id];
  const runningBySession = { ...s.runningBySession };
  delete runningBySession[id];
  const runningTurnStartedAt = { ...s.runningTurnStartedAt };
  delete runningTurnStartedAt[id];
  const interruptedBySession = { ...s.interruptedBySession };
  delete interruptedBySession[id];
  const upstreamIssueBySession = { ...s.upstreamIssueBySession };
  delete upstreamIssueBySession[id];
  // Also drop the hint's decay timer (module-level side effect — idempotent).
  const issueTimer = upstreamIssueDecayTimers.get(id);
  if (issueTimer) {
    clearTimeout(issueTimer);
    upstreamIssueDecayTimers.delete(id);
  }
  const unreadBySession = { ...s.unreadBySession };
  delete unreadBySession[id];
  const todosBySession = { ...s.todosBySession };
  delete todosBySession[id];
  const planBySession = { ...s.planBySession };
  delete planBySession[id];
  const subagentsBySession = { ...s.subagentsBySession };
  delete subagentsBySession[id];
  const subagentTranscriptsBySession = { ...s.subagentTranscriptsBySession };
  delete subagentTranscriptsBySession[id];
  const pendingQuestionBySession = { ...s.pendingQuestionBySession };
  delete pendingQuestionBySession[id];
  const turnFilesBySession = { ...s.turnFilesBySession };
  delete turnFilesBySession[id];
  const bookmarksBySession = { ...s.bookmarksBySession };
  delete bookmarksBySession[id];
  const chatFileQueueBySession = { ...s.chatFileQueueBySession };
  delete chatFileQueueBySession[id];
  const chatElementQueueBySession = { ...s.chatElementQueueBySession };
  delete chatElementQueueBySession[id];
  const contextSnapshotBySession = { ...s.contextSnapshotBySession };
  delete contextSnapshotBySession[id];
  const usageHistoryBySession = { ...s.usageHistoryBySession };
  delete usageHistoryBySession[id];
  const pendingPlanApprovalBySession = { ...s.pendingPlanApprovalBySession };
  delete pendingPlanApprovalBySession[id];
  const planDrawerPlanBySession = { ...s.planDrawerPlanBySession };
  delete planDrawerPlanBySession[id];
  const planTabActiveBySession = { ...s.planTabActiveBySession };
  delete planTabActiveBySession[id];
  const planApprovalDraftBySession = { ...s.planApprovalDraftBySession };
  delete planApprovalDraftBySession[id];
  const composerDraftBySession = { ...s.composerDraftBySession };
  delete composerDraftBySession[id];
  const sideChatSeedBySession = { ...s.sideChatSeedBySession };
  delete sideChatSeedBySession[id];
  const pendingApprovals = s.pendingApprovals.filter((p) => p.sessionId !== id);
  return {
    messagesBySession,
    hasMoreMessagesBySession,
    loadingMessagesBySession,
    loadingOlderBySession,
    historyLoadedBySession,
    runningBySession,
    runningTurnStartedAt,
    interruptedBySession,
    upstreamIssueBySession,
    unreadBySession,
    todosBySession,
    planBySession,
    subagentsBySession,
    subagentTranscriptsBySession,
    pendingQuestionBySession,
    turnFilesBySession,
    bookmarksBySession,
    chatFileQueueBySession,
    chatElementQueueBySession,
    contextSnapshotBySession,
    usageHistoryBySession,
    pendingPlanApprovalBySession,
    planDrawerPlanBySession,
    planTabActiveBySession,
    planApprovalDraftBySession,
    composerDraftBySession,
    sideChatSeedBySession,
    pendingApprovals,
  };
}

/** In-memory cleanup for a hard-deleted session — shared by the local
 *  `deleteSession` action and the remote `session.deleted` event reducer, so a
 *  phone deleting a thread cleans the desktop's lists/tabs/buckets exactly
 *  like a local delete. Covers side chats too: kind="side" rows live outside
 *  the left-bar caches, in their parent's sideChatsByParent bucket. Pure:
 *  takes the current state, returns the patch. */
function applySessionDeletedState(s: SessionState, id: string): Partial<SessionState> {
  // Find which project + cache owns this session.
  let projectId: string | undefined;
  let inArchived = false;
  let inPinned = false;
  for (const [pid, list] of Object.entries(s.sessionsByProject)) {
    if (list?.some((sess) => sess.id === id)) { projectId = pid; inArchived = false; break; }
  }
  // Pinned rows aren't in the per-project caches — they live in the global
  // pinned bucket, so look there before the archived bin.
  if (!projectId) {
    const pinnedRow = s.pinnedSessions.find((sess) => sess.id === id);
    if (pinnedRow) { projectId = pinnedRow.projectId; inPinned = true; }
  }
  if (!projectId) {
    for (const [pid, list] of Object.entries(s.archivedSessionsByProject)) {
      if (list?.some((sess) => sess.id === id)) { projectId = pid; inArchived = true; break; }
    }
  }
  if (!projectId) {
    // Not in the left-bar caches — check the ask-tab buckets. Side chats
    // (kind="side") hang off their parent under sideChatsByParent and are
    // invisible everywhere else. Hard-deleting one removes it from that
    // list; if it was open, the panel falls back to the list view (the
    // derived view switch needs no explicit reset beyond clearing the id).
    const parent = Object.keys(s.sideChatsByParent).find((key) =>
      s.sideChatsByParent[key]?.some((x) => x.id === id),
    );
    if (!parent) return {};
    const list = s.sideChatsByParent[parent] ?? [];
    return {
      sideChatsByParent: { ...s.sideChatsByParent, [parent]: list.filter((x) => x.id !== id) },
      ...dropSessionBuckets(s, id),
      ...(s.activeSideChatId === id ? { activeSideChatId: null } : {}),
    };
  }
  const prevList = inPinned
    ? s.pinnedSessions
    : (inArchived ? s.archivedSessionsByProject : s.sessionsByProject)[projectId] ?? [];
  const nextList = prevList.filter((sess) => sess.id !== id);
  // For a pinned row the project's active window is untouched; all
  // total/hasMore math below must reference it rather than the pinned bucket.
  const activeWindowLen = inPinned
    ? (s.sessionsByProject[projectId]?.length ?? 0)
    : nextList.length;
  const sessionsByProject = { ...s.sessionsByProject };
  const archivedByProject = { ...s.archivedSessionsByProject };
  // Replace the touched cache. Empty archived cache entries are dropped
  // so the "已归档" bin doesn't render empty project groups.
  if (inPinned) {
    // Row leaves the pinned bucket only; project caches are untouched.
  } else if (inArchived) {
    if (nextList.length > 0) archivedByProject[projectId] = nextList;
    else delete archivedByProject[projectId];
  } else {
    sessionsByProject[projectId] = nextList;
  }
  // Active-thread totals only move when an active (non-archived,
  // non-pinned) row is deleted; archived / pinned rows aren't part of the
  // active count.
  const totalActive = inArchived || inPinned
    ? (s.sessionsTotalByProject[projectId] ?? 0)
    : Math.max((s.sessionsTotalByProject[projectId] ?? 0) - 1, 0);
  const hasMoreActive = inPinned
    ? (s.sessionsHasMoreByProject[projectId] ?? false)
    : totalActive > activeWindowLen;
  // Drop all per-session buckets for this id (helper above). The session is
  // gone for good; no point keeping its messages / running flag / question
  // / approval queue / files in memory. The ask-tab list goes too: deleting
  // a main session orphans its side chats in the DB (delete() nulls their
  // parent_session_id), so the in-memory bucket would only go stale — and
  // an open side chat of the deleted parent falls back to the list view.
  const dropped = dropSessionBuckets(s, id);
  const hadSideChats = id in s.sideChatsByParent;
  const sideChatsByParent = { ...s.sideChatsByParent };
  let activeSideChatId = s.activeSideChatId;
  if (hadSideChats) {
    if ((sideChatsByParent[id] ?? []).some((x) => x.id === activeSideChatId)) {
      activeSideChatId = null;
    }
    delete sideChatsByParent[id];
  }
  // Drop the session from the tab strip too. If it was the active tab,
  // the focus jumps to the previous tab (openTab logic replicated
  // inline since we're already inside a `set` callback).
  const idx = s.openTabs.indexOf(id);
  const openTabs = idx === -1 ? s.openTabs : s.openTabs.filter((sid) => sid !== id);
  const wasActive = s.activeSessionId === id;
  if (!wasActive) {
    return {
      sessionsByProject,
      archivedSessionsByProject: archivedByProject,
      ...(inPinned ? { pinnedSessions: nextList } : {}),
      sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: totalActive },
      sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: hasMoreActive },
      ...dropped,
      ...(hadSideChats ? { sideChatsByParent } : {}),
      ...(activeSideChatId !== s.activeSideChatId ? { activeSideChatId } : {}),
      openTabs,
    };
  }
  // Was the active tab. Land on the previous tab if any, otherwise the
  // new tail, otherwise null (empty-state placeholder).
  let nextActive: string | null = null;
  if (openTabs.length > 0) {
    nextActive = idx > 0 ? openTabs[idx - 1] : openTabs[0];
  }
  const isActiveProject = projectId === s.activeProjectId;
  // For a pinned row the fallback candidate comes from the project's active
  // window (unchanged by this delete), not from the pinned bucket.
  const nextInProject = isActiveProject
    ? (inPinned ? (s.sessionsByProject[projectId] ?? []) : nextList).find((sess) => !sess.archived)
    : null;
  // If the new active session is the fallback one, sync its config
  // into the global slots so the composer chips show the right
  // model/effort/permission.
  const finalActive = nextActive ?? nextInProject?.id ?? null;
  const sess = finalActive
    ? findSession(sessionsByProject, archivedByProject, inPinned ? nextList : s.pinnedSessions, finalActive)
    : undefined;
  // Clear the new active session's unread badge - it's now visible.
  if (finalActive) delete dropped.unreadBySession[finalActive];
  return {
    sessionsByProject,
    archivedSessionsByProject: archivedByProject,
    ...(inPinned ? { pinnedSessions: nextList } : {}),
    sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: totalActive },
    sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: hasMoreActive },
    ...dropped,
    ...(hadSideChats ? { sideChatsByParent } : {}),
    ...(activeSideChatId !== s.activeSideChatId ? { activeSideChatId } : {}),
    openTabs,
    sessions: isActiveProject ? nextList : s.sessions,
    activeSessionId: finalActive,
    model: sess?.model ?? s.model,
    effort: sess?.effort ?? s.effort,
    permissionMode: sess?.permissionMode ?? s.permissionMode,
    customModelId: sess?.customModelId ?? s.customModelId,
  };
}

/** Read a session's persisted config (model / effort / permissionMode /
 *  customModelId) into the global view slots so the composer renders the
 *  active thread's choices. If the session can't be found (not yet loaded,
 *  or unknown id), leaves the slot untouched — better to keep a previous
 *  valid value than to flash a placeholder while the cache is filling. */
function syncConfigFromSession(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, sessionId);
  if (!sess) return;
  // Keep activeProjectId in lockstep with the active session's owning project.
  // Without this, switching to a thread in project B while activeProjectId
  // still points at project A would leave the IDE file tree (and any
  // project-scoped UI) showing the wrong project. Every entry point that
  // activates a session (selectSession / openTab / rewindTurn) routes through
  // this helper, so this single sync covers all of them.
  const prevPid = get().activeProjectId;
  const patch: Partial<SessionState> = {
    providerId: sess.providerId,
    model: sess.model,
    effort: sess.effort,
    permissionMode: sess.permissionMode,
    customModelId: sess.customModelId,
    activeProjectId: sess.projectId,
  };
  // The `sessions` field is a derived view of the ACTIVE project's session
  // list (see its field doc). selectProject refreshes it, but selectSession /
  // openTab do NOT - so activating a thread in a different project left
  // `sessions` pointing at the old project's list. Titlebar resolves the
  // active thread's title via `sessions.find(activeSessionId)`, which then
  // missed (the thread isn't in the old list) and the title chip vanished.
  // Refresh the alias whenever the owning project changes.
  if (prevPid !== sess.projectId) {
    patch.sessions = get().sessionsByProject[sess.projectId] ?? EMPTY_SESSIONS;
  }
  // Auto-expand the session's owning project whenever a session is activated.
  // selectSession (tab click) and openTab (left-bar click) both route through
  // here; without this, switching to a thread in a collapsed project leaves the
  // left bar showing the project row but not the thread under it, so the user
  // can't see which thread became active. Other projects' expand state is
  // preserved.
  if (!get().expandedProjects[sess.projectId]) {
    patch.expandedProjects = { ...get().expandedProjects, [sess.projectId]: true };
  }
  // Same idea for the session's worktree group: activating a thread bound to
  // an isolated checkout must reveal the group node it buckets under,
  // otherwise the newly-active row stays invisible inside a collapsed group.
  if (sess.worktreePath && !get().expandedWorktrees[normWorktreeKey(sess.worktreePath)]) {
    patch.expandedWorktrees = {
      ...get().expandedWorktrees,
      [normWorktreeKey(sess.worktreePath)]: true,
    };
  }
  // ...and the project's left-bar VIEW must show the side the active thread
  // lives on: a worktree thread while the project shows local-only would be
  // invisible. Only flips toward worktrees — activating a local thread never
  // yanks the user out of a worktree view they opened deliberately.
  if (sess.worktreePath && !get().worktreeViewByProject[sess.projectId]) {
    patch.worktreeViewByProject = { ...get().worktreeViewByProject, [sess.projectId]: true };
  }
  set(patch);

  // Remember the last-activated project + session so the next launch can
  // restore the user's landing spot instead of always opening the first
  // project. Fire-and-forget: a failed write just falls back to the default
  // selection on next boot. Both session-activation entry points (selectSession
  // / openTab) route through here, so this single write covers them.
  void api.setting.set({ key: UI_LAST_SESSION_SETTING_KEY, value: sessionId });
  void api.setting.set({ key: UI_LAST_PROJECT_SETTING_KEY, value: sess.projectId });
}

/**
 * Resolve the model a send should actually use.
 *
 * An explicit selection (`model !== "default"`) passes through untouched —
 * except for pi, whose ids must resolve against `piAvailableModels` (the
 * picker's only surface): a stale id (provider deleted mid-session, or a
 * builtin-catalog id like "anthropic/…" picked before the list was filtered
 * to user-configured providers) falls through to the default resolution
 * instead of sending a model that was never actually configured.
 * "default" (the chip's "默认"/auto) means "the first configured model" —
 * the lists mirror the ModelDropdown's selectable surface per provider:
 *
 *   - pi-sdk   → `piAvailableModels` (dynamic, user-configured) → first id
 *   - claude   → `customModels` (user-configured gateways) → first config's
 *                first model (same pick as `setCustomModel`'s fallback)
 *   - other    → `capabilities.builtinModels` → first concrete entry
 *                (skipping the "default"/Auto placeholder)
 *
 * Returns null when the active provider has NO model to send with — the
 * caller then prompts the user to configure one instead of silently falling
 * back to the provider's internal default (which, after an SDK switch to
 * auto, is exactly the trap this guard exists to avoid).
 */
function resolveSendModel(
  s: Pick<SessionState, "model" | "customModelId" | "providerId" | "providers" | "customModels" | "piAvailableModels">,
): { model: string; customModelId: string | null } | null {
  const provider = s.providers.find((p) => p.id === s.providerId);
  if (provider?.id === "pi-sdk") {
    if (s.model !== "default" && s.piAvailableModels.some((m) => m.id === s.model)) {
      return { model: s.model, customModelId: null };
    }
    const first = s.piAvailableModels[0];
    return first ? { model: first.id, customModelId: null } : null;
  }
  if (s.model !== "default") return { model: s.model, customModelId: s.customModelId };
  if (!provider) return null;
  if (provider.id === "claude-sdk") {
    for (const cfg of s.customModels) {
      const first = cfg.models.find((m) => m.id.trim());
      if (first) return { model: first.id, customModelId: cfg.id };
    }
    return null;
  }
  const builtins = provider.capabilities.builtinModels ?? [];
  const first = builtins.find((b) => b.id !== "default") ?? builtins[0];
  return first ? { model: first.id, customModelId: null } : null;
}

/** Persist the composer's current provider/model choice — the "next session"
 *  defaults — so the next launch pre-selects the same SDK + model the user
 *  last picked (setProvider / setModel / setCustomModel call this). Fire-and-
 *  forget, like the other setting.set callers. */
function persistComposerSelection(
  s: Pick<SessionState, "providerId" | "model" | "customModelId" | "lastModelByProvider">,
): void {
  void api.setting
    .set({
      key: UI_COMPOSER_MODEL_SETTING_KEY,
      value: JSON.stringify({
        providerId: s.providerId,
        model: s.model,
        customModelId: s.customModelId,
        lastModelByProvider: s.lastModelByProvider,
      }),
    })
    .catch((err) => {
      console.error("setting.set(composerModel) failed:", err);
    });
}

/** Validate a remembered {model, customModelId} pair against the CURRENT
 *  provider + model lists — same rules as validateComposerSelection. Returns
 *  the entry when still valid, null when the model was deleted (caller then
 *  falls back to "default"). */
function isValidRememberedModel(
  s: Pick<SessionState, "providers" | "customModels" | "piAvailableModels">,
  providerId: string,
  entry: { model: string; customModelId: string | null } | undefined,
): entry is { model: string; customModelId: string | null } {
  if (!entry || entry.model === "default") return !!entry;
  const provider = s.providers.find((p) => p.id === providerId);
  if (!provider) return false;
  if (provider.id === "pi-sdk") {
    return s.piAvailableModels.some((m) => m.id === entry.model);
  }
  if (provider.id === "claude-sdk") {
    const cfg = s.customModels.find((m) => m.id === entry.customModelId);
    return (
      !!cfg &&
      !!entry.customModelId &&
      cfg.models.some((m) => m.id === entry.model && m.id.trim())
    );
  }
  return (provider.capabilities.builtinModels ?? []).some((b) => b.id === entry.model);
}

/**
 * Drop a stale persisted composer choice back to auto. Runs after the model
 * lists reload (providers / custom endpoints / pi models): if the persisted
 * provider no longer exists, or the chosen model was deleted (custom config
 * removed / pi model gone), the selection falls back to the default provider
 * + "default" (auto) — and the reset is persisted so it doesn't reapply a
 * stale choice on the next launch. Sessions that already have messages are
 * skipped: their config is row-authoritative and re-synced on select.
 */
function validateComposerSelection(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
): void {
  const s = get();
  const activeId = s.activeSessionId;
  if (activeId) {
    const bucket = s.messagesBySession[activeId];
    if (bucket && bucket.length > 0) return;
  }
  // Already auto with no custom config → nothing to validate.
  if (s.model === "default" && !s.customModelId) return;

  const provider = s.providers.find((p) => p.id === s.providerId);
  let patch: Partial<SessionState> | null = null;
  if (!provider) {
    // The SDK itself is gone (unregistered) — reset to the default provider.
    patch = { providerId: DEFAULT_PROVIDER_ID, model: "default", customModelId: null };
  } else if (provider.id === "pi-sdk") {
    const ok = s.piAvailableModels.some((m) => m.id === s.model);
    if (!ok) patch = { model: "default", customModelId: null };
  } else if (provider.id === "claude-sdk") {
    // Valid only when the custom config still exists AND the selected model
    // is still configured on it.
    const cfg = s.customModels.find((m) => m.id === s.customModelId);
    const ok =
      !!cfg &&
      !!s.customModelId &&
      cfg.models.some((m) => m.id === s.model && m.id.trim());
    if (!ok) patch = { model: "default", customModelId: null };
  } else {
    const ok = (provider.capabilities.builtinModels ?? []).some((b) => b.id === s.model);
    if (!ok) patch = { model: "default", customModelId: null };
  }
  if (!patch) return;
  // Also drop the stale remembered model for the current provider so a later
  // SDK switch back doesn't restore a deleted model.
  if (s.providerId in s.lastModelByProvider) {
    const { [s.providerId]: _drop, ...rest } = s.lastModelByProvider;
    patch = { ...patch, lastModelByProvider: rest };
  }
  set(patch);
  persistComposerSelection(get());
}

/** Hydrate the per-session context-window snapshot from the session row.
 *  The snapshot is persisted by main on every `token-usage.updated` event
 *  (RuntimeManager.emit), so on select/open-tab we can restore the last
 *  known occupancy without waiting for the next event. Pre-refactor rows
 *  may hold a stale raw-usage object (no `usedTokens` / `pct` / …) -
 *  `isValidSnapshot` guards against those so the chip doesn't render NaN.
 *
 *  When the row carries no valid snapshot we leave any existing
 *  `contextSnapshotBySession[sid]` slot untouched rather than clearing it.
 *  The slot may already hold a fresher value pushed by a live
 *  `token-usage.updated` event (e.g. re-entering a still-running thread),
 *  and clobbering it with `delete` here is what made the context ring
 *  disappear on re-entry until the next event happened to arrive. An empty
 *  row genuinely never had a snapshot, in which case the slot is already
 *  undefined and the ring correctly stays hidden until the first event. */
function hydrateContextSnapshot(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, sessionId);
  const snapshot = sess?.contextSnapshot;
  if (!snapshot || !isValidSnapshot(snapshot)) {
    // No usable snapshot on the row - leave any existing slot as-is so we
    // don't wipe a fresher live value. (Switching to a session that truly
    // has no snapshot still shows no ring, since the slot is undefined.)
    return;
  }
  set((s) => {
    const prev = s.contextSnapshotBySession[sessionId];
    // Skip the write if the cached row's snapshot is the same reference we
    // already have - avoids a spurious new-object allocation on every tab
    // switch and the re-render it would trigger in ComposerToolbar.
    if (prev === snapshot) return {};
    return {
      contextSnapshotBySession: { ...s.contextSnapshotBySession, [sessionId]: snapshot },
    };
  });
}

/** Hydrate the capsule state slices (todos / subagents / plan draft) from
 *  the session row. Each slice is restored independently — a session may
 *  have todos but no subagents, etc. Slices absent on the row are cleared
 *  so switching FROM a session with data TO one without doesn't leave the
 *  previous capsule stale. Mirrors hydrateContextSnapshot's pattern. */

/** Drop legacy non-agent entries from a persisted subagent roster. Rosters
 *  written before the adapter's NON_AGENT_TASK_TYPES filter could contain
 *  CLI bash tasks (`sleep` waits etc.) stuck on "running" — the CLI doesn't
 *  emit a closing task_updated for them mid-turn, so they poisoned both the
 *  capsule and the busy/queue gate. A non-backgrounded "running" entry
 *  cannot exist at rest in clean data (flushFinal completes them at turn
 *  end), so dropping is safe. Memoized per raw-array reference so the
 *  "already matches" guard in hydrateCapsule stays reference-stable. */
const sanitizeSubagentRoster = (() => {
  const cache = new WeakMap<SubagentSnapshot[], SubagentSnapshot[]>();
  return (list: SubagentSnapshot[]): SubagentSnapshot[] => {
    const hit = cache.get(list);
    if (hit) return hit;
    const dirty = list.some((a) => a.status === "running" && !a.isBackgrounded);
    const out = dirty ? list.filter((a) => !(a.status === "running" && !a.isBackgrounded)) : list;
    cache.set(list, out);
    return out;
  };
})();

function hydrateCapsule(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, sessionId);
  const todos = sess?.todos ?? null;
  const subagents = sess?.subagents ?? null;
  const planDraft = sess?.planDraft ?? null;
  set((s) => {
    // Sanitize before the has/same checks: a legacy roster whose entries
    // are ALL stale running bash tasks sanitizes to empty and must clear
    // the capsule slice, not keep the raw array.
    const cleanSubagents =
      subagents && Array.isArray(subagents) && subagents.length > 0
        ? sanitizeSubagentRoster(subagents)
        : null;
    // A RUNNING turn owns the roster — its event stream is fresher than the
    // cached row (which predates the turn), so hydrating from it would clobber
    // live subagents. The turn.done row-patch syncs the terminal state; only
    // an at-rest session hydrates from the row.
    const running = s.runningBySession[sessionId] === true;
    const hasTodos = !!(todos && Array.isArray(todos) && todos.length > 0);
    const hasSubagents = !!cleanSubagents;
    const hasPlan = !!(planDraft && planDraft.phase !== "cleared" && planDraft.plan);
    // If this session was manually interrupted, the persisted roster may
    // still carry `running` subagents (the abort's flushFinal runs async and
    // can race this hydration). Demote any `running` entry to `killed` so
    // re-entering the thread can't resurrect "运行中" subagents the user
    // already stopped. Mirrors the late-event guard in the subagent.update
    // handler below. The rewrite always yields a fresh array, so an
    // interrupted session is treated as always-changed (rare edge).
    const interrupted = !!s.interruptedBySession[sessionId];
    // Per-slice "already matches" guards — re-switching to an already-loaded
    // tab used to clone all three maps unconditionally, tripping subscriber
    // re-renders even when nothing changed.
    const todosSame = hasTodos
      ? s.todosBySession[sessionId] === todos
      : !(sessionId in s.todosBySession);
    // Running turn: skip the roster slice entirely (see `running` above).
    const subagentsSame = running
      ? true
      : interrupted
        ? false
        : hasSubagents
          ? s.subagentsBySession[sessionId] === cleanSubagents
          : !(sessionId in s.subagentsBySession);
    const planSame = hasPlan
      ? s.planBySession[sessionId] === planDraft
      : !(sessionId in s.planBySession);
    if (todosSame && subagentsSame && planSame) return {};

    // Clone + patch only the slices that actually changed.
    const patch: Partial<
      Pick<SessionState, "todosBySession" | "subagentsBySession" | "planBySession">
    > = {};
    if (!todosSame) {
      const todosBySession = { ...s.todosBySession };
      if (hasTodos) todosBySession[sessionId] = todos as TodoItem[];
      else delete todosBySession[sessionId];
      patch.todosBySession = todosBySession;
    }
    if (!subagentsSame) {
      const subagentsBySession = { ...s.subagentsBySession };
      if (cleanSubagents) {
        subagentsBySession[sessionId] = interrupted
          ? cleanSubagents.map((a) =>
              a.status === "running" ? { ...a, status: "killed" as const } : a,
            )
          : cleanSubagents;
      } else {
        delete subagentsBySession[sessionId];
      }
      patch.subagentsBySession = subagentsBySession;
    }
    if (!planSame) {
      const planBySession = { ...s.planBySession };
      if (planDraft && planDraft.phase !== "cleared" && planDraft.plan) {
        planBySession[sessionId] = planDraft as PlanDraft;
      } else {
        delete planBySession[sessionId];
      }
      patch.planBySession = planBySession;
    }
    return patch;
  });
}

/** Hydrate the per-turn modified-files card from the session row. The card is
 *  persisted so it survives a session reopen. An absent/empty turnFiles on the
 *  row is cleared so switching FROM a session with a card TO one without
 *  doesn't leave the old card up. Mirrors hydrateCapsule's pattern. */
function hydrateTurnFiles(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, sessionId);
  const turnFiles = sess?.turnFiles ?? null;
  set((s) => {
    const hasValue = !!(turnFiles && Array.isArray(turnFiles) && turnFiles.length > 0);
    const hadValue = sessionId in s.turnFilesBySession;
    // Skip the write when the cached row's value is already the reference we
    // have, or both sides are empty — otherwise re-switching to an
    // already-loaded tab clones the map and trips a subscriber re-render for
    // nothing. Mirrors hydrateContextSnapshot's prev===snapshot guard.
    if (hasValue ? s.turnFilesBySession[sessionId] === turnFiles : !hadValue) return {};
    const next = { ...s.turnFilesBySession };
    if (turnFiles && Array.isArray(turnFiles) && turnFiles.length > 0) {
      next[sessionId] = turnFiles;
    } else {
      delete next[sessionId];
    }
    return { turnFilesBySession: next };
  });
}

/** Hydrate the per-session bookmark list from the session row. Persisted on
 *  the row so the capsule segment + timeline markers survive a reopen. An
 *  absent/empty list on the row clears the bucket so switching sessions
 *  doesn't leave the previous thread's bookmarks up. Mirrors
 *  hydrateTurnFiles's pattern (including the reference-equality guard). */
function hydrateBookmarks(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, sessionId);
  const bookmarks = sess?.bookmarks ?? null;
  set((s) => {
    const hasValue = !!(bookmarks && Array.isArray(bookmarks) && bookmarks.length > 0);
    const hadValue = sessionId in s.bookmarksBySession;
    // Same skip-write guard as hydrateTurnFiles: avoid cloning the map (and
    // tripping subscribers) when nothing actually changed.
    if (hasValue ? s.bookmarksBySession[sessionId] === bookmarks : !hadValue) return {};
    const next = { ...s.bookmarksBySession };
    if (bookmarks && Array.isArray(bookmarks) && bookmarks.length > 0) {
      next[sessionId] = bookmarks;
    } else {
      delete next[sessionId];
    }
    return { bookmarksBySession: next };
  });
}

/** Hydrate the per-session subagent transcripts from the session row (the
 *  side-panel subagent viewer's data source). Persisted by main after every
 *  transcript update; absent/empty on the row clears the bucket so switching
 *  sessions doesn't leave the previous thread's transcripts up. Mirrors
 *  hydrateBookmarks's pattern (including the reference-equality guard). */
function hydrateSubagentTranscripts(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, sessionId);
  const transcripts = sess?.subagentTranscripts ?? null;
  set((s) => {
    // A running turn owns the transcripts — its event stream is fresher than
    // the cached row (which predates the turn); hydrating from it would
    // clobber live subagent content. turn.done's row-patch syncs the final
    // state; only an at-rest session hydrates from the row.
    if (s.runningBySession[sessionId] === true) return {};
    const hasValue = !!(transcripts && Object.keys(transcripts).length > 0);
    const hadValue = sessionId in s.subagentTranscriptsBySession;
    if (hasValue ? s.subagentTranscriptsBySession[sessionId] === transcripts : !hadValue) return {};
    const next = { ...s.subagentTranscriptsBySession };
    if (hasValue) next[sessionId] = transcripts;
    else delete next[sessionId];
    return { subagentTranscriptsBySession: next };
  });
}

/** Patch ONLY the bookmarks field on the cached session row(s), keeping the
 *  caller's array reference so a follow-up hydrateBookmarks hits its
 *  reference-equality guard and skips the write. Unlike
 *  applySessionPinnedState this must NOT re-sort or move the row — a bookmark
 *  write must not re-order the session list. No-op when no cache holds the
 *  row (e.g. a side chat, which the caches don't track). */
function patchSessionRowBookmarks(
  s: SessionState,
  sessionId: string,
  projectId: string,
  bookmarks: SessionBookmark[],
): Partial<SessionState> {
  const patch: Partial<SessionState> = {};
  const mapRow = (x: Session) => (x.id === sessionId ? { ...x, bookmarks } : x);
  const activeList = s.sessionsByProject[projectId];
  if (activeList?.some((x) => x.id === sessionId)) {
    patch.sessionsByProject = { ...s.sessionsByProject, [projectId]: activeList.map(mapRow) };
  }
  const archivedList = s.archivedSessionsByProject[projectId];
  if (archivedList?.some((x) => x.id === sessionId)) {
    patch.archivedSessionsByProject = {
      ...s.archivedSessionsByProject,
      [projectId]: archivedList.map(mapRow),
    };
  }
  if (s.pinnedSessions.some((x) => x.id === sessionId)) {
    patch.pinnedSessions = s.pinnedSessions.map(mapRow);
  }
  return patch;
}

/** Hydrate the per-turn usage history from the session row. The history is
 *  persisted at each turn-end (main process), so it survives restart. Absent
 *  history on the row is cleared so switching FROM a session with history TO
 *  one without doesn't leave the previous thread's rows up. */
function hydrateUsageHistory(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, sessionId);
  const history = sess?.usageHistory ?? null;
  set((s) => {
    const hasValue = !!(history && Array.isArray(history) && history.length > 0);
    const hadValue = sessionId in s.usageHistoryBySession;
    // Skip the write when the cached row's history is already the reference we
    // have, or both sides are empty — otherwise re-switching to an
    // already-loaded tab clones the map and trips a subscriber re-render.
    if (hasValue ? s.usageHistoryBySession[sessionId] === history : !hadValue) return {};
    // Defensive: a live bucket can be AHEAD of the row cache — the turn.done
    // append mirrors into the row, but that mirror is best-effort (archived
    // rows aren't patched; any future append path that misses it would
    // regress the same way). Hydration reads the ROW; it must never shrink a
    // bucket that holds strictly more records than the row knows about.
    const live = s.usageHistoryBySession[sessionId];
    if (live && live.length > (history?.length ?? 0)) return {};
    const next = { ...s.usageHistoryBySession };
    if (history && Array.isArray(history) && history.length > 0) {
      next[sessionId] = history;
    } else {
      delete next[sessionId];
    }
    return { usageHistoryBySession: next };
  });
}

/* ──────────────── Plan block helpers (inline plan in the message stream) ────────────────
 *
 * The plan is rendered as a `kind: "plan"` block attached to the CURRENT
 * turn's trailing assistant message, rather than a session-global footer card.
 * This keeps each turn's plan frozen in its place in history — different turns
 * produce different plans, none overwriting another.
 *
 * All four plan-aware code paths (plan.update, plan.approval_request,
 * turn.done, submitPlanApproval) funnel through `upsertLivePlanBlock` /
 * `freezeOrPrunePlanBlocks` so the message-array surgery stays in one place.
 */

/** Find the index of the trailing assistant message of the currently-open
 *  turn (the LAST assistant message whose turnMeta has no endedAt), or -1 if
 *  no open-turn assistant message exists. Used to locate where the live plan
 *  block should be attached / removed.
 *
 *  NOTE: only a turn's OPENER carries turnMeta, so this actually resolves to
 *  the opener — the right anchor for plan/turn-files cards (the render layer
 *  re-pins those footers to the turn's end regardless of host message). For
 *  append-order-sensitive content (tool_use fallback) use
 *  {@link findOpenTurnLastAssistant} instead, which returns the turn's
 *  chronologically-LAST assistant message. */
function findOpenTurnTrailingAssistant(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined) {
      return i;
    }
  }
  return -1;
}

/** Find the chronologically-LAST assistant message of the currently-open
 *  turn, or -1 if the turn has no assistant messages yet. Only the opener
 *  carries turnMeta (later messages of the same turn don't), so this walks
 *  forward from the opener to the end of the list — appending here keeps the
 *  flattened message timeline in ARRIVAL order. The tool.use fallback MUST
 *  use this, not the opener: appending a tool to the opener while later
 *  narration messages exist places the tool BEFORE text that had already
 *  streamed, and the renderer's completed-turn split ("everything up to the
 *  last tool call is process") then misclassifies that narration as the
 *  final reply — the "process data leaks below the panel" bug. */
function findOpenTurnLastAssistant(messages: ChatMessage[]): number {
  const openerIdx = findOpenTurnTrailingAssistant(messages);
  if (openerIdx === -1) return -1;
  for (let i = messages.length - 1; i > openerIdx; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") return i;
  }
  return openerIdx;
}

/** The planId used for the single "live" plan block within the current turn.
 *  There is at most one live plan per turn at a time (the model calls
 *  EnterPlanMode once, drafts, then ExitPlanMode). Frozen historical blocks
 *  retain this same id — it only needs to be unique within a message, and a
 *  frozen turn's trailing assistant message carries at most one plan block. */
const LIVE_PLAN_ID = "current";

/** Upsert (or remove) the live plan block on the current turn's trailing
 *  assistant message. Used while the turn is streaming:
 *  - phase "cleared" → remove any live plan block (plan mode exited / denied).
 *  - empty plan text → same as cleared: the EnterPlanMode placeholder has no
 *    content yet, and a blank plan card is noise — only once real plan text
 *    exists does the card appear (see the guard below).
 *  - otherwise → insert-or-replace the live plan block with the given text /
 *    phase / hasApproval.
 *
 *  If the current turn has no assistant message yet (plan.update often
 *  arrives before any text/tool block), a new trailing assistant message is
 *  created and stamped with the current turn's `turnMeta` — mirroring the
 *  tool.use branch's "new turn" detection so we don't double-open a turn.
 *
 *  Returns the new messages array; pure (no store mutation). */
function upsertLivePlanBlock(
  messages: ChatMessage[],
  plan: string,
  phase: PlanUpdateEvent["phase"],
  hasApproval: boolean,
  /** Send-time anchor (runningTurnStartedAt) to stamp on a newly-opened
   *  turn's turnMeta, so the real row continues the synthesized pendingTurn
   *  row's timing seamlessly. Omitted on the cleared-phase path. */
  startedAtAnchor?: number,
): ChatMessage[] {
  if (phase === "cleared") {
    // Remove any live plan block from the current turn's trailing assistant
    // message. Frozen blocks (on closed turns) are untouched.
    return removeLivePlanBlock(messages);
  }
  // No real plan content yet — EnterPlanMode emits a placeholder `plan: ""`
  // in phase "drafting", and an empty plan card (0 字 / "计划为空") is noise.
  // The plan panel only appears once the model has actually produced plan
  // text: the final payload arrives on ExitPlanMode ("ready") and the
  // approval_request re-syncs it. So treat an empty draft like "cleared":
  // drop any live block instead of rendering a blank card.
  if (plan.trim().length === 0) {
    return removeLivePlanBlock(messages);
  }
  const block: Block = {
    kind: "plan",
    planId: LIVE_PLAN_ID,
    plan,
    phase,
    hasApproval,
  };
  let next = messages;
  const targetIndex = findOpenTurnTrailingAssistant(next);
  if (targetIndex === -1) {
    // No open-turn assistant message exists yet. Plan events commonly arrive
    // before any text/tool block, so we open the turn here - same heuristic
    // as the tool.use branch: a turn is "open" while any assistant message
    // has turnMeta.endedAt === undefined; if none, this starts a new turn.
    const isNewTurn = !next.some(
      (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
    );
    const msg: ChatMessage = {
      id: `plan_${Date.now()}`,
      sessionId: "",
      role: "assistant",
      blocks: [block],
      createdAt: Date.now(),
      // Prefer the send-time anchor so timing is continuous with the
      // synthesized pendingTurn row; fall back to now if none was passed.
      ...(isNewTurn ? { turnMeta: { startedAt: startedAtAnchor ?? Date.now() } } : {}),
    };
    next = [...next, msg];
    // A new plan-mode turn is opening → demote any prior latest turn-files
    // card to read-only (mirrors upsertLiveTurnFilesBlock's new-turn branch).
    if (isNewTurn) next = demotePreviousLatestTurnFiles(next);
    return next;
  }
  const target = next[targetIndex];
  const existingIdx = target.blocks.findIndex(
    (b) => b.kind === "plan" && b.planId === LIVE_PLAN_ID,
  );
  let blocks: Block[];
  if (existingIdx >= 0) {
    blocks = target.blocks.map((b, i) => (i === existingIdx ? block : b));
  } else {
    // Insert the plan block BEFORE any existing turn-files block so the plan
    // card always renders above the "本轮修改文件" card in the stream,
    // regardless of event arrival order (turn.files can land first when a
    // plan.update arrives after turn.done in edge cases).
    const turnFilesIdx = target.blocks.findIndex((b) => b.kind === "turn-files");
    if (turnFilesIdx >= 0) {
      blocks = [
        ...target.blocks.slice(0, turnFilesIdx),
        block,
        ...target.blocks.slice(turnFilesIdx),
      ];
    } else {
      blocks = [...target.blocks, block];
    }
  }
  next = next.map((m, i) => (i === targetIndex ? { ...m, blocks } : m));
  return next;
}

/** Remove the live plan block from the current turn's trailing assistant
 *  message. Drops the assistant message too if it would end up empty (no
 *  other blocks), so a plan-only message doesn't linger as a blank row. */
function removeLivePlanBlock(messages: ChatMessage[]): ChatMessage[] {
  let next = messages;
  const targetIndex = findOpenTurnTrailingAssistant(next);
  if (targetIndex === -1) return next;
  const target = next[targetIndex];
  const filtered = target.blocks.filter(
    (b) => !(b.kind === "plan" && b.planId === LIVE_PLAN_ID),
  );
  if (filtered.length === target.blocks.length) return next; // nothing to remove
  if (filtered.length === 0) {
    // Drop the now-empty assistant message entirely.
    next = next.filter((_, i) => i !== targetIndex);
  } else {
    next = next.map((m, i) => (i === targetIndex ? { ...m, blocks: filtered } : m));
  }
  return next;
}

/** Called from turn.done: freeze or prune plan blocks on the JUST-cLOSED turn.
 *  The closing turn's assistant messages were just stamped with endedAt, so we
 *  can't use the "open turn" heuristic — we key off messages whose turnMeta
 *  endedAt matches `endedAt`.
 *
 *  - A plan block with phase "ready" and non-empty text is KEPT (frozen as a
 *    historical card) — the user approved this plan; it stays in the stream.
 *  - Any other plan block (drafting / cleared / empty) is REMOVED — these are
 *    in-progress or rejected drafts that shouldn't leave a trace.
 *  - An assistant message left with zero blocks after pruning is dropped. */
function freezeOrPrunePlanBlocks(messages: ChatMessage[], endedAt: number): ChatMessage[] {
  let next = messages.map((m) => {
    if (!m.turnMeta || m.turnMeta.endedAt !== endedAt) return m;
    if (!m.blocks.some((b) => b.kind === "plan")) return m;
    const kept = m.blocks.filter((b) => {
      if (b.kind !== "plan") return true;
      return b.phase === "ready" && b.plan.trim().length > 0;
    });
    return { ...m, blocks: kept };
  });
  // Drop any assistant messages that became empty (a plan-only message whose
  // plan was pruned). Keep user / non-empty messages untouched.
  next = next.filter(
    (m) => m.role !== "assistant" || m.blocks.length > 0,
  );
  return next;
}

/* ──────────────── Turn-files block helpers (inline "本轮修改" card) ────────────────
 *
 * Mirrors the plan-block pattern: the per-turn modified-files card renders as
 * a `kind: "turn-files"` block attached to its turn's trailing assistant
 * message, frozen in place when the turn ends. Each turn that touched files
 * keeps its own card in history — new turns add new cards, old cards are
 * never deleted (only demoted to read-only once a newer turn supersedes them
 * as "the latest rewindable turn").
 *
 * Only the LATEST turn's card is rewindable (`isLatestTurn === true`); the
 * rewind itself still goes through the in-memory FileSnapshot (cleared per
 * turn), so older turns are display-only snapshots. Historical cards persist
 * to the messages table via the normal blocks round-trip (toRecords /
 * fromRecords) — no DB schema change.
 */

/** The filesId used for the single "live" turn-files block within the current
 *  turn. Same rationale as LIVE_PLAN_ID: at most one live block per turn. */
const LIVE_FILES_ID = "current";

/** Upsert the live turn-files block on the current turn's trailing assistant
 *  message. Called from the turn.files handler.
 *
 *  Attach target resolution (in priority order):
 *  1. The trailing assistant message of the currently-OPEN turn (turnMeta with
 *     no endedAt) - the normal mid-stream case.
 *  2. The most recent assistant message - the realistic late-arrival case.
 *     turn.files is emitted from flushFinal (after an async freeze()), which
 *     runs AFTER the `result` message already emitted turn.done. So by the
 *     time turn.files reaches the renderer the turn is closed and (1) finds
 *     nothing; the file list still belongs to this just-closed turn, so we
 *     attach it to the turn's (now-ended) trailing assistant message WITHOUT
 *     opening a new turn. Opening a new turn here would spawn a phantom
 *     "开始 · 用时 <1s" stat row that never finalizes.
 *  3. A brand-new assistant message (no turnMeta) - defensive fallback when no
 *     assistant message exists at all.
 *
 *  In every case the block becomes the latest rewindable card
 *  (isLatestTurn=true) and every other turn's card is demoted to read-only.
 *
 *  Returns the new messages array; pure (no store mutation). */
function upsertLiveTurnFilesBlock(messages: ChatMessage[], files: TurnFileEntry[]): ChatMessage[] {
  // Defensive mirror of FileSnapshot.freeze's net-zero filter: entries with
  // no actual change are pure noise on the card, and filtering them at RENDER
  // time instead would break the path-set equality the `turn.rewound` matcher
  // relies on (card files vs echoed targetFiles). No-op for events emitted by
  // the fixed freeze(); keeps the card honest for any other source.
  const visible = files.filter((f) => f.adds > 0 || f.dels > 0);
  if (visible.length === 0) return messages;
  const block: Block = {
    kind: "turn-files",
    filesId: LIVE_FILES_ID,
    files: visible,
    isLatestTurn: true,
  };
  let next = messages;
  let targetIndex = findOpenTurnTrailingAssistant(next);
  if (targetIndex === -1) {
    // turn.files normally arrives at the very end of the stream (flushFinal),
    // but the SDK emits turn.done from the `result` message BEFORE flushFinal
    // runs its async freeze() + emit. So by the time turn.files reaches the
    // renderer, turn.done has ALREADY been processed: every assistant message
    // of this turn carries a turnMeta.endedAt, and findOpenTurnTrailingAssistant
    // returns -1. The file list still belongs to THIS just-closed turn, so
    // fall back to the most recent assistant message (the turn's trailing
    // one, now ended) and attach the block there - WITHOUT opening a new turn.
    for (let i = next.length - 1; i >= 0; i--) {
      const m = next[i];
      if (m && m.role === "assistant") {
        targetIndex = i;
        break;
      }
    }
  }
  if (targetIndex === -1) {
    // Truly no assistant message at all (shouldn't happen for a turn that
    // touched files, but stay defensive): create one WITHOUT a turnMeta so we
    // don't spawn a phantom "开始 · 用时" stat row for an already-ended turn.
    const msg: ChatMessage = {
      id: `files_${Date.now()}`,
      sessionId: "",
      role: "assistant",
      blocks: [block],
      createdAt: Date.now(),
    };
    next = [...next, msg];
    next = demotePreviousLatestTurnFiles(next);
    return next;
  }
  const target = next[targetIndex];
  const existingIdx = target.blocks.findIndex(
    (b) => b.kind === "turn-files" && b.filesId === LIVE_FILES_ID,
  );
  let blocks: Block[];
  if (existingIdx >= 0) {
    blocks = target.blocks.map((b, i) => (i === existingIdx ? block : b));
  } else {
    // Always insert the turn-files block at the VERY END of the blocks array
    // so the "本轮修改了 N 个文件" card renders below all text/plan content.
    blocks = [...target.blocks, block];
  }
  next = next.map((m, i) => (i === targetIndex ? { ...m, blocks } : m));
  // This turn's card is now the latest → demote every OTHER turn's card to
  // read-only. (Without this, a brief window between turn.files and turn.done
  // would show two cards with the rewind button: the previous turn's frozen
  // card and this turn's new one.) The current turn's block stays true because
  // demotePreviousLatestTurnFiles runs BEFORE we re-stamped it above — but to
  // be safe we re-stamp the target's own block as true after demoting.
  next = demotePreviousLatestTurnFiles(next);
  next = next.map((m, i) => {
    if (i !== targetIndex) return m;
    if (!m.blocks.some((b) => b.kind === "turn-files")) return m;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.kind === "turn-files" ? { ...b, isLatestTurn: true } : b,
      ),
    };
  });
  return next;
}

/** Append a `compact-summary` block to the current turn's trailing assistant
 *  message. If no open-turn assistant message exists yet (compact_boundary
 *  arrives before any model text), create one WITH a turnMeta so it opens a
 *  proper turn in the stream - mirroring how tool.use creates a turn opener.
 *  Without the turnMeta the card would either attach to the PREVIOUS turn's
 *  message (wrong position) or float as an orphan (no stat row). */
function appendCompactSummaryBlock(
  messages: ChatMessage[],
  block: Block,
  startedAt: number,
): ChatMessage[] {
  // Look for an OPEN turn's trailing assistant message (turnMeta present,
  // endedAt undefined = turn.done hasn't landed). This is the correct target
  // - the compact belongs to the CURRENT turn, not a previous one.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined) {
      const next = messages.slice();
      next[i] = { ...m, blocks: [...m.blocks, block] };
      return next;
    }
  }
  // No open-turn assistant message yet - the compact_boundary arrived before
  // any model text. Create a turn-opener assistant message carrying the
  // compact-summary block, stamped with turnMeta so it renders as the start
  // of the current turn (with its own stat row, correct grouping, etc.).
  const opener: ChatMessage = {
    id: `compact_${Date.now()}`,
    sessionId: "",
    role: "assistant",
    blocks: [block],
    createdAt: Date.now(),
    turnMeta: { startedAt },
  };
  return [...messages, opener];
}

/** Demote EVERY turn-files block's `isLatestTurn` to false. Called when a new
 *  turn opens (the previous "latest" card is no longer the latest — only the
 *  most recent completed turn is rewindable). The new turn's own card, once it
 *  arrives via turn.files, sets isLatestTurn=true on insert. */
function demotePreviousLatestTurnFiles(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (!m.blocks.some((b) => b.kind === "turn-files" && b.isLatestTurn)) return m;
    changed = true;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.kind === "turn-files" && b.isLatestTurn ? { ...b, isLatestTurn: false } : b,
      ),
    };
  });
  return changed ? next : messages;
}

/** Called from turn.done: finalize the just-closed turn's turn-files block.
 *  The block is already attached (turn.files arrived just before turn.done);
 *  here we only need to ensure it's marked isLatestTurn=true (it IS the latest
 *  completed turn now) and demote all earlier turns' cards to read-only.
 *
 *  Unlike plan blocks, turn-files blocks are NEVER pruned — every turn that
 *  touched files keeps its card in history. (Empty turns never produced a
 *  block in the first place, so there's nothing to clean up.) Keyed off
 *  endedAt so we only touch THIS turn's messages. */
function freezeLatestTurnFilesBlock(messages: ChatMessage[], endedAt: number): ChatMessage[] {
  // First demote all older turn-files cards to read-only.
  let next = demotePreviousLatestTurnFiles(messages);
  // Then mark this turn's turn-files block(s) as the latest (rewindable).
  // There is at most one live block per turn; a turn's assistant messages all
  // share the same endedAt stamp, so keying off endedAt catches them all.
  next = next.map((m) => {
    if (!m.turnMeta || m.turnMeta.endedAt !== endedAt) return m;
    if (!m.blocks.some((b) => b.kind === "turn-files")) return m;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.kind === "turn-files" ? { ...b, isLatestTurn: true } : b,
      ),
    };
  });
  return next;
}

/* ──────────────── Delta buffer (performance: batch text.delta per rAF) ────────────────
 *
 * Each `text.delta` / `thinking` event from the stream triggers a full `setState`
 * that rebuilds the messages array. During a long output this can happen thousands
 * of times per second. The buffer accumulates raw deltas and flushes them on a
 * `requestAnimationFrame` boundary (~60 Hz), collapsing many single-character
 * deltas into one `setState` per frame.
 *
 * Terminal events (turn.done, error) force an immediate flush so no content is
 * lost before the turn closes. The buffer is module-scoped, *not* inside the
 * Zustand store, so it doesn't trigger React re-renders on accumulation.
 */

type DeltaEntry = {
  sessionId: string;
  messageId: string;
  /** Accumulated text (via text.delta) */
  text: string;
  /** Accumulated thinking (via thinking delta) — only one of text/thinking is
   *  populated per call, but we carry both to consolidate into one flush. */
  thinking: string;
};

const deltaBuf = new Map<string, DeltaEntry>();

let flushScheduled = false;

/* ─── Adaptive throttling ───
 *
 * Instead of a fixed rAF cadence, we track the inter-arrival time of deltas
 * via a sliding window and pick a flush strategy that balances throughput
 * (batched during bursts) vs. responsiveness (near-immediate when sparse).
 *
 * Strategy matrix:
 *   avg interval    method         delay
 *   < 16ms          rAF            ~16ms (60 Hz batch)
 *   16-100ms        timer + rAF    ~50ms (moderate batch)
 *   > 100ms         microtask      0ms (flush on next tick)
 *
 * The sliding window keeps the last 5 deltas (by wall-clock ms). The window is
 * module-scoped and never triggers React renders, exactly like deltaBuf itself.
 */
const deltaArrivals: number[] = [];
const MAX_WINDOW = 5;

function avgIntervalMs(): number {
  if (deltaArrivals.length < 2) return 0;
  const min = deltaArrivals[0];
  const max = deltaArrivals[deltaArrivals.length - 1];
  return (max - min) / (deltaArrivals.length - 1);
}

function recordDeltaArrival(): void {
  const now = performance.now();
  deltaArrivals.push(now);
  if (deltaArrivals.length > MAX_WINDOW) deltaArrivals.shift();
}

function scheduleDeltaFlush(): void {
  recordDeltaArrival();
  if (flushScheduled) return;
  flushScheduled = true;

  const avg = avgIntervalMs();
  if (avg > 100 && deltaArrivals.length >= 2) {
    // Sparse deltas: flush on next microtask (near-immediate).
    queueMicrotask(flushDeltas);
  } else if (avg > 16) {
    // Moderate pace: 50 ms timer for a modest batch window.
    setTimeout(flushDeltas, 50);
  } else {
    // Dense burst: rAF (natural 60 Hz batch).
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(flushDeltas);
    } else {
      setTimeout(flushDeltas, 16);
    }
  }
}

function flushDeltas(): void {
  flushScheduled = false;
  if (deltaBuf.size === 0) return;

  // Snapshot the buffer and clear it atomically so new deltas that arrive
  // during this flush start a fresh accumulation rather than being lost.
  const entries = Array.from(deltaBuf.values());
  deltaBuf.clear();

  useSessionStore.setState((s) => {
    // Group entries by sessionId so we only iterate each session's messages
    // once per flush cycle.
    const bySession = new Map<string, DeltaEntry[]>();
    for (const e of entries) {
      const arr = bySession.get(e.sessionId);
      if (arr) arr.push(e);
      else bySession.set(e.sessionId, [e]);
    }

    for (const [sid, sessionEntries] of bySession) {
      const list = s.messagesBySession[sid] ?? [];
      let next: typeof list = list;

      for (const e of sessionEntries) {
        let msg = findMsg(next, e.messageId);
        // Never append streamed content onto a message whose turn already
        // ended — happens only with straggler deltas from an aborted turn
        // (e.g. a stop→resend race where the sentinel got cleared). The
        // transcript must freeze where the user stopped it.
        if (msg && msg.turnMeta && msg.turnMeta.endedAt !== undefined) {
          continue;
        }
        if (!msg) {
          // First delta for this message — create a new assistant message.
          // Check if a turn is already open (assistant message without endedAt).
          const isNewTurn = !next.some(
            (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
          );
          // Prefer the send-time anchor (stamped in sendPrompt) so the real
          // turnMeta continues the synthesized pendingTurn row's timing
          // seamlessly - otherwise the duration would jump (the anchor is
          // earlier than this first-delta arrival). Falls back to now if the
          // anchor is missing (e.g. a resumed/legacy turn with no anchor).
          const startedAt =
            (isNewTurn && useSessionStore.getState().runningTurnStartedAt[sid]) || Date.now();
          msg = {
            id: e.messageId,
            sessionId: sid,
            role: "assistant",
            blocks: [],
            createdAt: Date.now(),
            ...(isNewTurn ? { turnMeta: { startedAt } } : {}),
          };
          next = [...next, msg];
          // A new turn is opening → demote the previous "latest" turn-files
          // card to read-only (it's no longer the latest rewindable turn).
          // The new turn's own card, if any, sets isLatestTurn=true on insert
          // and gets re-promoted at turn.done via freezeLatestTurnFilesBlock.
          if (isNewTurn) next = demotePreviousLatestTurnFiles(next);
        } else {
          // Message already exists — we'll replace it below.
        }

        // Apply accumulated text
        if (e.text) {
          const blocks = msg.blocks;
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock && lastBlock.kind === "text") {
            const updatedMsg = {
              ...msg,
              blocks: [...blocks.slice(0, -1), { ...lastBlock, text: lastBlock.text + e.text }],
            };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          } else {
            const updatedMsg = {
              ...msg,
              blocks: [...blocks, { kind: "text", text: e.text } as Block],
            };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          }
          msg = findMsg(next, e.messageId)!;
        }

        // Apply accumulated thinking
        if (e.thinking) {
          const blocks = msg!.blocks;
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock && lastBlock.kind === "thinking") {
            const updatedMsg = {
              ...msg,
              blocks: [...blocks.slice(0, -1), { ...lastBlock, text: lastBlock.text + e.thinking }],
            };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          } else {
            const updatedMsg = {
              ...msg,
              blocks: [...blocks, { kind: "thinking", text: e.thinking } as Block],
            };
            next = next.map((m) => (m.id === msg!.id ? updatedMsg : m));
          }
        }
      }

      // Write back only if the session changed — avoid touching unrelated sessions.
      if (next !== list) {
        s.messagesBySession[sid] = next;
      }
    }

    // Return a minimal diff — we mutated messagesBySession directly inside the
    // setState callback (Zustand accepts this pattern because setState runs
    // synchronously and can detect the mutation via its proxy).
    return { messagesBySession: { ...s.messagesBySession } };
  });
}

/** Flush any buffered deltas immediately (called before terminal events). */
function forceDeltaFlush(): void {
  if (deltaBuf.size === 0) return;
  flushScheduled = false;
  deltaArrivals.length = 0; // Reset the adaptive window.
  flushDeltas();
}

/** Drop all buffered deltas for a session. Called on interrupt so the aborted
 *  turn's straggler deltas (flushFinal emits them while the SDK generator
 *  unwinds) never reach the transcript — the user asked to STOP, so content
 *  freezes exactly where it was. */
function clearSessionDeltas(sessionId: string): void {
  if (deltaBuf.size === 0) return;
  for (const [key, entry] of deltaBuf) {
    if (entry.sessionId === sessionId) deltaBuf.delete(key);
  }
}

/** Event types that append visible content to the transcript. While a session
 *  is interrupted these are ignored so the aborted turn's late events can't
 *  keep rendering text / tools / images after the Stop click. Status events
 *  (turn.done / error / subagent.update / turn.files ...) are NOT in this set
 *  — they still flow so state cleanup proceeds normally. */
const CONTENT_FROZEN_EVENTS = new Set<RuntimeEvent["type"]>([
  "text.delta",
  "thinking",
  "tool.use",
  "tool.result",
  "browser.image",
]);

/* ─── Pane-width persistence (debounced) ───
 * A drag fires many mousemove events; each calls an adjust* action that
 * updates the store synchronously (instant UI). The DB write is debounced so
 * the settings table only gets hit once, ~400ms after the last move. The
 * timer is module-scoped so successive adjust calls reset the same timer. */
let paneWidthPersistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePaneWidthPersist(get: () => SessionState): void {
  if (paneWidthPersistTimer) clearTimeout(paneWidthPersistTimer);
  paneWidthPersistTimer = setTimeout(async () => {
    paneWidthPersistTimer = null;
    const s = get();
    try {
      await api.setting.set({
        key: UI_PANE_WIDTHS_SETTING_KEY,
        value: JSON.stringify({
          leftPct: s.leftWidthPct,
          right: s.rightWidth,
          bottomTerminal: s.bottomTerminalHeight,
          editor: s.editorWidthPct,
        }),
      });
    } catch (err) {
      console.error("setting.set(paneWidths) failed:", err);
    }
  }, 400);
}

/** The effective working-environment root of the ACTIVE session: the thread's
 *  materialized worktree when it runs isolated, the project root otherwise.
 *  Drives the IDE surfaces (file tree / git panel / terminal / LSP
 *  workspace) so they follow the session's environment instead of always
 *  showing the project checkout. Returns a stable string|null. */
export function selectActiveEnvPath(s: {
  activeProjectId: string | null;
  activeSessionId: string | null;
  sessions: Session[];
  pinnedSessions: Session[];
  sessionsByProject: Record<string, Session[]>;
  projects: { id: string; path: string }[];
}): string | null {
  const pid = s.activeProjectId;
  if (!pid) return null;
  const sid = s.activeSessionId;
  if (sid) {
    let sess = s.sessions.find((x) => x.id === sid);
    if (!sess) sess = s.pinnedSessions.find((x) => x.id === sid);
    if (!sess) {
      for (const list of Object.values(s.sessionsByProject)) {
        const hit = list?.find((x) => x.id === sid);
        if (hit) { sess = hit; break; }
      }
    }
    if (sess?.worktreePath) return sess.worktreePath;
  }
  return s.projects.find((p) => p.id === pid)?.path ?? null;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  sessionsByProject: {},
  sessionsHasMoreByProject: {},
  sessionsTotalByProject: {},
  archivedSessionsByProject: {},
  pinnedSessions: [],
  gitChangeVersionByRepo: {},
  sessions: [],
  activeSessionId: null,
  expandedProjects: {},
  worktreeViewByProject: {},
  expandedWorktrees: {},
  worktreeNames: {},
  archivedViewOpen: false,
  // openTabs is filled by `init` (lands on the first non-archived session,
  // if any) and by `startSession`. Defaulting to [] here means there's no
  // phantom active tab before hydration completes.
  openTabs: [],
  // Persisted in `settings` table; init() overwrites from the DB. Default is
  // `tabs` (unified tab bar) — new users land on the tabbed center pane;
  // anyone who explicitly picked a mode keeps their stored choice.
  displayMode: "tabs",
  // Center focus for the unified tab bar (`tabs` displayMode). UI-only.
  centerTabFocus: "chat",
  // UI language. Persisted in `settings` table; init() overwrites from the
  // DB. "zh" is the default (and the pre-i18n behavior) so existing users see
  // no change until they opt into English.
  locale: "zh",
  // Session auto-archive rules. Persisted as JSON in `settings`; initDeferred
  // hydrates. Disabled by default so existing users opt in.
  autoArchiveConfig: { ...DEFAULT_AUTO_ARCHIVE_CONFIG, overrides: {} },
  // Persisted in `settings` table; init() overwrites from the DB. Default
  // "comfortable" so existing users see no change until they opt in.
  chatDensity: "comfortable",
  // Persisted in `settings` table; init() overwrites from the DB. Default
  // "flat" so existing users see no change until they opt into grouping.
  projectView: "flat",
  // Per-group metadata (color + order). Empty until init() hydrates from the
  // `ui.projectGroups` JSON blob; groups not present here fall back to default
  // color and first-appearance order.
  groupMeta: {},
  // Persisted in `settings` table; init() overwrites from the DB. Defaults
  // mirror the CSS var defaults in styles.css (14px = text-sm).
  chatFontSize: 14,
  // Persisted in `settings` table; init() overwrites from the DB. Default
  // 14px mirrors the --right-panel-font-size CSS var in styles.css.
  rightPanelFontSize: 14,
  // Persisted in `settings` table; init() overwrites from the DB. Default
  // 200 mirrors the previous hardcoded TAG_THRESHOLD_CHARS in contentTag.ts.
  pasteTagThresholdChars: 200,
  // Default voice input: continuous dictation, Chinese, streaming zipformer.
  voiceInputMode: "continuous" as const,
  voiceLang: "zh-CN",
  voiceEngine: "zipformer" as const,
  voiceMicPermission: "",
  voiceModelDir: "",
  userMessageColor: null,
  accentColor: null,
  editorTheme: DEFAULT_EDITOR_THEME_CHOICE,
  shortcutOverrides: {},
  shortcutRecording: false,
    messagesBySession: {},
    hasMoreMessagesBySession: {},
    loadingMessagesBySession: {},
    loadingOlderBySession: {},
    historyLoadedBySession: {},
  runningBySession: {},
  runningTurnStartedAt: {},
  interruptedBySession: {},
  turnIncompleteBySession: {},
  upstreamIssueBySession: {},
  unreadBySession: {},
  isWindowFocused: true,
  claudeInstalled: null,
  settingsOpen: false,
  settingsSection: null,
  modelConfigPromptOpen: false,
  commandPaletteOpen: false,
  // File search dialog (opened from the Files panel search button / Cmd+Shift+F
  // / command palette). Pure in-memory, mirrors commandPaletteOpen.
  searchDialogOpen: false,
  // Layout panel visibility — lifted from App.tsx useState. Right panel
  // starts hidden by default (the titlebar toggle / command palette reopens
  // it). NOT persisted.
  leftOpen: true,
  rightOpen: false,
  bottomTerminalOpen: false,
  // Browser panel overlay - closed by default. NOT persisted.
  browserPanelOpen: false,
  // Wide-panel (3:7) mode - off by default; transient like browserPanelOpen.
  widePanelOpen: false,
  widePanelPct: WIDE_PANEL_PCT_DEFAULT,
  widePanelSnapshot: null,
  // Mobile-shell fullscreen viewer (file/diff/plan) - closed by default.
  mobileViewer: null,
  browserTabCount: 0,
  browserDeviceToolbarOpen: false,
  browserTabs: [],
  browserActiveTabId: null,
  pendingBrowserUrl: null,
  browserViewSuppressed: 0,
  // Draggable pane sizes. Persisted as one JSON blob (UI_PANE_WIDTHS_SETTING_KEY);
  // init() hydrates + clamps. These defaults match the original hardcoded
  // widths so the first-run layout is unchanged.
  leftWidthPct: LEFT_WIDTH_PCT_DEFAULT,
  rightWidth: 360,
  bottomTerminalHeight: 280,
  editorWidthPct: 50,
  permissionMode: "default",
    envChoice: "local",
  providerId: DEFAULT_PROVIDER_ID,
  model: "default",
  customModelId: null,
  lastModelByProvider: EMPTY_LAST_MODEL_BY_PROVIDER,
  customModels: EMPTY_CUSTOM_MODELS,
  providers: EMPTY_PROVIDERS,
  piAvailableModels: EMPTY_PI_MODELS,
  skills: EMPTY_SKILLS,
  effort: "high",
  todosBySession: {},
  planBySession: {},
  planDrawerPlanBySession: {},
  planTabActiveBySession: {},
  planApprovalDraftBySession: {},
  subagentsBySession: {},
  subagentTranscriptsBySession: {},
  contextSnapshotBySession: {},
  usageHistoryBySession: {},
  pendingQuestionBySession: {},
  pendingApprovals: [],
  pendingPlanApprovalBySession: {},
  turnFilesBySession: {},
  bookmarksBySession: {},
  chatFileQueueBySession: {},
  chatElementQueueBySession: {},
  promptQueueBySession: {},
  composerDraftBySession: {},
  // Side chat (right-panel ask tab). Lists hydrate on demand per parent.
  sideChatsByParent: {},
  activeSideChatId: null,
  sideChatSeedBySession: {},
  pendingSubagentView: null,
  pendingBookmarkJump: null,
  // IDE right-panel. Editor state is per-project (keyed by projectId);
  // init() hydrates from the settings table. rightPanelTab / ideEditorMode
  // are global user prefs.
  rightPanelTab: "files",
  customCommandsByProject: {},
  ideOpenFilesByProject: {},
  ideActiveFileByProject: {},
  ideFileViewModeByProject: {},
  ideEditorMode: "tabs",
  gitDiffOpenMode: "center",
  gitDiffDialogTabs: [],
  gitDiffDialogActiveId: null,
  gitDiffDialogOpen: false,
  gitDiffDialogViewMode: "single",
  ideExpandedDirsByProject: {},
  gitDiffByProject: {},
  ideDiffBeforeByProject: {},
  commitGenModel: null,
  commitGenPrompt: "",
  conflictResolveModel: null,
  titleGenEnabled: false,
  titleGenModel: null,
  outputStyle: null,
  collapsedGitRepos: {} as Record<string, boolean>,
  ideFocusNonce: 0,
  ideTreeReveal: null,
  idePendingReveal: null,
  ideRevealNonce: 0,
  navBackByProject: {},
  navForwardByProject: {},
  lspLanguages: [] as LspLanguageState[],
  lspPhasesByWorkspace: {} as Record<string, { phase: "starting" | "running" | "stopped" | "importing"; error?: string; detail?: string }>,

  /** True once `init()` has started, to guard against React StrictMode's
   *  double-effect in dev (which would otherwise fire init twice). */
  _initStarted: false,

  init: async () => {
    // StrictMode guard: dev runs effects twice. The second call would re-fetch
    // everything and (worse) race with the first. Bail out silently.
    if (get()._initStarted) return;
    set({ _initStarted: true });

    // IDE hydration staging: parsed from deferred settings, applied after the
    // project list loads so we can drop paths that belong to no project.
    let ideHydrationPending: {
      open: Record<string, string[]>;
      active: Record<string, string | null>;
      dirs: Record<string, string[]>;
    } | null = null;

    // ── First-paint essentials ──
    // Only what the user sees on the very first frame: the center-pane layout
    // mode, the chat font size (avoids a font flash), and the project + session
    // list. Everything else (health check, appearance extras, IDE/git prefs) is
    // deferred to `initDeferred()` after this resolves.

    // First-paint settings: one bulk read instead of N serial round-trips.
    // Each value is applied in its own try/catch so a malformed blob for one
    // key can't poison the rest (same isolation as the old per-key reads).
    const fp = await api.setting
      .getMany({
        keys: [
          DISPLAY_MODE_SETTING_KEY,
          UI_LOCALE_SETTING_KEY,
          UI_CHAT_DENSITY_SETTING_KEY,
          UI_PROJECT_VIEW_SETTING_KEY,
          UI_PROJECT_GROUPS_SETTING_KEY,
          UI_LAST_PROJECT_SETTING_KEY,
          UI_LAST_SESSION_SETTING_KEY,
          UI_COMPOSER_MODEL_SETTING_KEY,
          SESSION_WORKTREE_DEFAULT_SETTING_KEY,
          WORKTREE_NAMES_SETTING_KEY,
        ],
      })
      .catch((err) => {
        console.error("setting.getMany(first-paint) failed:", err);
        return {} as Record<string, string | null>;
      });

    // Composer's default working environment for new sessions. Folded into
    // the first-paint batch so the chip renders correctly on frame one.
    // Values are the EnvChoice strings; the pre-forms boolean era persisted
    // "true"/"false" — "true" hydrates as the detached worktree default.
    try {
      const value = fp[SESSION_WORKTREE_DEFAULT_SETTING_KEY];
      if (value === "local" || value === "wt-detached" || value === "wt-branch") {
        set({ envChoice: value });
      } else if (value === "true") {
        set({ envChoice: "wt-detached" });
      }
    } catch (err) {
      console.error("apply(envChoice) failed:", err);
    }

    // Left-bar display names for worktree directories. Cosmetic — a failed
    // parse just falls back to directory basenames for every group.
    try {
      const value = fp[WORKTREE_NAMES_SETTING_KEY];
      if (value) set({ worktreeNames: JSON.parse(value) as Record<string, string> });
    } catch (err) {
      console.error("apply(worktreeNames) failed:", err);
    }

    // displayMode determines single vs tabs layout - needed before first render
    // of the center pane so the right structure mounts.
    try {
      const value = fp[DISPLAY_MODE_SETTING_KEY];
      if (value === "single" || value === "tabs") set({ displayMode: value });
    } catch (err) {
      console.error("apply(displayMode) failed:", err);
    }

    // locale drives every translated string — must land before first paint so
    // the UI never flashes the wrong language. Also mirror onto <html lang>.
    try {
      const value = fp[UI_LOCALE_SETTING_KEY];
      if (value === "zh" || value === "en") {
        set({ locale: value });
        document.documentElement.lang = value === "en" ? "en" : "zh-CN";
      }
    } catch (err) {
      console.error("apply(locale) failed:", err);
    }

    // chatDensity controls message-stream vertical rhythm (row + block gaps).
    // Applied to <html> as CSS vars by useChatAppearance; read here so the
    // first paint already reflects the saved preference.
    try {
      const value = fp[UI_CHAT_DENSITY_SETTING_KEY];
      if (value === "compact" || value === "comfortable" || value === "cozy") {
        set({ chatDensity: value });
      }
    } catch (err) {
      console.error("apply(chatDensity) failed:", err);
    }

    // projectView determines whether the left bar renders projects as a flat
    // list or clustered under group headers. Needed before first paint so the
    // tree mounts in the right shape.
    try {
      const value = fp[UI_PROJECT_VIEW_SETTING_KEY];
      if (value === "flat" || value === "grouped") set({ projectView: value });
    } catch (err) {
      console.error("apply(projectView) failed:", err);
    }

    // groupMeta (per-group color + order) — parsed from the ui.projectGroups
    // JSON blob. Defensive parse: a malformed blob leaves the default {}.
    try {
      const value = fp[UI_PROJECT_GROUPS_SETTING_KEY];
      if (value) {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          set({ groupMeta: parsed as ProjectGroupsMeta });
        }
      }
    } catch (err) {
      console.error("apply(projectGroups) failed:", err);
    }

    // Composer's persisted provider/model choice — the "next session" defaults
    // written by setProvider / setModel / setCustomModel. Restored so the last
    // SDK + model pick is pre-selected at boot. Validity against the CURRENT
    // model lists is checked once reloadProviders / reloadCustomModels /
    // reloadPiAvailableModels resolve (a deleted model falls back to auto via
    // validateComposerSelection).
    try {
      const value = fp[UI_COMPOSER_MODEL_SETTING_KEY];
      if (value) {
        const parsed = JSON.parse(value) as {
          providerId?: unknown;
          model?: unknown;
          customModelId?: unknown;
          lastModelByProvider?: unknown;
        };
        if (parsed && typeof parsed === "object" && typeof parsed.providerId === "string") {
          // Per-provider remembered models (newer format). Guarded shape check;
          // malformed entries are simply ignored.
          let lastMap: Record<string, { model: string; customModelId: string | null }> = {};
          if (parsed.lastModelByProvider && typeof parsed.lastModelByProvider === "object") {
            for (const [k, v] of Object.entries(
              parsed.lastModelByProvider as Record<string, unknown>,
            )) {
              if (
                v &&
                typeof v === "object" &&
                typeof (v as { model?: unknown }).model === "string"
              ) {
                const cid = (v as { customModelId?: unknown }).customModelId;
                lastMap[k] = {
                  model: (v as { model: string }).model,
                  customModelId: typeof cid === "string" ? cid : null,
                };
              }
            }
          }
          // Top-level model/customModelId come from the legacy (pre-map) format;
          // a remembered entry for the restored provider takes precedence.
          const remembered = lastMap[parsed.providerId];
          set({
            providerId: parsed.providerId,
            model:
              remembered?.model ??
              (typeof parsed.model === "string" ? parsed.model : "default"),
            customModelId: remembered
              ? remembered.customModelId
              : typeof parsed.customModelId === "string"
                ? parsed.customModelId
                : null,
            lastModelByProvider: lastMap,
          });
        }
      }
    } catch (err) {
      console.error("apply(composerModel) failed:", err);
    }

    // Fetch the project list, chat font size, and the global pinned bucket in
    // parallel - all three are needed for the first frame (session tree + chat
    // text size + pinned section above the tree).
    const [projectListRes, fontRes, pinnedRes] = await Promise.allSettled([
      api.project.list(),
      api.setting.get({ key: UI_CHAT_FONT_SIZE_SETTING_KEY }),
      api.session.listPinned(),
    ]);

    // Apply chat font size (best-effort - missing/invalid leaves the default).
    if (fontRes.status === "fulfilled" && fontRes.value.value != null) {
      const px = Number(fontRes.value.value);
      if (Number.isFinite(px)) set({ chatFontSize: clampFontSize(px) });
    }

    if (projectListRes.status !== "fulfilled") {
      // project.list failed - can't proceed with session loading. Show empty
      // state rather than crashing into a blank screen.
      console.error("project.list failed:", projectListRes.reason);
      // Kick off deferred work even on failure (health check etc. still useful).
      queueMicrotask(() => void get().initDeferred());
      return;
    }
    const { projects } = projectListRes.value;
    set({ projects });

    if (projects.length === 0) {
      queueMicrotask(() => void get().initDeferred());
      return;
    }

    // Eagerly load the FIRST page of active sessions for every project so
    // the tree renders without a round-trip per expand. The archived bin is
    // also pre-fetched (grouped by project) so the bottom section is ready.
    const byProject: Record<string, Session[]> = {};
    const hasMoreByProject: Record<string, boolean> = {};
    const totalByProject: Record<string, number> = {};
    const archivedByProject: Record<string, Session[]> = {};
    try {
      await Promise.all(
        projects.map(async (p) => {
          const active = await api.project.sessions({
            projectId: p.id,
            limit: SESSION_PAGE_SIZE,
            offset: 0,
            archived: false,
          });
          byProject[p.id] = active.sessions;
          hasMoreByProject[p.id] = active.hasMore;
          totalByProject[p.id] = active.total;
          const archived = await api.project.sessions({
            projectId: p.id,
            archived: true,
          });
          if (archived.sessions.length > 0) {
            archivedByProject[p.id] = archived.sessions;
          }
        }),
      );
    } catch (err) {
      console.error("project.sessions failed:", err);
    }

    // Pick the first non-archived project (fall back to the first project) and
    // its latest non-archived session as the landing target.
    const firstActive =
      projects.find((p) => !p.archived) ?? projects[0];
    const firstSessions = byProject[firstActive.id] ?? [];
    const firstSession = firstSessions.find((s) => !s.archived);

    // Restore the last-opened project/session (persisted on every session
    // activation) instead of always landing on the first project — so a restart
    // puts the user back where they left off. Validated against the CURRENT
    // project/session lists: a saved id that was deleted or archived since is
    // silently dropped and we fall back to the default first-project target.
    let landingProject = firstActive;
    let landingSession = firstSession;
    const lastProjectId =
      typeof fp[UI_LAST_PROJECT_SETTING_KEY] === "string" ? fp[UI_LAST_PROJECT_SETTING_KEY] : null;
    const lastSessionId =
      typeof fp[UI_LAST_SESSION_SETTING_KEY] === "string" ? fp[UI_LAST_SESSION_SETTING_KEY] : null;
    if (lastProjectId) {
      const savedProject = projects.find((p) => p.id === lastProjectId);
      if (savedProject) {
        landingProject = savedProject;
        const savedSessions = byProject[savedProject.id] ?? [];
        landingSession =
          savedSessions.find((s) => s.id === lastSessionId) ??
          savedSessions.find((s) => !s.archived);
      }
    }

    set({
      sessionsByProject: byProject,
      sessionsHasMoreByProject: hasMoreByProject,
      sessionsTotalByProject: totalByProject,
      archivedSessionsByProject: archivedByProject,
      pinnedSessions: pinnedRes.status === "fulfilled" ? pinnedRes.value.sessions : [],
      sessions: byProject[landingProject.id] ?? [],
      activeProjectId: landingProject.id,
      // Auto-expand the active project so its threads are visible on load.
      expandedProjects: { [landingProject.id]: true },
      // Seed the tab list with the landing session (if any). In `single`
      // mode this is informational; in `tabs` mode it shows the initial
      // open tab. Either way the user starts with a coherent state.
      openTabs: landingSession ? [landingSession.id] : [],
    });
    if (landingSession) {
      try {
        await get().selectSession(landingSession.id);
      } catch (err) {
        console.error("selectSession failed:", err);
      }
    }

    // Kick off deferred (non-critical) hydration after first paint.
    queueMicrotask(() => void get().initDeferred());
  },

  initDeferred: async () => {
    // Health check: spawn the claude binary to verify it works. This is the
    // single slowest IPC in init (~seconds), so it's fully fire-and-forget -
    // claudeInstalled stays null (UI shows a loading state) until it resolves.
    void api.claudeHealthCheck().then(
      (health) => set({ claudeInstalled: health.installed }),
      (err) => {
        console.error("healthCheck failed:", err);
        set({ claudeInstalled: false });
      },
    );

    // Custom-model configs for the model dropdown.
    void get().reloadCustomModels();

    // Registered AI backends for the provider picker.
    void get().reloadProviders();

    // Pi SDK models the user can pick from in the model dropdown. Lazy/async
    // — may take a moment on first run while the SDK loads; the dropdown
    // shows an empty state until it resolves.
    void get().reloadPiAvailableModels();

    // Skill list for the composer `/` menu (scans ~/.claude/skills + the
    // active project's .claude/skills).
    void get().reloadSkills();

    // Language server states (install/running) for the settings panel + Monaco.
    // Desktop-only: the web shim exposes no `api.lsp` surface (no editor /
    // settings panel on mobile), so skip it to avoid a spurious load error.
    if (isElectron) {
      void get().reloadLspLanguages();
      // Track the language-server lifecycle per (workspace, language) so the
      // editor toolbar can show a loading indicator while a server starts
      // (Java's jdtls can take minutes to import a project) and a failure
      // notice when it can't start. App-lifetime subscription — no teardown.
      api.on.lspEvent((msg) => {
        if (msg.type !== "stateChanged") return;
        const p = msg.payload as LspStateChangedPayload;
        if (
          !p ||
          (p.phase !== "starting" &&
            p.phase !== "running" &&
            p.phase !== "stopped" &&
            p.phase !== "importing")
        )
          return;
        set((s) => ({
          lspPhasesByWorkspace: {
            ...s.lspPhasesByWorkspace,
            [`${msg.workspacePath}::${msg.language}`]: { phase: p.phase, error: p.error, detail: p.detail },
          },
        }));
      });
    }

    // Deferred settings: one bulk read for everything non-critical-paint
    // (appearance, pane widths, IDE/git prefs). One IPC instead of four
    // sequential awaits that each did their own Promise.all internally.
    const ds = await api.setting
      .getMany({
        keys: [
          UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY,
          UI_USER_MSG_COLOR_SETTING_KEY,
          UI_ACCENT_COLOR_SETTING_KEY,
          UI_EDITOR_THEME_SETTING_KEY,
          UI_SHORTCUTS_SETTING_KEY,
          UI_PANE_WIDTHS_SETTING_KEY,
          UI_RIGHT_PANEL_TAB_SETTING_KEY,
          UI_IDE_OPEN_FILES_SETTING_KEY,
          UI_IDE_ACTIVE_FILE_SETTING_KEY,
          UI_IDE_EXPANDED_DIRS_SETTING_KEY,
          UI_IDE_EDITOR_MODE_SETTING_KEY,
          UI_GIT_DIFF_OPEN_MODE_SETTING_KEY,
          UI_COMMIT_GEN_MODEL_SETTING_KEY,
          UI_COMMIT_GEN_PROMPT_SETTING_KEY,
          UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY,
          UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY,
          UI_TITLE_GEN_ENABLED_SETTING_KEY,
          UI_TITLE_GEN_MODEL_SETTING_KEY,
          AGENT_OUTPUT_STYLE_SETTING_KEY,
          UI_GIT_COLLAPSED_REPOS_SETTING_KEY,
          UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY,
          UI_VOICE_INPUT_MODE_SETTING_KEY,
          UI_VOICE_LANG_SETTING_KEY,
          UI_VOICE_ENGINE_SETTING_KEY,
          UI_VOICE_MIC_PERMISSION_SETTING_KEY,
          UI_VOICE_MODEL_DIR_SETTING_KEY,
          AUTO_ARCHIVE_SETTING_KEY,
        ],
      })
      .catch((err) => {
        console.error("setting.getMany(deferred) failed:", err);
        return {} as Record<string, string | null>;
      });

    // Appearance extras (right-panel font size, user-message bg, accent color).
    // chatFontSize was already loaded in init() - only the rest here.
    try {
      const rpFontRaw = ds[UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY];
      if (rpFontRaw != null) {
        const px = Number(rpFontRaw);
        if (Number.isFinite(px)) set({ rightPanelFontSize: clampRightPanelFontSize(px) });
      }
      const pasteThresholdRaw = ds[UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY];
      if (pasteThresholdRaw != null) {
        const n = Number(pasteThresholdRaw);
        if (Number.isFinite(n)) set({ pasteTagThresholdChars: clampPasteTagThresholdChars(n) });
      }
      const colorRaw = ds[UI_USER_MSG_COLOR_SETTING_KEY];
      if (colorRaw && RGB_TRIPLET_RE.test(colorRaw)) set({ userMessageColor: colorRaw });
      const accentRaw = ds[UI_ACCENT_COLOR_SETTING_KEY];
      if (accentRaw && RGB_TRIPLET_RE.test(accentRaw)) set({ accentColor: accentRaw });
      // Editor color scheme (per-mode Monaco theme ids; unknown ids inside a
      // corrupt row fall back to the defaults field-by-field).
      if (ds[UI_EDITOR_THEME_SETTING_KEY] != null) {
        set({ editorTheme: parseEditorThemeChoice(ds[UI_EDITOR_THEME_SETTING_KEY]) });
      }
      // Voice-input prefs. Validate against the schemas so a corrupt row can't
      // crash the store; keep defaults otherwise.
      const voiceModeRaw = ds[UI_VOICE_INPUT_MODE_SETTING_KEY];
      if (voiceModeRaw === "continuous" || voiceModeRaw === "pushToTalk") {
        set({ voiceInputMode: voiceModeRaw });
      }
      const voiceLangRaw = ds[UI_VOICE_LANG_SETTING_KEY];
      if (voiceLangRaw && voiceLangRaw.length <= 20) set({ voiceLang: voiceLangRaw });
      const voiceEngineRaw = ds[UI_VOICE_ENGINE_SETTING_KEY];
      if (voiceEngineRaw === "zipformer" || voiceEngineRaw === "parakeet") {
        set({ voiceEngine: voiceEngineRaw });
      }
      const voiceMicRaw = ds[UI_VOICE_MIC_PERMISSION_SETTING_KEY];
      if (voiceMicRaw === "granted" || voiceMicRaw === "denied") set({ voiceMicPermission: voiceMicRaw });
      const voiceModelDirRaw = ds[UI_VOICE_MODEL_DIR_SETTING_KEY];
      if (voiceModelDirRaw) set({ voiceModelDir: voiceModelDirRaw });
      // Shortcut overrides — parsed from the ui.shortcuts JSON blob.
      // safeParse rejects malformed blobs so a corrupt row can't crash the
      // store; on failure we keep the empty default (all defaults apply).
      const shortcutsRaw = ds[UI_SHORTCUTS_SETTING_KEY];
      if (shortcutsRaw) {
        const parsed = ShortcutBindingsSchema.safeParse(JSON.parse(shortcutsRaw));
        if (parsed.success) set({ shortcutOverrides: parsed.data });
      }
    } catch (err) {
      console.error("apply(appearance deferred) failed:", err);
    }

    // Session auto-archive rules (JSON blob). parseAutoArchiveConfig never
    // throws — malformed rows fall back to the disabled default.
    const autoArchiveRaw = ds[AUTO_ARCHIVE_SETTING_KEY];
    if (autoArchiveRaw) set({ autoArchiveConfig: parseAutoArchiveConfig(autoArchiveRaw) });

    // Draggable pane widths (one JSON blob).
    try {
      const paneRaw = ds[UI_PANE_WIDTHS_SETTING_KEY];
      if (paneRaw) {
        const parsed = JSON.parse(paneRaw) as Partial<{
          leftPct: number; right: number; bottomTerminal: number; editor: number;
        }>;
        const patch: Partial<SessionState> = {};
        if (parsed && typeof parsed === "object") {
          // Only `leftPct` is read — the legacy `left` (px) field from the old
          // fixed-width layout is deliberately dropped; the redesigned 3:7
          // layout starts everyone at the percentage default.
          if (Number.isFinite(parsed.leftPct)) patch.leftWidthPct = clampLeftWidthPct(parsed.leftPct!);
          if (Number.isFinite(parsed.right)) patch.rightWidth = clampRightWidth(parsed.right!);
          if (Number.isFinite(parsed.bottomTerminal)) {
            patch.bottomTerminalHeight = clampBottomTerminalHeight(parsed.bottomTerminal!);
          }
          if (Number.isFinite(parsed.editor)) patch.editorWidthPct = clampEditorWidthPct(parsed.editor!);
          if (Object.keys(patch).length > 0) set(patch);
        }
      }
    } catch (err) {
      console.error("apply(paneWidths) failed:", err);
    }

    // IDE right-panel prefs (active tab, open files, active file, expanded tree
    // dirs, editor mode, diff mode, commit-gen model/prompt, custom commands,
    // conflict-resolve model). All optional JSON-in-settings.
    try {
      const tabRaw = ds[UI_RIGHT_PANEL_TAB_SETTING_KEY];
      const openRaw = ds[UI_IDE_OPEN_FILES_SETTING_KEY];
      const activeRaw = ds[UI_IDE_ACTIVE_FILE_SETTING_KEY];
      const dirsRaw = ds[UI_IDE_EXPANDED_DIRS_SETTING_KEY];
      const modeRaw = ds[UI_IDE_EDITOR_MODE_SETTING_KEY];
      const diffModeRaw = ds[UI_GIT_DIFF_OPEN_MODE_SETTING_KEY];
      const commitModelRaw = ds[UI_COMMIT_GEN_MODEL_SETTING_KEY];
      const commitPromptRaw = ds[UI_COMMIT_GEN_PROMPT_SETTING_KEY];
      const commandsByProjectRaw = ds[UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY];
      const conflictModelRaw = ds[UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY];
      const titleGenEnabledRaw = ds[UI_TITLE_GEN_ENABLED_SETTING_KEY];
      const titleGenModelRaw = ds[UI_TITLE_GEN_MODEL_SETTING_KEY];

      if (tabRaw === "files" || tabRaw === "git" || tabRaw === "turns")
        set({ rightPanelTab: tabRaw });
      if (modeRaw === "tabs" || modeRaw === "replace") set({ ideEditorMode: modeRaw });
      if (diffModeRaw === "center" || diffModeRaw === "dialog") set({ gitDiffOpenMode: diffModeRaw });
      set({ commitGenModel: commitModelRaw || null });
      if (commitPromptRaw) set({ commitGenPrompt: commitPromptRaw });
      set({ conflictResolveModel: conflictModelRaw || null });
      set({ titleGenEnabled: titleGenEnabledRaw === "on" });
      set({ titleGenModel: titleGenModelRaw || null });
      const outputStyleRaw = ds[AGENT_OUTPUT_STYLE_SETTING_KEY];
      set({ outputStyle: outputStyleRaw || null });
      const parseBucket = <T>(raw: string | null): Record<string, T> => {
        if (!raw) return {};
        try {
          const obj = JSON.parse(raw);
          if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, T>;
        } catch {
          /* malformed JSON - leave empty */
        }
        return {};
      };
      const parsedOpen = parseBucket<string[]>(openRaw);
      const parsedActive = parseBucket<string | null>(activeRaw);
      const parsedDirs = parseBucket<string[]>(dirsRaw);
      // Apply IDE file/dir state, dropping paths that belong to no project.
      const projects = get().projects;
      const projectById = new Map(projects.map((p) => [p.id, p]));
      const filterProjectPaths = (pid: string, paths: string[]) => {
        const proj = projectById.get(pid);
        if (!proj) return [];
        return paths.filter((p) => isPathWithinRoot(proj.path, p));
      };
      const openByProject: Record<string, string[]> = {};
      const activeByProject: Record<string, string | null> = {};
      const dirsByProject: Record<string, string[]> = {};
      for (const pid of Object.keys(parsedOpen)) {
        const filtered = filterProjectPaths(pid, parsedOpen[pid] ?? []);
        if (filtered.length > 0) openByProject[pid] = filtered;
      }
      for (const pid of Object.keys(parsedActive)) {
        const proj = projectById.get(pid);
        const active = parsedActive[pid];
        if (proj && active && isPathWithinRoot(proj.path, active)) {
          const open = openByProject[pid] ?? [];
          activeByProject[pid] = open.includes(active) ? active : (open[0] ?? null);
        }
      }
      for (const pid of Object.keys(parsedDirs)) {
        const filtered = filterProjectPaths(pid, parsedDirs[pid] ?? []);
        if (filtered.length > 0) dirsByProject[pid] = filtered;
      }
      set({
        ideOpenFilesByProject: openByProject,
        ideActiveFileByProject: activeByProject,
        ideExpandedDirsByProject: dirsByProject,
      });
      // Per-project terminal quick-commands.
      {
        const rawMap = parseBucket<unknown>(commandsByProjectRaw);
        const validated: Record<string, CustomCommand[]> = {};
        for (const [pid, rawList] of Object.entries(rawMap)) {
          if (!Array.isArray(rawList)) continue;
          const valid = rawList.filter(
            (c): c is CustomCommand =>
              !!c &&
              typeof c === "object" &&
              typeof c.id === "string" &&
              typeof c.name === "string" &&
              typeof c.command === "string",
          );
          validated[pid] = valid;
        }
        set({ customCommandsByProject: validated });
      }
    } catch (err) {
      console.error("apply(ide deferred) failed:", err);
    }

    // Collapsed git repo card states.
    try {
      const raw = ds[UI_GIT_COLLAPSED_REPOS_SETTING_KEY];
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          set({ collapsedGitRepos: parsed as Record<string, boolean> });
        }
      }
    } catch (err) {
      console.error("apply(gitCollapsedRepos) failed:", err);
    }
  },

  addProjectFromFolder: async () => {
    const { path } = await api.pickFolder();
    if (!path) return null;

    // Normalize the chosen path so the same folder isn't imported twice under
    // different surface forms (drive-letter case, forward vs. back slashes,
    // trailing separator). Comparison is case-insensitive on Windows/macOS
    // where the filesystem is case-insensitive; on Linux paths stay as-is
    // (toLowerCase on a Linux path would wrongly merge distinct folders, but
    // it's harmless there because the only difference is the slashes).
    const normalize = (p: string) =>
      p
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase();
    const normalized = normalize(path);

    // An existing project already points at this folder. Don't create a
    // duplicate - just activate it (restoring if it was archived) so the user
    // lands on the folder they picked without a second entry.
    const existing = get().projects.find((p) => normalize(p.path) === normalized);
    if (existing) {
      if (existing.archived) {
        await get().archiveProject(existing.id, false);
      }
      await get().selectProject(existing.id);
      return existing.id;
    }

    const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
    const { project } = await api.project.create({ name, path });
    set((s) => ({
      projects: [...s.projects, project],
      sessionsByProject: { ...s.sessionsByProject, [project.id]: [] },
      sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [project.id]: false },
      sessionsTotalByProject: { ...s.sessionsTotalByProject, [project.id]: 0 },
      activeProjectId: project.id,
      sessions: [],
      activeSessionId: null,
      // Expand the newly added project.
      expandedProjects: { ...s.expandedProjects, [project.id]: true },
    }));
    // Load skills for the freshly activated project's `/` menu.
    void get().reloadSkills();
    // Fresh Java workspace → start its import immediately in the background.
    get().prewarmJavaLspForActiveProject();
    return project.id;
  },

  /** Switch the active project and (re)load its session list from cache. */
  selectProject: async (projectId) => {
    const sessions = get().sessionsByProject[projectId] ?? [];
    // Pick the latest non-archived session of this project to land on.
    // Pinned rows aren't in the project's list (they render in the global
    // pinned section) — fall back to the project's most recent pinned row
    // so a project whose threads are ALL pinned still lands on one instead
    // of the empty state.
    const next =
      sessions.find((s) => !s.archived) ??
      get().pinnedSessions.find((s) => s.projectId === projectId && !s.archived);
    set((s) => ({
      activeProjectId: projectId,
      sessions,
      activeSessionId: next?.id ?? null,
      expandedProjects: { ...s.expandedProjects, [projectId]: true },
      // Switching projects is a hard reset of the tab strip — tabs belong to
      // a project, so we don't carry them across. The new project lands on
      // its own first session.
      openTabs: next ? [next.id] : [],
    }));
    if (next) {
      await get().selectSession(next.id);
    }
    // Skills are project-scoped (project's .claude/skills overlays the global
    // dir), so refresh the composer `/` menu for the newly active project.
    void get().reloadSkills();
    // Start the Java import for the newly active project in the background
    // so opening a Java file later doesn't wait behind it.
    get().prewarmJavaLspForActiveProject();
  },

  toggleProjectExpanded: (projectId) =>
    set((s) => {
      const wasExpanded = !!s.expandedProjects[projectId];
      // Collapsing resets the per-project pagination cache back to the first
      // page so the next expand shows the initial slice again (instead of the
      // full list accumulated by "加载更多"). The server-side total is
      // unchanged, so `hasMore` is recomputed from it; the list is trimmed in
      // place — no IPC, no flicker.
      if (!wasExpanded) {
        return {
          expandedProjects: { ...s.expandedProjects, [projectId]: true },
        };
      }
      const prevList = s.sessionsByProject[projectId] ?? EMPTY_SESSIONS;
      const total = s.sessionsTotalByProject[projectId] ?? prevList.length;
      const trimmed = prevList.slice(0, SESSION_PAGE_SIZE);
      const isActive = projectId === s.activeProjectId;
      return {
        expandedProjects: { ...s.expandedProjects, [projectId]: false },
        sessionsByProject: { ...s.sessionsByProject, [projectId]: trimmed },
        sessionsHasMoreByProject: {
          ...s.sessionsHasMoreByProject,
          [projectId]: total > SESSION_PAGE_SIZE,
        },
        sessions: isActive ? trimmed : s.sessions,
      };
    }),

  // Worktree group nodes hold few sessions (one directory, few threads), so
  // unlike toggleProjectExpanded there is no pagination cache to reset — a
  // pure expand-state flip.
  toggleWorktreeExpanded: (worktreePath) =>
    set((s) => {
      const key = normWorktreeKey(worktreePath);
      return {
        expandedWorktrees: { ...s.expandedWorktrees, [key]: !s.expandedWorktrees[key] },
      };
    }),

  setProjectWorktreeView: (projectId, on) =>
    set((s) => {
      if (!!s.worktreeViewByProject[projectId] === on) return s;
      return { worktreeViewByProject: { ...s.worktreeViewByProject, [projectId]: on } };
    }),

  renameWorktree: async (worktreePath, name) => {
    const key = normWorktreeKey(worktreePath);
    const trimmed = name.trim();
    const next = { ...get().worktreeNames };
    if (trimmed) next[key] = trimmed;
    else delete next[key];
    // Optimistic local patch — the group header renames immediately; the
    // settings write is fire-and-forget (a failed write costs the name on
    // next boot, same trade-off as the other cosmetic settings).
    set({ worktreeNames: next });
    try {
      await api.setting.set({ key: WORKTREE_NAMES_SETTING_KEY, value: JSON.stringify(next) });
    } catch (err) {
      console.error("setting.set(worktreeNames) failed:", err);
    }
  },

  setArchivedViewOpen: (open) => set({ archivedViewOpen: open }),

  /** Fetch the next page of active sessions for a project and append to the
   *  cached list. Updates `hasMore` / `total` from the server response so the
   *  "加载更多" affordance reflects the truth. No-op when nothing more to load. */
  loadMoreSessions: async (projectId) => {
    if (!get().sessionsHasMoreByProject[projectId]) return;
    const offset = (get().sessionsByProject[projectId] ?? []).length;
    const page = await api.project.sessions({
      projectId,
      limit: SESSION_PAGE_SIZE,
      offset,
      archived: false,
    });
    set((s) => {
      const prev = s.sessionsByProject[projectId] ?? [];
      // De-dup in case a session was created mid-fetch (newest-first means
      // newly-created rows would slide in ahead of the next page; we drop
      // any overlap by id rather than risk showing a row twice).
      const seen = new Set(prev.map((x) => x.id));
      const merged = [...prev, ...page.sessions.filter((x) => !seen.has(x.id))];
      const isActive = projectId === s.activeProjectId;
      return {
        sessionsByProject: { ...s.sessionsByProject, [projectId]: merged },
        sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: page.hasMore },
        sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: page.total },
        sessions: isActive ? merged : s.sessions,
      };
    });
  },

  startSession: async (projectIdArg, overrides) => {
    const projectId = projectIdArg ?? get().activeProjectId;
    if (!projectId) return;
    // `overrides` (plan handoff) replaces the composer-slot defaults for this
    // creation only — the slots themselves are re-synced from the new session
    // row below, so the foreground chips match the thread the user lands on.
    const model = overrides?.model ?? get().model;
    const { session } = await api.claude.startSession({
      projectId,
      kind: "chat",
      providerId: overrides?.providerId ?? get().providerId,
      model: model !== "default" ? model : undefined,
      effort: get().effort,
      permissionMode: get().permissionMode,
      // Working-environment intent from the composer chip — materialized on
      // the first turn (see sendTurn's resolveSessionCwd), never here. An
      // explicit worktreePath (LeftBar "在此工作树中新建会话") BINDS the new
      // session to an existing managed checkout instead of creating one (the
      // checkout's own form applies; wtStyle is moot for binds).
      envMode:
        overrides?.worktreePath || get().envChoice !== "local" ? "worktree" : "local",
      wtStyle:
        !overrides?.worktreePath && get().envChoice !== "local"
          ? get().envChoice === "wt-branch" ? "branch" : "detached"
          : undefined,
      worktreePath: overrides?.worktreePath,
      customModelId:
        overrides?.customModelId !== undefined ? overrides.customModelId : get().customModelId,
    });
    set((s) => {
      const prevList = s.sessionsByProject[projectId] ?? [];
      // The IPC handler broadcasts a `session.changed` event for cross-client
      // list sync BEFORE returning the invoke response, and Electron delivers
      // that event ahead of the invoke resolution — so by the time we reach
      // here the session may ALREADY be in the cache (inserted by the
      // `session.changed` reducer below). A blind prepend would then yield two
      // list entries with the same id — a duplicate-keyed phantom row React
      // renders but can't cleanly target for delete ("新建会话 生成了两个、删不掉一个").
      // Upsert instead: merge over an existing row, else prepend; and only bump
      // the total when the row is genuinely new (the event reducer already
      // counted it in that case). The merge HOISTS the row to the head: a
      // brand-new row has the newest `updated_at`, and a REUSED fresh row
      // (createOrReuseSession bumps an existing "New session" row instead of
      // creating another) may sit mid-list — leaving it there would contradict
      // the updated_at-desc order a fresh fetch would show.
      const exists = prevList.some((x) => x.id === session.id);
      const upserted = exists
        ? [
            // Merge over the cached row so heavy fields the slim `session`
            // payload lacks (contextSnapshot / turnFiles / …) survive.
            { ...(prevList.find((x) => x.id === session.id) as Session), ...session },
            ...prevList.filter((x) => x.id !== session.id),
          ]
        : [session, ...prevList];
      // New sessions are never pinned — the active list holds unpinned rows
      // only (pinned ones live in the global pinned bucket), and a new
      // session is the newest row so it lands at the head.
      const nextByProject = {
        ...s.sessionsByProject,
        [projectId]: upserted,
      };
      const isactive = projectId === s.activeProjectId;
      const prevTotal = s.sessionsTotalByProject[projectId] ?? 0;
      const nextTotal = exists ? prevTotal : prevTotal + 1;
      return {
        sessionsByProject: nextByProject,
        // A brand-new session sits at the head (newest created_at) and bumps
        // the active-thread total by one. `hasMore` flips on if the page now
        // exceeds SESSION_PAGE_SIZE — the load-more button reveals to fetch
        // the next page rather than growing the cache unbounded. Both are
        // no-ops when the row was already inserted by the ahead-of-response
        // `session.changed` event (so the count isn't double-bumped).
        sessionsTotalByProject: {
          ...s.sessionsTotalByProject,
          [projectId]: nextTotal,
        },
        sessionsHasMoreByProject: {
          ...s.sessionsHasMoreByProject,
          [projectId]: nextTotal > SESSION_PAGE_SIZE,
        },
        sessions: isactive ? nextByProject[projectId] : s.sessions,
        activeProjectId: projectId,
        activeSessionId: session.id,
        expandedProjects: { ...s.expandedProjects, [projectId]: true },
        // The new thread's side of the project view must be the visible one:
        // a worktree-bound session needs the fork view, a local one the
        // default list — otherwise the freshly activated row is invisible.
        worktreeViewByProject: {
          ...s.worktreeViewByProject,
          [projectId]: !!session.worktreePath,
        },
        // A worktree-bound new session must land inside a VISIBLE group node.
        expandedWorktrees: session.worktreePath
          ? { ...s.expandedWorktrees, [normWorktreeKey(session.worktreePath)]: true }
          : s.expandedWorktrees,
        messagesBySession: { ...s.messagesBySession, [session.id]: [] },
        hasMoreMessagesBySession: { ...s.hasMoreMessagesBySession, [session.id]: false },
        // Locally-created session: the empty bucket IS the full history — mark
        // it hydrated so selectSession/openTab never re-fetch for it.
        historyLoadedBySession: { ...s.historyLoadedBySession, [session.id]: true },
        // New session lands as a fresh tab. If it was somehow already open
        // (e.g. a duplicate id — shouldn't happen) we don't double-add.
        openTabs: s.openTabs.includes(session.id) ? s.openTabs : [...s.openTabs, session.id],
        // A brand-new session is a chat view by definition.
        centerTabFocus: "chat" as const,
      };
    });
    // With explicit overrides the new row's config differs from the composer
    // slots — re-sync so the chips reflect the session the user just landed
    // on. Skipped in the normal path (slots were the row's source anyway) to
    // keep that behavior untouched.
    if (overrides) syncConfigFromSession(set, get, session.id);
  },

  /** Activate an existing session and load its persisted history.
   *  Per-thread config (model / effort / permissionMode / customModelId) is
   *  hydrated from the session row via `syncConfigFromSession` BEFORE the
   *  activeSessionId flip — that way the chip components see the right
   *  values on their next render and never show the previous thread's
   *  config as a flash while messages are still loading.
   *
   *  Pure focus switch: doesn't touch the tab strip or any per-session
   *  data buckets. The user can flip between already-open tabs (in
   *  `tabs` mode) or between arbitrary sessions (in `single` mode) with
   *  the same code path. */
  selectSession: async (sessionId) => {
    syncConfigFromSession(set, get, sessionId);
    hydrateContextSnapshot(set, get, sessionId);
    hydrateCapsule(set, get, sessionId);
    hydrateTurnFiles(set, get, sessionId);
    hydrateUsageHistory(set, get, sessionId);
    hydrateBookmarks(set, get, sessionId);
    hydrateSubagentTranscripts(set, get, sessionId);
    set((s) => {
      // Clear the unread badge - the user is now looking at this session.
      // Activating a session also pulls the unified center bar back to the
      // chat view (tabs displayMode).
      if (!s.unreadBySession[sessionId])
        return { activeSessionId: sessionId, centerTabFocus: "chat" as const };
      const unreadBySession = { ...s.unreadBySession };
      delete unreadBySession[sessionId];
      return { activeSessionId: sessionId, unreadBySession, centerTabFocus: "chat" as const };
    });
    // Gate on the hydration flag, NOT bucket existence: a bucket may already
    // exist having been created by ingestEvent from another client's turn
    // (mobile companion) — it holds only the live event window and must not
    // suppress loading the full persisted history. See prefetchSessionMessages.
    if (get().historyLoadedBySession[sessionId]) return;
    void get().prefetchSessionMessages(sessionId);
  },

  /** Open a session as a tab. Already-open tabs simply become active; new
   *  ones get appended. Both display modes call this; the difference is
   *  purely cosmetic (the tab strip only renders in `tabs` mode).
   *
   *  The full logic chain matches `selectSession` (sync config + load
   *  history) so the first time a tab opens, its messages show up. */
  openTab: async (sessionId) => {
    syncConfigFromSession(set, get, sessionId);
    hydrateContextSnapshot(set, get, sessionId);
    hydrateCapsule(set, get, sessionId);
    hydrateTurnFiles(set, get, sessionId);
    hydrateUsageHistory(set, get, sessionId);
    hydrateBookmarks(set, get, sessionId);
    hydrateSubagentTranscripts(set, get, sessionId);
    set((s) => {
      // Clear the unread badge - the user is now looking at this session.
      const unreadBySession = { ...s.unreadBySession };
      delete unreadBySession[sessionId];
      return {
        activeSessionId: sessionId,
        // Append only if not already present; preserves the order in which
        // tabs were opened (newer tabs on the right).
        openTabs: s.openTabs.includes(sessionId) ? s.openTabs : [...s.openTabs, sessionId],
        unreadBySession,
        // Opening/activating a session tab shows its chat in the center.
        centerTabFocus: "chat" as const,
      };
    });
    // Same hydration-flag gate as selectSession — an event-created partial
    // bucket (another client's turn) must not suppress the history fetch.
    if (!get().historyLoadedBySession[sessionId]) {
      void get().prefetchSessionMessages(sessionId);
    }
  },

  /** Shared first-page history fetch behind selectSession / openTab / hover
   *  prefetch. Tracks in-flight state in `loadingMessagesBySession` so the
   *  ChatPane can distinguish "history loading" (skeleton) from "thread
   *  genuinely empty" (welcome screen), and dedupes concurrent callers.
   *
   *  When a live bucket already exists (created by ingestEvent from a turn
   *  driven by ANOTHER client — e.g. the mobile companion — before this
   *  client ever opened the thread), the fetched page is MERGED with it
   *  instead of replacing it: shared ids keep the live copy (fresher stream
   *  state than the persisted row mid-turn), live-only messages append, and
   *  the union is re-sorted by the same (createdAt, id) key the DB pages by.
   *  This is what makes "chat on the phone → come back to the PC" show the
   *  full thread instead of just the phone-driven tail. */
  prefetchSessionMessages: async (sessionId) => {
    if (get().historyLoadedBySession[sessionId]) return;
    if (get().loadingMessagesBySession[sessionId]) return;
    set((s) => ({
      loadingMessagesBySession: { ...s.loadingMessagesBySession, [sessionId]: true },
    }));
    try {
      const { messages, hasMore } = await api.session.messages({
        sessionId,
        limit: MESSAGE_PAGE_SIZE,
      });
      const fetched = fromRecords(messages);
      const live = get().messagesBySession[sessionId];
      let merged: ChatMessage[];
      if (live && live.length > 0) {
        const byId = new Map(fetched.map((m) => [m.id, m]));
        const extras: ChatMessage[] = [];
        for (const m of live) {
          if (byId.has(m.id)) byId.set(m.id, m);
          else extras.push(m);
        }
        merged = [...byId.values(), ...extras].sort(
          (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      } else {
        merged = fetched;
      }
      set((s) => ({
        messagesBySession: { ...s.messagesBySession, [sessionId]: merged },
        hasMoreMessagesBySession: { ...s.hasMoreMessagesBySession, [sessionId]: hasMore },
        historyLoadedBySession: { ...s.historyLoadedBySession, [sessionId]: true },
        loadingMessagesBySession: { ...s.loadingMessagesBySession, [sessionId]: false },
      }));
    } catch {
      // Never leave the skeleton stuck up on a failed fetch — fall back to
      // the regular (empty) view so the composer stays usable. The hydration
      // flag stays unset so a later open retries the fetch.
      set((s) => ({
        loadingMessagesBySession: { ...s.loadingMessagesBySession, [sessionId]: false },
      }));
    }
  },

  /** Fetch the next page of older messages and prepend them to the session's
   *  message list. Used by the "pull to load history" hook at the top of the
   *  chat list. Safe to call repeatedly — concurrent calls are deduped via
   *  `loadingOlderBySession`, and a `false` hasMore short-circuits future ones. */
  loadOlderMessages: async (sessionId) => {
    // Bail when there's nothing more to load or a fetch is already in flight.
    if (!get().hasMoreMessagesBySession[sessionId]) return;
    if (get().loadingOlderBySession[sessionId]) return;
    const list = get().messagesBySession[sessionId];
    if (!list || list.length === 0) return;
    const head = list[0];
    set((s) => ({
      loadingOlderBySession: { ...s.loadingOlderBySession, [sessionId]: true },
    }));
    try {
      const { messages, hasMore } = await api.session.messages({
        sessionId,
        limit: MESSAGE_PAGE_SIZE,
        beforeCreatedAt: head.createdAt,
        beforeId: head.id,
      });
      const older = fromRecords(messages);
      set((s) => {
        const cur = s.messagesBySession[sessionId] ?? EMPTY_MESSAGES;
        // Avoid duplicates if the cursor drifted (defensive; the (createdAt,id)
        // tiebreaker should already prevent overlap).
        const existingIds = new Set(cur.map((m) => m.id));
        const merged = [...older.filter((m) => !existingIds.has(m.id)), ...cur];
        return {
          messagesBySession: { ...s.messagesBySession, [sessionId]: merged },
          hasMoreMessagesBySession: { ...s.hasMoreMessagesBySession, [sessionId]: hasMore },
          loadingOlderBySession: { ...s.loadingOlderBySession, [sessionId]: false },
        };
      });
    } catch (err) {
      console.error("loadOlderMessages failed:", err);
      set((s) => ({
        loadingOlderBySession: { ...s.loadingOlderBySession, [sessionId]: false },
      }));
    }
  },

  /** Remove a session from the tab strip. If it was the active tab, the
   *  focus shifts to the previous tab (the one to the left), or if there
   *  is none, to the new tail. Closing the last tab leaves the center
   *  pane empty (rendered as the "no session" placeholder).
   *
   *  In-flight turns are NOT cancelled — they keep streaming in the
   *  background, the events still get bucketed by sessionId, and the
   *  user can re-open the tab to see the latest state. We only drop the
   *  tab from the strip; the underlying session row + runtime binding
   *  are untouched. */
  closeTab: (sessionId) => {
    set((s) => {
      const idx = s.openTabs.indexOf(sessionId);
      if (idx === -1) return {};
      const nextTabs = s.openTabs.filter((id) => id !== sessionId);
      const wasActive = s.activeSessionId === sessionId;
      let nextActive = s.activeSessionId;
      if (wasActive) {
        // Prefer the tab to the left (idx - 1), or fall back to the new
        // tail (which used to be at idx). If neither exists, leave
        // activeSessionId null so the empty-state placeholder shows.
        if (nextTabs.length === 0) {
          nextActive = null;
        } else if (idx > 0) {
          nextActive = nextTabs[idx - 1];
        } else {
          nextActive = nextTabs[0];
        }
      }
      // Unified center bar focus: only the ACTIVE tab's closure moves it —
      // closing a background session tab must not yank the editor away.
      // Closing the active tab lands on the successor session's chat; when
      // that was the LAST session tab, keep the editor if a file is active
      // (otherwise the center would go blank for no reason).
      let centerTabFocus = s.centerTabFocus;
      if (wasActive) {
        if (nextTabs.length > 0) {
          centerTabFocus = "chat";
        } else {
          const pid = s.activeProjectId;
          centerTabFocus =
            pid && (s.ideActiveFileByProject[pid] ?? null) ? "editor" : "chat";
        }
      }
      // If the new active tab changed, sync its config so the composer
      // chips reflect the right model/effort/permission. Also clear its
      // unread badge - it's now the visible session.
      if (nextActive && nextActive !== s.activeSessionId) {
        // Defer to the set body: we can't call syncConfigFromSession
        // here because it uses the same `set`. Inline the same lookup.
        const sess = findSession(s.sessionsByProject, s.archivedSessionsByProject, s.pinnedSessions, nextActive);
        const unreadBySession = { ...s.unreadBySession };
        delete unreadBySession[nextActive];
        return {
          openTabs: nextTabs,
          activeSessionId: nextActive,
          model: sess?.model ?? s.model,
          effort: sess?.effort ?? s.effort,
          permissionMode: sess?.permissionMode ?? s.permissionMode,
          customModelId: sess?.customModelId ?? s.customModelId,
          unreadBySession,
          centerTabFocus,
        };
      }
      return { openTabs: nextTabs, activeSessionId: nextActive, centerTabFocus };
    });
  },

  /** Move a tab within the strip. No-op for out-of-range / same index. */
  reorderTab: (from, to) =>
    set((s) => {
      if (
        from === to ||
        from < 0 ||
        from >= s.openTabs.length ||
        to < 0 ||
        to >= s.openTabs.length
      ) {
        return {};
      }
      const next = [...s.openTabs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { openTabs: next };
    }),

  /** Hard-delete a project; its sessions + messages cascade-delete in the DB.
   *  If it was active, fall back to the first remaining project. */
  deleteProject: async (id) => {
    await api.project.delete({ id });
    set((s) => {
      const projects = s.projects.filter((p) => p.id !== id);
      const sessionsByProject = { ...s.sessionsByProject };
      const archivedByProject = { ...s.archivedSessionsByProject };
      const totalByProject = { ...s.sessionsTotalByProject };
      const hasMoreByProject = { ...s.sessionsHasMoreByProject };
      // Capture the deleted project's sessionIds BEFORE dropping the entries
      // so we can scrub them from the tab strip — both caches may hold rows.
      const removedSessionIds = new Set([
        ...(sessionsByProject[id] ?? []).map((sess) => sess.id),
        ...(archivedByProject[id] ?? []).map((sess) => sess.id),
      ]);
      delete sessionsByProject[id];
      delete archivedByProject[id];
      delete totalByProject[id];
      delete hasMoreByProject[id];
      // Scrub the deleted project's IDE editor buckets (open files / active
      // file / view mode / expanded dirs) so they don't linger as orphans.
      const ideOpenFilesByProject = { ...s.ideOpenFilesByProject };
      const ideActiveFileByProject = { ...s.ideActiveFileByProject };
      const ideFileViewModeByProject = { ...s.ideFileViewModeByProject };
      const ideExpandedDirsByProject = { ...s.ideExpandedDirsByProject };
      const gitDiffByProject = { ...s.gitDiffByProject };
      const navBackByProject = { ...s.navBackByProject };
      const navForwardByProject = { ...s.navForwardByProject };
      delete ideOpenFilesByProject[id];
      delete ideActiveFileByProject[id];
      delete ideFileViewModeByProject[id];
      delete ideExpandedDirsByProject[id];
      delete gitDiffByProject[id];
      delete navBackByProject[id];
      delete navForwardByProject[id];
      const wasActive = s.activeProjectId === id;
      if (!wasActive) {
        // Still need to scrub any open tabs that belonged to the deleted
        // project (tabs the user may have opened earlier in a different
        // active project).
        const openTabs = s.openTabs.filter((sid) => !removedSessionIds.has(sid));
        const activeSessionId = openTabs.includes(s.activeSessionId ?? "")
          ? s.activeSessionId
          : (openTabs[0] ?? null);
        return {
          projects, sessionsByProject, archivedSessionsByProject: archivedByProject,
          sessionsTotalByProject: totalByProject, sessionsHasMoreByProject: hasMoreByProject,
          ideOpenFilesByProject, ideActiveFileByProject, ideFileViewModeByProject, ideExpandedDirsByProject, gitDiffByProject,
          navBackByProject, navForwardByProject,
          openTabs, activeSessionId,
        };
      }
      // Pick a new active project + its latest session.
      const next = projects.find((p) => !p.archived) ?? projects[0];
      const nextSessions = next ? (sessionsByProject[next.id] ?? []) : [];
      const nextSession = nextSessions.find((sess) => !sess.archived);
      // Tabs that belonged to other (still-living) projects survive; tabs
      // for the deleted project are gone.
      const openTabs = s.openTabs.filter((sid) => !removedSessionIds.has(sid));
      return {
        projects,
        sessionsByProject,
        archivedSessionsByProject: archivedByProject,
        sessionsTotalByProject: totalByProject,
        sessionsHasMoreByProject: hasMoreByProject,
        ideOpenFilesByProject, ideActiveFileByProject, ideFileViewModeByProject, ideExpandedDirsByProject, gitDiffByProject,
        navBackByProject, navForwardByProject,
        activeProjectId: next?.id ?? null,
        sessions: nextSessions,
        activeSessionId: nextSession?.id ?? null,
        openTabs: nextSession ? [nextSession.id] : openTabs,
      };
    });
  },

  /** Set a project's archived flag (soft-delete; restorable from the archived view). */
  archiveProject: async (id, archived) => {
    const { project } = await api.project.archive({ id, archived });
    set((s) => {
      const projects = s.projects.map((p) => (p.id === id ? project : p));
      // If we just archived the active project, jump to the next active one.
      const wasActive = s.activeProjectId === id;
      // Scrub tabs belonging to the archived project — archived sessions
      // shouldn't linger in the center pane.
      const removedSessionIds = new Set((s.sessionsByProject[id] ?? []).map((sess) => sess.id));
      const openTabs = s.openTabs.filter((sid) => !removedSessionIds.has(sid));
      if (!wasActive || !archived) {
        return { projects, openTabs };
      }
      const next = projects.find((p) => !p.archived);
      const nextSessions = next ? (s.sessionsByProject[next.id] ?? []) : [];
      const nextSession = nextSessions.find((sess) => !sess.archived);
      return {
        projects,
        activeProjectId: next?.id ?? null,
        sessions: nextSessions,
        activeSessionId: nextSession?.id ?? null,
        openTabs: nextSession ? [nextSession.id] : openTabs,
      };
    });
  },

  /** Hard-delete a session; its messages cascade-delete in the DB. The row is
   *  removed from whichever per-project cache currently holds it (active or
   *  archived). If it was active, fall back to the next session in the same
   *  project. */
  deleteSession: async (id) => {
    await api.session.delete({ id });
    // Shared cleanup — a remote `session.deleted` event runs the same state
    // surgery (see applySessionDeletedState) so phone-side deletes behave
    // identically to local ones.
    set((s) => applySessionDeletedState(s, id));
  },

  /** Set a session's archived flag (soft-delete; restorable). The session
   *  MOVES between the active cache (`sessionsByProject`) and the archived
   *  cache (`archivedSessionsByProject`) of its project so each list only
   *  contains rows in the matching state — the left-bar tree renders active
   *  threads inline under the project, and archived threads in the bottom
   *  "已归档" bin, also grouped by project. Totals are recomputed from the
   *  server response so `hasMore` / the load-more button stay accurate. */
  archiveSession: async (id, archived) => {
    const { session } = await api.session.archive({ id, archived });
    set((s) => {
      const projectId = session.projectId;
      const isActiveProject = projectId === s.activeProjectId;

      // Pull the row out of whichever cache currently holds it and push the
      // server-fresh copy into the opposite cache. The global pinned bucket
      // participates too: archiving evicts the row from the pinned section
      // (pinned rows are active-only; the row stays visible in the bin), and
      // restoring a still-pinned row sends it back to the pinned section
      // rather than the project's list (pin survives archive/restore).
      const oldActive = s.sessionsByProject[projectId] ?? [];
      const oldArchived = s.archivedSessionsByProject[projectId] ?? [];
      // Whether the row sat in this project's active window — only then does
      // archiving shrink the active total (pinned rows aren't in it).
      const wasActiveRow = oldActive.some((x) => x.id === id);
      let nextActive: Session[];
      let nextArchived: Session[];
      let nextPinned = s.pinnedSessions;
      if (archived) {
        nextActive = oldActive.filter((x) => x.id !== id);
        nextArchived = [session, ...oldArchived.filter((x) => x.id !== id)];
        if (nextPinned.some((x) => x.id === id)) {
          nextPinned = nextPinned.filter((x) => x.id !== id);
        }
      } else {
        nextArchived = oldArchived.filter((x) => x.id !== id);
        if (session.pinnedAt != null) {
          nextActive = oldActive.filter((x) => x.id !== id);
          nextPinned = sortPinnedByRecency([
            session,
            ...nextPinned.filter((x) => x.id !== id),
          ]);
        } else {
          nextActive = [session, ...oldActive.filter((x) => x.id !== id)];
          if (nextPinned.some((x) => x.id !== id)) {
            nextPinned = nextPinned.filter((x) => x.id !== id);
          }
        }
      }
      const sessionsByProject = { ...s.sessionsByProject, [projectId]: nextActive };
      const archivedByProject = { ...s.archivedSessionsByProject };
      if (nextArchived.length > 0) {
        archivedByProject[projectId] = nextArchived;
      } else {
        delete archivedByProject[projectId];
      }
      // Keep the active-thread totals in lockstep with the cache move. Only
      // rows that actually sat in the active window (or now return to it)
      // move the count — a pinned row isn't part of the project list, so
      // archiving/restoring it leaves the total alone. The archive cache
      // isn't paginated, so no hasMore/total tracking needed there.
      const totalActive = Math.max(
        (s.sessionsTotalByProject[projectId] ?? 0) +
          (archived ? (wasActiveRow ? -1 : 0) : session.pinnedAt != null ? 0 : 1),
        0,
      );
      const hasMoreActive = totalActive > nextActive.length;

      // Archived sessions shouldn't stay open in the tab strip — the user
      // archived them, they don't want to see them in the center pane.
      const idx = s.openTabs.indexOf(id);
      const openTabs = archived && idx !== -1 ? s.openTabs.filter((sid) => sid !== id) : s.openTabs;
      const wasActive = s.activeSessionId === id;
      if (!isActiveProject || !wasActive || !archived) {
        return {
          sessionsByProject,
          archivedSessionsByProject: archivedByProject,
          pinnedSessions: nextPinned,
          sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: Math.max(totalActive, 0) },
          sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: hasMoreActive },
          sessions: isActiveProject ? nextActive : s.sessions,
          openTabs,
        };
      }
      // Archived the active session → jump to the next visible one.
      const next = nextActive.find((sess) => !sess.archived);
      let nextActiveId: string | null = next?.id ?? null;
      // If the new active was the previous tab (idx > 0), keep that; else
      // fall back to the new tail of the now-shortened list.
      if (openTabs.length > 0) {
        nextActiveId = idx > 0 ? openTabs[idx - 1] : openTabs[0];
      }
      const sess = nextActiveId
        ? findSession(sessionsByProject, archivedByProject, nextPinned, nextActiveId)
        : undefined;
      // Clear the new active session's unread badge - it's now visible.
      const unreadBySession = { ...s.unreadBySession };
      if (nextActiveId) delete unreadBySession[nextActiveId];
      return {
        sessionsByProject,
        archivedSessionsByProject: archivedByProject,
        pinnedSessions: nextPinned,
        sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: Math.max(totalActive, 0) },
        sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: hasMoreActive },
        sessions: nextActive,
        openTabs,
        activeSessionId: nextActiveId,
        model: sess?.model ?? s.model,
        effort: sess?.effort ?? s.effort,
        permissionMode: sess?.permissionMode ?? s.permissionMode,
        customModelId: sess?.customModelId ?? s.customModelId,
        unreadBySession,
      };
    });
  },

  renameSession: async (id, title) => {
    const { session } = await api.session.rename({ id, title });
    set((s) => {
      const projectId = session.projectId;
      // Update the row in whichever cache holds it (active page or archived
      // bin). Title is the only field that changes, but we replace the whole
      // row with the server-fresh copy to keep things consistent.
      const patchRow = (list: Session[] | undefined) =>
        list && list.some((x) => x.id === id)
          ? list.map((x) => (x.id === id ? session : x))
          : list;
      const sessionsByProject = { ...s.sessionsByProject };
      if (sessionsByProject[projectId]) {
        const next = patchRow(sessionsByProject[projectId]);
        if (next) sessionsByProject[projectId] = next;
      }
      const archivedSessionsByProject = { ...s.archivedSessionsByProject };
      if (archivedSessionsByProject[projectId]) {
        const next = patchRow(archivedSessionsByProject[projectId]);
        if (next) archivedSessionsByProject[projectId] = next;
      }
      const pinnedSessions = patchRow(s.pinnedSessions) ?? s.pinnedSessions;
      // The `sessions` alias mirrors the active project's list; refresh it in
      // case the renamed session lives in the active project (title chip etc.).
      const sessions = s.activeProjectId === projectId
        ? (sessionsByProject[projectId] ?? s.sessions)
        : s.sessions;
      return { sessionsByProject, archivedSessionsByProject, pinnedSessions, sessions };
    });
  },

  setSessionPinned: async (id, pinned) => {
    const { session } = await api.session.pin({ id, pinned });
    // Pinning MOVES the row: out of the project's active window and into the
    // global pinned section above the project tree (unpinning moves it back).
    // The shared state builder also runs for the cross-client
    // `session.changed` echo, so this stays idempotent.
    set((s) => applySessionPinnedState(s, session));
  },

  addBookmark: async (sessionId, input) => {
    const bookmark: SessionBookmark = {
      // Time + random suffix: two bookmarks added in the same millisecond
      // (impossible by hand, possible by scripted double-fire) stay distinct.
      id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      messageId: input.messageId,
      excerpt: input.excerpt,
      title: null,
      role: input.role,
      createdAt: Date.now(),
    };
    const prev = get().bookmarksBySession[sessionId] ?? EMPTY_BOOKMARKS;
    const next = [...prev, bookmark];
    // Optimistic bucket update first — the fly-to-capsule animation needs the
    // capsule segment (and its count) to appear before the IPC round-trip.
    set((s) => ({ bookmarksBySession: { ...s.bookmarksBySession, [sessionId]: next } }));
    try {
      const { session } = await api.session.updateBookmarks({ id: sessionId, bookmarks: next });
      // Patch the cached row with the same array reference (the schema parse
      // doesn't mutate values), so hydrateBookmarks's guard skips the rewrite.
      set((s) => patchSessionRowBookmarks(s, sessionId, session.projectId, next));
    } catch (err) {
      console.error("[store] addBookmark failed, rolling back", err);
      set((s) => {
        const bucket = { ...s.bookmarksBySession };
        const cur = bucket[sessionId];
        if (cur) {
          const filtered = cur.filter((b) => b.id !== bookmark.id);
          if (filtered.length > 0) bucket[sessionId] = filtered;
          else delete bucket[sessionId];
        }
        return { bookmarksBySession: bucket };
      });
    }
  },

  removeBookmark: async (sessionId, bookmarkId) => {
    const prev = get().bookmarksBySession[sessionId];
    if (!prev) return;
    const next = prev.filter((b) => b.id !== bookmarkId);
    if (next.length === prev.length) return;
    set((s) => {
      const bucket = { ...s.bookmarksBySession };
      if (next.length > 0) bucket[sessionId] = next;
      else delete bucket[sessionId];
      return { bookmarksBySession: bucket };
    });
    try {
      const { session } = await api.session.updateBookmarks({ id: sessionId, bookmarks: next });
      set((s) => patchSessionRowBookmarks(s, sessionId, session.projectId, next));
    } catch (err) {
      console.error("[store] removeBookmark failed, rolling back", err);
      set((s) => ({ bookmarksBySession: { ...s.bookmarksBySession, [sessionId]: prev } }));
    }
  },

  renameBookmark: async (sessionId, bookmarkId, title) => {
    const prev = get().bookmarksBySession[sessionId];
    if (!prev) return;
    const trimmed = title.trim().slice(0, 80);
    const nextTitle = trimmed.length > 0 ? trimmed : null;
    const existing = prev.find((b) => b.id === bookmarkId);
    if (!existing || (existing.title ?? null) === nextTitle) return;
    const next = prev.map((b) => (b.id === bookmarkId ? { ...b, title: nextTitle } : b));
    set((s) => ({ bookmarksBySession: { ...s.bookmarksBySession, [sessionId]: next } }));
    try {
      const { session } = await api.session.updateBookmarks({ id: sessionId, bookmarks: next });
      set((s) => patchSessionRowBookmarks(s, sessionId, session.projectId, next));
    } catch (err) {
      console.error("[store] renameBookmark failed, rolling back", err);
      set((s) => ({ bookmarksBySession: { ...s.bookmarksBySession, [sessionId]: prev } }));
    }
  },

  applySessionTitleUpdate: (sessionId, title) => {
    // Find the session's projectId from whichever cache holds it. The main
    // process already persisted the title, so we only patch in-memory lists.
    set((s) => {
      // Side chats live in the ask tab's per-parent buckets, not the
      // left-bar caches — patch those and be done.
      for (const [parent, list] of Object.entries(s.sideChatsByParent)) {
        if (list?.some((x) => x.id === sessionId)) {
          return {
            sideChatsByParent: {
              ...s.sideChatsByParent,
              [parent]: list.map((x) => (x.id === sessionId ? { ...x, title } : x)),
            },
          };
        }
      }
      let projectId: string | undefined;
      for (const pid of Object.keys(s.sessionsByProject)) {
        if (s.sessionsByProject[pid]?.some((x) => x.id === sessionId)) {
          projectId = pid;
          break;
        }
      }
      // Pinned rows live in the global pinned bucket — their owning project
      // comes from the row itself.
      const pinnedRow = projectId
        ? undefined
        : s.pinnedSessions.find((x) => x.id === sessionId);
      if (!projectId && pinnedRow) projectId = pinnedRow.projectId;
      if (!projectId) {
        for (const pid of Object.keys(s.archivedSessionsByProject)) {
          if (s.archivedSessionsByProject[pid]?.some((x) => x.id === sessionId)) {
            projectId = pid;
            break;
          }
        }
      }
      if (!projectId) return {}; // session not loaded anywhere yet

      // Patch the title in whichever cache(s) hold the row.
      const patchRow = (list: Session[] | undefined) =>
        list && list.some((x) => x.id === sessionId)
          ? list.map((x) => (x.id === sessionId ? { ...x, title } : x))
          : list;

      const sessionsByProject = { ...s.sessionsByProject };
      if (sessionsByProject[projectId]) {
        const next = patchRow(sessionsByProject[projectId]);
        if (next) sessionsByProject[projectId] = next;
      }
      const archivedSessionsByProject = { ...s.archivedSessionsByProject };
      if (archivedSessionsByProject[projectId]) {
        const next = patchRow(archivedSessionsByProject[projectId]);
        if (next) archivedSessionsByProject[projectId] = next;
      }
      const pinnedSessions = patchRow(s.pinnedSessions) ?? s.pinnedSessions;
      const sessions = s.activeProjectId === projectId
        ? (sessionsByProject[projectId] ?? s.sessions)
        : s.sessions;
      return { sessionsByProject, archivedSessionsByProject, pinnedSessions, sessions };
    });
  },

  sendPrompt: async (prompt, attachments, displayText, skillsUsed, images, displayBlocks, sessionIdArg) => {
    const sessionId = sessionIdArg ?? get().activeSessionId;
    if (!sessionId) return false;
    // An image-only turn (no typed text) is valid — the images are the prompt.
    if (!prompt.trim() && !(images && images.length > 0)) return false;
    // Per-thread guard: only block this thread from sending if IT is running.
    // Another thread's running turn shouldn't lock the composer in this one.
    if (get().runningBySession[sessionId]) return false;

    // Resolve the model BEFORE showing the user message: "default" (auto,
    // e.g. right after an SDK switch) means "first configured model"; a
    // provider with nothing configured can't send at all — prompt the user
    // to configure one instead of silently using the provider's internal
    // default. Aborting here leaves the composer untouched.
    const resolvedModel = resolveSendModel(get());
    if (!resolvedModel) {
      set({ modelConfigPromptOpen: true });
      return false;
    }

    // 1. immediately show the user's message. Attachments (pasted content
    //    promoted to cards in the composer) render as attachment blocks
    //    ABOVE the typed text, mirroring the composer's chip-above-editor
    //    layout. The text block shows only the typed text (displayText) —
    //    the full `prompt` (with attachments inlined via
    //    composePromptWithTags) is what the SDK receives, but showing it
    //    here too would duplicate the attachment content as plain text.
    //    `skillsUsed` records which `/name` occurrences in the text are skill
    //    pills, so the stream can render them as styled inline pills.
    const blocks: Block[] = [];
    if (attachments) {
      for (const a of attachments) {
        blocks.push({
          kind: "attachment",
          preview: a.preview,
          content: a.content,
          attachmentKind: a.attachmentKind,
          filePath: a.filePath,
        });
      }
    }
    // User-attached images render inline between the attachment cards and the
    // text block (mirrors the composer's chip-above-editor layout).
    if (images) {
      for (const img of images) {
        blocks.push({ kind: "image", data: img.data, mimeType: img.mimeType });
      }
    }
    // Image-only turns have no text block at all (empty bubble otherwise).
    // `displayBlocks` (plan handoff) replaces the default text block with
    // richer content — e.g. a short note + the plan card — so the raw
    // kickoff prompt never dumps into the bubble.
    if (displayBlocks) {
      blocks.push(...displayBlocks);
    } else {
      const textForBlock = displayText ?? prompt;
      if (textForBlock.trim()) {
        blocks.push({
          kind: "text",
          text: textForBlock,
          skillNames: skillsUsed && skillsUsed.length > 0 ? skillsUsed : undefined,
        });
      }
    }
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      sessionId,
      role: "user",
      blocks,
      createdAt: Date.now(),
    };
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...(s.messagesBySession[sessionId] ?? []), userMsg],
      },
      runningBySession: { ...s.runningBySession, [sessionId]: true },
      // NOTE: subagent roster/transcripts are intentionally NOT cleared here
      // — they are session-scoped history now; main replays the accumulated
      // state at each turn start (RuntimeManager.sendTurn).
      // Stamp the turn's start time NOW (send moment), not when the first
      // assistant block arrives. This anchors the synthesized "开始 · 用时"
      // row that renders before any token lands, and the real turnMeta
      // (stamped at the first delta/tool/plan) falls back to this value so
      // the timing is continuous across the handoff. Reuses userMsg.createdAt
      // (not a fresh Date.now()) so the turn-done incremental persist's
      // `createdAt >= anchor` filter can never tick past the user message
      // and drop it from the persisted tail on a millisecond boundary.
      runningTurnStartedAt: { ...s.runningTurnStartedAt, [sessionId]: userMsg.createdAt },
      // A new turn supersedes any prior manual interrupt: clear the sentinel
      // so subagent.update / turn.done events for THIS turn aren't filtered.
      interruptedBySession: { ...s.interruptedBySession, [sessionId]: false },
    }));

	    // 2. fire the turn; events stream back via ingestEvent. Run the IPC in
	    //    the BACKGROUND and return true the moment the user message lands
	    //    in the stream — the main handler awaits provider.startTurn (SDK
	    //    spawn / bridge acquisition) before its invoke resolves, which can
	    //    take hundreds of ms. Awaiting it here kept the composer's typed
	    //    text frozen next to the already-rendered user bubble, which read
	    //    as "send lag". Ship the
	    //    current model / customModelId / effort / permissionMode from the
	    //    store as per-turn overrides - the DB row may be stale because
	    //    `setModel` / `setCustomModel` persist via fire-and-forget
	    //    `updateSettings`, which races `sendTurn`. The main handler
	    //    applies these overrides to the in-memory session so
	    //    RuntimeManager always sees the latest UI state. The model pair
	    //    comes from `resolvedModel` above (auto → first configured model).
	    void (async () => {
      const { effort, permissionMode, providerId } = get();
      let updated;
      try {
        ({ session: updated } = await api.claude.sendTurn({
          sessionId,
          prompt,
          model: resolvedModel.model,
          effort,
          permissionMode,
          customModelId: resolvedModel.customModelId,
          // Per-turn provider override — lets the active provider drive
          // which backend handles this turn without persisting the change
          // to the session row. Combined with the per-turn overrides above
          // this keeps "switch SDK at any time" working.
          providerId,
          skills: skillsUsed && skillsUsed.length > 0 ? skillsUsed : undefined,
          // User-attached images inlined into the provider request (base64
          // content blocks — never paths).
          images: images && images.length > 0 ? images : undefined,
          // Cross-client echo: main re-broadcasts this bubble to every OTHER
          // client (phone ⇄ PC) as a `user.message` event keyed by the id.
          // The local copy appended above makes the echo a no-op here.
          userMessage: { id: userMsg.id, createdAt: userMsg.createdAt, blocks: userMsg.blocks },
        }));
      } catch (err) {
        // The IPC itself rejected (not a streamed `error` event). Without
        // this the running flag + synthesized stat row would stick forever
        // - no turn.done/error event will arrive to clear them. Reset both
        // so the composer unlocks and the pending row disappears. The prompt
        // IS in the stream, so the send is still treated as accepted (the
        // caller already cleared the composer).
        console.error("sendTurn IPC failed:", err);
        set((s) => {
          const runningBySession = { ...s.runningBySession, [sessionId]: false };
          const runningTurnStartedAt = { ...s.runningTurnStartedAt };
          delete runningTurnStartedAt[sessionId];
          return { runningBySession, runningTurnStartedAt };
        });
        // IPC rejected → no terminal event will arrive to clear the turn, so
        // also try draining the queue here (the session is now idle).
        get().drainPromptQueueIfIdle(sessionId);
        return;
      }
      set((s) => {
        // Side chats never touch the left-bar caches — patch the ask tab's
        // per-parent bucket instead (the row carries the first-question
        // rewrite of the "Quick ask" placeholder title). List order is
        // created_at, so replace-in-place rather than unshift.
        if (updated.kind === "side") {
          const parent = updated.parentSessionId;
          if (!parent) return {};
          const list = s.sideChatsByParent[parent];
          if (!list) return {};
          return {
            sideChatsByParent: {
              ...s.sideChatsByParent,
              [parent]: list.map((x) => (x.id === updated.id ? updated : x)),
            },
          };
        }
        const pid = updated.projectId;
        const prevList = s.sessionsByProject[pid] ?? [];
        // Sending a message makes this session the most recently active, so move
        // it to the head of the list (mirrors the `updated_at DESC` server order
        // and the head-insert done by `startSession`). Replace-in-place would
        // leave a stale position; unshift keeps the left bar in sync with activity.
        const rest = prevList.filter((sess) => sess.id !== updated.id);
        const nextList = [updated, ...rest];
        return {
          sessionsByProject: { ...s.sessionsByProject, [pid]: nextList },
          sessions: pid === s.activeProjectId ? nextList : s.sessions,
        };
      });
    })();
    // Accepted: the user message is in the stream and the turn is dispatched
    // in the background. The caller clears the composer immediately.
    return true;
  },

  editAndResendMessage: async (sessionId, messageId, newPrompt, attachments, displayText, skillsUsed, images) => {
    if (!sessionId || !newPrompt.trim()) return;
    // The session must be idle - editing while a turn is running would
    // race the truncation against live event ingestion.
    if (get().runningBySession[sessionId]) return;

    // Same send-model guard as sendPrompt: auto → first configured model;
    // nothing configured → prompt instead of silently falling back.
    const resolvedModel = resolveSendModel(get());
    if (!resolvedModel) {
      set({ modelConfigPromptOpen: true });
      return;
    }

    const current = get().messagesBySession[sessionId] ?? [];
    const idx = current.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const editedMsg = current[idx];
    if (!editedMsg) return;

    // 1. Truncate: keep only messages BEFORE the edited one. The edited
    //    message itself and everything after it (the AI's reply, any
    //    follow-up exchanges) are discarded.
    const truncated = current.slice(0, idx);

    // 2. Build the new user message from the edited prompt. Mirrors
    //    sendPrompt's block construction: attachment blocks first, then a
    //    single text block holding displayText (or the raw prompt when
    //    there are no attachments).
    //    User-attached images on the edited message survive the edit — the
    //    inline editor shows them as removable thumbnails and passes back the
    //    surviving list; the blocks already carry the base64, so they're
    //    re-sent verbatim without re-reading anything from disk. An omitted
    //    list (no editor round-trip) preserves every image, matching the
    //    pre-editor behavior.
    const preservedImages: PromptImage[] =
      images ??
      editedMsg.blocks
        .filter((b): b is Extract<Block, { kind: "image" }> => b.kind === "image")
        .map((b) => ({ data: b.data, mimeType: b.mimeType as PromptImage["mimeType"] }));
    // A plan block on the edited message (the plan handoff's first prompt)
    // survives the edit verbatim — the card keeps rendering on the re-sent
    // bubble, and its text is re-appended to the model prompt below. The
    // inline editor only edits the note text, so without this the re-send
    // would silently drop the plan the executor runs on.
    const preservedPlanBlock = editedMsg.blocks.find(
      (b): b is Extract<Block, { kind: "plan" }> => b.kind === "plan",
    );
    const modelPrompt = preservedPlanBlock
      ? `${newPrompt}\n\n<approved-plan>\n${preservedPlanBlock.plan}\n</approved-plan>`
      : newPrompt;
    const blocks: Block[] = [];
    if (attachments) {
      for (const a of attachments) {
        blocks.push({
          kind: "attachment",
          preview: a.preview,
          content: a.content,
          attachmentKind: a.attachmentKind,
          filePath: a.filePath,
        });
      }
    }
    for (const img of preservedImages) {
      blocks.push({ kind: "image", data: img.data, mimeType: img.mimeType });
    }
    blocks.push({
      kind: "text",
      text: displayText ?? newPrompt,
      skillNames: skillsUsed && skillsUsed.length > 0 ? skillsUsed : undefined,
    });
    if (preservedPlanBlock) blocks.push(preservedPlanBlock);
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      sessionId,
      role: "user",
      blocks,
      createdAt: Date.now(),
    };

    // 3. Apply the truncation + new message + running flag atomically.
    //    Also clear the per-turn file snapshot for this session: the old
    //    turn's "本轮修改" card belongs to the truncated-away history and
    //    must not survive the edit.
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...truncated, userMsg],
      },
      runningBySession: { ...s.runningBySession, [sessionId]: true },
      // Same anchor rule as sendPrompt: reuse userMsg.createdAt so the
      // turn-done incremental persist can never filter out the user message.
      runningTurnStartedAt: { ...s.runningTurnStartedAt, [sessionId]: userMsg.createdAt },
      // A new turn supersedes any prior manual interrupt: clear the sentinel
      // so subagent.update / turn.done events for THIS turn aren't filtered.
      interruptedBySession: { ...s.interruptedBySession, [sessionId]: false },
      turnFilesBySession: { ...s.turnFilesBySession, [sessionId]: [] },
    }));

    // 4. Persist the truncation immediately so a crash mid-turn doesn't leave
    //    the DB with the old (pre-edit) messages. Use truncateAndInsert rather
    //    than replaceAll so that older rows not loaded into renderer memory
    //    (paginated out) are preserved — replaceAll would wipe the whole table
    //    and lose them. The cursor is the edited message's (createdAt, id);
    //    the new user message is the only row inserted now (subsequent turn
    //    events stream in via upsertMessages on terminal events).
    void api.session.truncateAndInsertMessages({
      sessionId,
      cursorCreatedAt: editedMsg.createdAt,
      cursorId: editedMsg.id,
      messages: toRecords(sessionId, [userMsg]),
    });

    // 5. Fire the turn; events stream back via ingestEvent. Same per-turn
    //    override pattern as sendPrompt (model pair from resolvedModel above),
    //    and same BACKGROUND dispatch: the truncated stream + new user message
    //    are already on screen, so don't block this action's completion on the
    //    main process's provider.startTurn round-trip.
    void (async () => {
      const { effort, permissionMode, providerId } = get();
      let updated;
      try {
        ({ session: updated } = await api.claude.sendTurn({
          sessionId,
          // Carries the preserved plan payload (if any) — the bubble's text
          // block shows only the edited note text.
          prompt: modelPrompt,
          model: resolvedModel.model,
          effort,
          permissionMode,
          customModelId: resolvedModel.customModelId,
          providerId,
          skills: skillsUsed && skillsUsed.length > 0 ? skillsUsed : undefined,
          // Preserved user-attached images from the pre-edit message.
          images: preservedImages.length > 0 ? preservedImages : undefined,
          // Cross-client echo (same as sendPrompt): other clients append the
          // re-sent bubble by id. Their stale pre-edit tail is a separate
          // cross-client sync concern; this at least surfaces the new prompt.
          userMessage: {
            id: userMsg.id,
            createdAt: userMsg.createdAt,
            blocks: userMsg.blocks,
            // Edit marker: other connected clients truncate their own stale
            // pre-edit tail at THIS message before appending, so the old
            // message (and its old reply) don't survive on their screens or
            // get re-persisted into the DB at their turn.done.
            editedMessageId: messageId,
          },
        }));
      } catch (err) {
        console.error("editAndResendMessage: sendTurn IPC failed:", err);
        set((s) => {
          const runningBySession = { ...s.runningBySession, [sessionId]: false };
          const runningTurnStartedAt = { ...s.runningTurnStartedAt };
          delete runningTurnStartedAt[sessionId];
          return { runningBySession, runningTurnStartedAt };
        });
        get().drainPromptQueueIfIdle(sessionId);
        return;
      }
      set((s) => {
        // Side chats patch the ask tab's per-parent bucket (see sendPrompt).
        if (updated.kind === "side") {
          const parent = updated.parentSessionId;
          const list = parent ? s.sideChatsByParent[parent] : undefined;
          if (!parent || !list) return {};
          return {
            sideChatsByParent: {
              ...s.sideChatsByParent,
              [parent]: list.map((x) => (x.id === updated.id ? updated : x)),
            },
          };
        }
        const pid = updated.projectId;
        const prevList = s.sessionsByProject[pid] ?? [];
        // Sending a message makes this session the most recently active, so move
        // it to the head of the list (mirrors the `updated_at DESC` server order
        // and the head-insert done by `startSession`). Replace-in-place would
        // leave a stale position; unshift keeps the left bar in sync with activity.
        const rest = prevList.filter((sess) => sess.id !== updated.id);
        const nextList = [updated, ...rest];
        return {
          sessionsByProject: { ...s.sessionsByProject, [pid]: nextList },
          sessions: pid === s.activeProjectId ? nextList : s.sessions,
        };
      });
    })();
  },

  interrupt: async (sessionIdArg) => {
    const sessionId = sessionIdArg ?? get().activeSessionId;
    if (!sessionId) return;
    await api.claude.interrupt({ sessionId });
    // Drop this session's buffered deltas: after abort, flushFinal may emit a
    // few straggler text.delta/thinking while the generator unwinds, but the
    // user asked to STOP — none of it should reach the page. Combined with
    // the ingestEvent content freeze (sentinel check below), the transcript
    // stays frozen exactly where the user stopped it.
    clearSessionDeltas(sessionId);
    // Clear only the interrupted thread's flag. The `turn.done` (with reason
    // "interrupted") event from main will also clear it; doing it here too
    // is a defensive in case the event races with the user click.
    //
    // Also demote any still-running subagents (typically backgrounded tasks
    // whose lifecycle outlived the parent turn's stream) to "killed": the
    // user asked to STOP, so the composer must unlock even if the CLI hasn't
    // fully torn those tasks down yet.
    //
    // Set a per-session "interrupted" sentinel so the LATE events that the
    // abort unwinds (flushFinal's subagent.update carrying still-running
    // backgrounded subagents, and the follow-up turn.done) can't resurrect a
    // running subagent / keep the roster alive and re-lock the composer. The
    // sentinel survives until the next real turn starts (sendPrompt /
    // editAndResendMessage clear it). Without it, switching tabs away and
    // back re-mounts ChatPane, re-reads the running roster, and the send
    // button flips back to "running".
    set((s) => {
      const runningTurnStartedAt = { ...s.runningTurnStartedAt };
      delete runningTurnStartedAt[sessionId];
      const curAgents = s.subagentsBySession[sessionId] ?? [];
      const subagentsBySession = curAgents.some((a) => a.status === "running")
        ? {
            ...s.subagentsBySession,
            [sessionId]: curAgents.map((a) =>
              a.status === "running" ? { ...a, status: "killed" as const } : a,
            ),
          }
        : s.subagentsBySession;
      const list = s.messagesBySession[sessionId];
      // Freeze the aborted turn's "开始·用时" row NOW instead of waiting for
      // the late turn.done{interrupted} (which lands seconds later while the
      // SDK unwinds). The turn.done reducer only stamps endedAt where it's
      // still undefined, so this earlier freeze is never overwritten.
      const frozen = list
        ? list.map((m) =>
            m.turnMeta && m.turnMeta.endedAt === undefined
              ? { ...m, turnMeta: { ...m.turnMeta, endedAt: Date.now() } }
              : m,
          )
        : undefined;
      return {
        runningBySession: { ...s.runningBySession, [sessionId]: false },
        runningTurnStartedAt,
        interruptedBySession: { ...s.interruptedBySession, [sessionId]: true },
        subagentsBySession,
        ...(frozen ? { messagesBySession: { ...s.messagesBySession, [sessionId]: frozen } } : {}),
      };
    });
    // User stopped the turn — drop any live upstream-retry hint with it.
    clearUpstreamIssue(set, sessionId);
  },

  ingestEvent: (e) => {
    const sid = e.sessionId;

    // Capture the current turn's send-time anchor BEFORE any set() runs —
    // turn.done clears it inside its own set, so by the time we reach the
    // terminal-event persist below it's gone. Keeping it lets us persist only
    // this turn's messages (incremental upsert) instead of the whole session.
    const turnStartAtCapture = get().runningTurnStartedAt[sid];

    // Bump the unread counter for non-active sessions on noteworthy events.
    // The counter drives the red-dot badge in the left bar + tab strip so the
    // user knows "this background thread has new activity you haven't seen."
    // Cleared on selectSession/openTab (user looked at it). We do NOT bump for
    // streaming deltas / thinking / tool-use-start / plan-drafting - those are
    // mid-turn noise that would make the badge flicker incessantly. Only
    // terminal and blocking events count: the user actually needs to act or
    // the result is ready.
    const bumpUnread = () => {
      if (isSideChatSession(sid, get())) return;
      if (isSessionChatOnScreen(sid, get())) return;
      set((s) => ({
        unreadBySession: { ...s.unreadBySession, [sid]: (s.unreadBySession[sid] ?? 0) + 1 },
      }));
    };
    // Push an in-app toast for non-active sessions when the window is focused.
    // When the window is unfocused, the main-process NotificationManager
    // handles OS notifications instead. Toasts are always supplemented by the
    // badge (bumpUnread), so the user sees both the dot + the detail card.
    const pushToast = (kind: "info" | "warning" | "error", title: string, body?: string) => {
      if (isSideChatSession(sid, get())) return;
      if (isSessionChatOnScreen(sid, get())) return;
      if (!get().isWindowFocused) return;
      useToastStore.getState().push({ kind, title, body, sessionId: sid });
    };

    // Terminal events: flush any buffered deltas before processing the
    // turn-end event so no content is lost when the stream closes.
    if (e.type === "turn.done" || e.type === "error") {
      forceDeltaFlush();
    }
    // A tool.use must land AFTER any narration text that has already
    // streamed. The text is still sitting in the rAF delta buffer — flush it
    // first (for EVERY tool.use, not just ones carrying an owning messageId:
    // pi snapshots the narration message at toolcall_start; claude reuses
    // the preceding text/thinking block's messageId). Without the flush a
    // messageId-less tool could be appended to an earlier message while the
    // buffered narration later materializes as a message AFTER it — the
    // renderer's completed-turn split ("everything up to the last tool call
    // is process") would then misclassify that narration as the final reply
    // and leak it out of the process panel.
    if (e.type === "tool.use") {
      forceDeltaFlush();
    }

    // Stale `turn.done` guard — fixes the stop→edit→resend race.
    //
    // When the user clicks stop, interrupt() flips runningBySession to false
    // and sets the interruptedBySession sentinel. The SDK's async iterator
    // then unwinds (ac.abort() throws), and flushFinal() emits a *late*
    // turn.done{reason:"interrupted"} once the generator actually tears down.
    //
    // If the user edits & resends BEFORE that late event lands,
    // editAndResendMessage clears the sentinel and flips running back to true
    // for the NEW turn. The late turn.done then arrives carrying
    // reason:"interrupted" while the sentinel is already cleared — proof it
    // belongs to the OLD (aborted) turn. Applying it would (a) stamp endedAt
    // on the NEW turn's opener (splitting the stream into two "开始·用时"
    // panels) and (b) reset runningBySession to false (composer looks idle,
    // no spinner).
    //
    // Detection: a turn.done with reason "interrupted" is the closing event
    // of an aborted turn. If interruptedBySession is NOT set, either no abort
    // happened (impossible for this reason) or a newer turn already started
    // and cleared the sentinel → stale. Drop it. The legitimate path (user
    // stopped, didn't resend) still has the sentinel set when the late
    // turn.done arrives, so it runs and freezes the interrupted turn's opener.
    if (e.type === "turn.done" && e.reason === "interrupted" && !get().interruptedBySession[sid]) {
      return;
    }

    // Turn end: snapshot the final subagent roster + transcripts onto the
    // cached session row(s). hydrateCapsule / hydrateSubagentTranscripts read
    // the ROW, and the row as loaded predates this turn — without this patch
    // a tab-switch-and-back would clobber the live buckets with the stale row
    // value (the "subagents vanish after the turn ends" symptom). (Main
    // persists the same data to DB, so a restart reloads it via the row
    // naturally.) Done once here rather than per event — those fire per
    // subagent MESSAGE and must not re-render the left bar.
    if (e.type === "turn.done") {
      const transcripts = get().subagentTranscriptsBySession[sid];
      const agents = get().subagentsBySession[sid];
      if ((transcripts && Object.keys(transcripts).length > 0) || (agents && agents.length > 0)) {
        set((s) => {
          const mapRow = (x: Session) =>
            x.id === sid
              ? {
                  ...x,
                  ...(transcripts && Object.keys(transcripts).length > 0
                    ? { subagentTranscripts: transcripts }
                    : {}),
                  ...(agents && agents.length > 0 ? { subagents: agents } : {}),
                }
              : x;
          const patch: Partial<SessionState> = {};
          for (const [pid, list] of Object.entries(s.sessionsByProject)) {
            if (list?.some((x) => x.id === sid)) {
              patch.sessionsByProject = {
                ...(patch.sessionsByProject ?? s.sessionsByProject),
                [pid]: list.map(mapRow),
              };
            }
          }
          if (s.pinnedSessions.some((x) => x.id === sid)) {
            patch.pinnedSessions = s.pinnedSessions.map(mapRow);
          }
          return patch;
        });
      }
    }

    // Stop → freeze the transcript: while the interrupt sentinel is set, drop
    // any remaining content-carrying events from the aborted turn. flushFinal
    // emits buffered text.delta / thinking / tool.result while the SDK
    // generator unwinds — seconds after the Stop click — and without this
    // guard they'd keep rendering. Status events still flow so cleanup
    // proceeds. sendPrompt / editAndResendMessage clear the sentinel, so a
    // NEW turn's events stream normally again.
    if (get().interruptedBySession[sid] && CONTENT_FROZEN_EVENTS.has(e.type)) {
      return;
    }

    // session.runningSnapshot — mobile SSE (re)connect compensation. The
    // mobile event bus is unbuffered: a phone backgrounded while a turn ran
    // (iOS suspends EventSource) misses the terminal `turn.done` and its
    // runningBySession stays stuck on — which keeps the spinner alive and
    // silently disables the slash picker (inputBlocked). The host pushes
    // this snapshot as the first frame of every SSE (re)connect; it carries
    // the authoritative running set, so replace our local guesses wholesale.
    // `runningTurnStartedAt` is intentionally left untouched: its consumers
    // all fall back to Date.now(), so a snapshot-discovered running turn
    // persists correctly when its (possibly missed-then-resynced) turn.done
    // lands.
    if (e.type === "session.runningSnapshot") {
      const running = new Set(e.running);
      set((s) => {
        const next: Record<string, boolean> = {};
        for (const id of Object.keys(s.runningBySession)) next[id] = running.has(id);
        for (const id of running) next[id] = true;
        return { runningBySession: next };
      });
      return;
    }

    // user.message — cross-client echo of a prompt typed on another client
    // (phone → PC or PC → phone), emitted by main right before the turn
    // starts. The originator appended its bubble optimistically at send and
    // passed the SAME id, so the id check below makes the echo a no-op
    // there; everyone else appends the bubble verbatim, in time to sit above
    // the assistant reply that is about to stream in. Without this, a
    // phone-typed prompt only reached the PC via the DB on a later
    // open/restart — a hydrated session never re-fetched, so the bubble was
    // simply missing while the reply streamed in headerless.
    if (e.type === "user.message") {
      bumpUnread();
      set((s) => {
        const list = s.messagesBySession[sid] ?? EMPTY_MESSAGES;
        // Originator's own echo (id already present) — nothing to append (the
        // originator already truncated + optimistically appended at edit time).
        if (list.some((m) => m.id === e.messageId)) return s;
        // Cross-client EDIT (e.g. edited on the phone, echoed here): drop the
        // stale pre-edit tail — the message being replaced and everything
        // after it — BEFORE appending the re-sent bubble. Without this, a
        // second connected device keeps the old message + its old reply in
        // memory, shows them live, and at its own turn.done re-persists that
        // stale tail into the DB, resurrecting rows the originator truncated
        // away (a later re-open then shows duplicates). Receivers that don't
        // have the edited message (already truncated / not loaded) fall back
        // to a plain append.
        let base = list;
        if (e.editedMessageId) {
          const idx = base.findIndex((m) => m.id === e.editedMessageId);
          if (idx !== -1) base = base.slice(0, idx);
        }
        const msg: ChatMessage = {
          id: e.messageId,
          sessionId: sid,
          role: "user",
          // Trusted payload from our own renderer/mobile peer, same as the
          // persisted message content trusted by fromRecords on reload.
          blocks: e.blocks as Block[],
          createdAt: e.createdAt,
        };
        return { messagesBySession: { ...s.messagesBySession, [sid]: [...base, msg] } };
      });
      return;
    }

    // todo.update is an independent state slice — handle and skip the
    // message-accumulation logic below.
    if (e.type === "todo.update") {
      set((s) => ({ todosBySession: { ...s.todosBySession, [sid]: e.todos } }));
      return;
    }
    // git.changed — a repo's git state changed on the host (any client).
    // Independent state slice: bump the per-repo version; git surfaces
    // re-fetch in their own effects. No sessionId semantics — the host emits
    // "" (envelope compatibility, see SessionRunningSnapshotEvent).
    if (e.type === "git.changed") {
      set((s) => ({
        gitChangeVersionByRepo: {
          ...s.gitChangeVersionByRepo,
          [e.repoPath]: (s.gitChangeVersionByRepo[e.repoPath] ?? 0) + 1,
        },
      }));
      return;
    }
    // session.changed — cross-client list sync (a phone or another client
    // created/renamed/pinned/archived a session; the same event also echoes
    // our OWN local mutations back, idempotently). Upserts the slim row into
    // whichever per-project cache is loaded. Unloaded projects are skipped —
    // their buckets are (re)fetched wholesale by loadSessions/selectProject.
    if (e.type === "session.changed") {
      const entry = e.session;
      // Side chats never belong in the left-bar caches. Main-side creation
      // and title rewrites don't broadcast for them, but a patch arriving
      // through some other path must not leak a side row into the lists —
      // route it to the ask tab's per-parent bucket instead.
      if (entry.kind === "side") {
        set((s) => {
          const parent = entry.parentSessionId;
          const list = parent ? s.sideChatsByParent[parent] : undefined;
          if (!parent || !list) return {};
          return {
            sideChatsByParent: {
              ...s.sideChatsByParent,
              [parent]: list.some((x) => x.id === entry.id)
                ? list.map((x) => (x.id === entry.id ? { ...x, ...entry } : x))
                : [materializeSessionEntry(entry), ...list],
            },
          };
        });
        return;
      }
      set((s) => {
        const patch: Partial<SessionState> = {};
        let touched = false;
        // Global pinned bucket — upsert while the changed row is pinned AND
        // active, evict otherwise (unpinned / archived). Maintained regardless
        // of whether the owning project's window is loaded, since the pinned
        // section is global. This is the echo path for remote pin toggles;
        // local toggles also end here after applySessionPinnedState (no-op).
        const inPinned = s.pinnedSessions.some((x) => x.id === entry.id);
        const shouldBePinned = !entry.archived && entry.pinnedAt != null;
        if (shouldBePinned) {
          patch.pinnedSessions = inPinned
            ? s.pinnedSessions.map((x) => (x.id === entry.id ? { ...x, ...entry } : x))
            : sortPinnedByRecency([materializeSessionEntry(entry), ...s.pinnedSessions]);
          touched = true;
        } else if (inPinned) {
          patch.pinnedSessions = s.pinnedSessions.filter((x) => x.id !== entry.id);
          touched = true;
        }
        const activeList = s.sessionsByProject[entry.projectId];
        if (activeList) {
          const exists = activeList.some((x) => x.id === entry.id);
          let next: Session[];
          if (entry.archived || entry.pinnedAt != null) {
            // Left the active window — archived (moved to the bin) or pinned
            // (moved to the global pinned section above the project tree);
            // drop it from the active window; totals shrink accordingly.
            next = activeList.filter((x) => x.id !== entry.id);
            if (next.length !== activeList.length) {
              patch.sessionsTotalByProject = {
                ...s.sessionsTotalByProject,
                [entry.projectId]: Math.max((s.sessionsTotalByProject[entry.projectId] ?? 0) - 1, 0),
              };
              patch.sessionsHasMoreByProject = {
                ...s.sessionsHasMoreByProject,
                [entry.projectId]: (s.sessionsTotalByProject[entry.projectId] ?? 0) - 1 > next.length,
              };
            }
          } else if (exists) {
            // Merge the slim entry OVER the cached row so heavy payloads
            // (contextSnapshot / turnFiles / …) survive the update.
            next = activeList.map((x) => (x.id === entry.id ? { ...x, ...entry } : x));
          } else {
            // A session created on another client — materialize it at the
            // head of the loaded window.
            next = [materializeSessionEntry(entry), ...activeList];
            patch.sessionsTotalByProject = {
              ...s.sessionsTotalByProject,
              [entry.projectId]: (s.sessionsTotalByProject[entry.projectId] ?? 0) + 1,
            };
          }
          patch.sessionsByProject = { ...s.sessionsByProject, [entry.projectId]: next };
          touched = true;
        }
        const archivedList = s.archivedSessionsByProject[entry.projectId];
        if (archivedList) {
          const exists = archivedList.some((x) => x.id === entry.id);
          if (!entry.archived) {
            // Restored from the bin — drop it from the archived window.
            const next = archivedList.filter((x) => x.id !== entry.id);
            if (next.length !== archivedList.length) {
              if (next.length > 0) {
                patch.archivedSessionsByProject = { ...s.archivedSessionsByProject, [entry.projectId]: next };
              } else {
                const copy = { ...s.archivedSessionsByProject };
                delete copy[entry.projectId];
                patch.archivedSessionsByProject = copy;
              }
              touched = true;
            }
          } else if (exists) {
            patch.archivedSessionsByProject = {
              ...s.archivedSessionsByProject,
              [entry.projectId]: archivedList.map((x) => (x.id === entry.id ? { ...x, ...entry } : x)),
            };
            touched = true;
          }
          // else: archived remotely but outside the loaded bin page — the
          // refresh path will pick it up.
        }
        // Cached pre-change row (same id) — the gain/loss probes below
        // compare it against the incoming entry.
        const prevEntry =
          s.sessionsByProject[entry.projectId]?.find((x) => x.id === entry.id) ??
          s.pinnedSessions.find((x) => x.id === entry.id);
        // Worktree-MATERIALIZE flip (gain direction): the entry just GAINED a
        // worktreePath — its first turn created the isolated checkout
        // (the composer-chip path materializes on sendTurn, long after the
        // session was activated, so the activation-time flip never ran). If
        // the materialized row is the ACTIVE session, the project's view
        // must follow it into the fork view and reveal the group —
        // otherwise the freshly materialized thread silently vanishes from
        // the local list the user is looking at.
        if (entry.worktreePath && !prevEntry?.worktreePath && entry.id === s.activeSessionId) {
          if (!s.worktreeViewByProject[entry.projectId]) {
            patch.worktreeViewByProject = {
              ...s.worktreeViewByProject,
              [entry.projectId]: true,
            };
          }
          const gainedKey = normWorktreeKey(entry.worktreePath);
          if (!s.expandedWorktrees[gainedKey]) {
            patch.expandedWorktrees = {
              ...s.expandedWorktrees,
              [gainedKey]: true,
            };
          }
        }
        // Worktree-degenerate view flip: this entry just LOST its
        // worktreePath — its directory was removed and clearWorktreePath
        // degraded it back to local (each referenced session broadcasts its
        // own changed event, so this fires once per row). When the project's
        // LAST worktree-bound row degenerates, fall its left-bar view back
        // to the local list — the fork view would otherwise render an empty
        // "no threads" while every local thread sits hidden in the other
        // view (the "删除工作树后会话不见了" trap).
        if (!entry.worktreePath && prevEntry?.worktreePath) {
          const stillBound =
            (s.sessionsByProject[entry.projectId]?.some(
              (x) => x.id !== entry.id && !!x.worktreePath,
            ) ?? false) ||
            s.pinnedSessions.some(
              (x) => x.id !== entry.id && x.projectId === entry.projectId && !!x.worktreePath,
            );
          if (!stillBound && s.worktreeViewByProject[entry.projectId]) {
            patch.worktreeViewByProject = {
              ...s.worktreeViewByProject,
              [entry.projectId]: false,
            };
            touched = true;
          }
        }
        if (!touched) return {};
        // Keep the derived `sessions` alias (active project's list) fresh.
        if (s.activeProjectId === entry.projectId && patch.sessionsByProject) {
          patch.sessions = patch.sessionsByProject[entry.projectId] ?? s.sessions;
        }
        // Config sync: if the changed row is the ACTIVE session, mirror its
        // model/effort/permissionMode/customModelId/providerId into the
        // composer's global slots — a change made on the OTHER client
        // (phone/desktop via session:updateSettings) takes effect here
        // immediately, matching the local setModel/setEffort/… actions.
        if (entry.id === s.activeSessionId) {
          patch.model = entry.model;
          patch.effort = entry.effort;
          patch.permissionMode = entry.permissionMode;
          patch.customModelId = entry.customModelId;
          patch.providerId = entry.providerId;
        }
        return patch;
      });
      return;
    }
    // session.deleted — a session row was hard-deleted on another client.
    // Same in-memory surgery as the local deleteSession action (tabs, buckets,
    // active-thread fallback all included).
    if (e.type === "session.deleted") {
      set((s) => applySessionDeletedState(s, sid));
      return;
    }
    // request.resolved — a pending approval / question / plan request was
    // answered on ANOTHER client (the main-side Deferred resolves exactly
    // once). Close this client's copy of the dialog: the requestId can no
    // longer be answered. The answering client's own local cleanup already ran
    // when it submitted, so the filter is a no-op there.
    if (e.type === "request.resolved") {
      set((s) => {
        if (e.kind === "approval") {
          const next = s.pendingApprovals.filter((p) => p.requestId !== e.requestId);
          return next.length === s.pendingApprovals.length ? {} : { pendingApprovals: next };
        }
        if (e.kind === "question") {
          const pending = s.pendingQuestionBySession[sid];
          if (!pending || pending.requestId !== e.requestId) return {};
          const bucket = { ...s.pendingQuestionBySession };
          delete bucket[sid];
          return { pendingQuestionBySession: bucket };
        }
        // plan
        const pending = s.pendingPlanApprovalBySession[sid];
        if (!pending || pending.requestId !== e.requestId) return {};
        const bucket = { ...s.pendingPlanApprovalBySession };
        delete bucket[sid];
        return { pendingPlanApprovalBySession: bucket };
      });
      return;
    }
    // plan.update: drives BOTH the activity capsule (planBySession) AND the
    // inline `kind: "plan"` block on the current turn's trailing assistant
    // message. The inline block is what the user actually reads in the
    // message stream — it stays put per-turn (different turns → different
    // plan blocks in history), unlike the old footer card which was a single
    // session-global slot that got overwritten each turn.
    //   phase "drafting" → no card yet: the drafting placeholder arrives with
    //     empty text (EnterPlanMode), and an empty plan card is noise. The
    //     inline block only appears once real plan text exists (ready).
    //   phase "ready"    → live card with 已就绪 badge after ExitPlanMode.
    //   phase "cleared"  → remove the live block (plan mode exited / denied).
    if (e.type === "plan.update") {
      set((s) => {
        const list = s.messagesBySession[sid] ?? EMPTY_MESSAGES;
        const hasApproval = !!s.pendingPlanApprovalBySession[sid];
        const next = upsertLivePlanBlock(list, e.plan, e.phase, hasApproval, s.runningTurnStartedAt[sid] ?? Date.now());
        return {
          planBySession: {
            ...s.planBySession,
            [sid]: { plan: e.plan, phase: e.phase },
          },
          messagesBySession: next === list
            ? s.messagesBySession
            : { ...s.messagesBySession, [sid]: next },
        };
      });
      return;
    }
    // mode.change: the model (or host) flipped the session's effective
    // permission mode mid-turn (e.g. EnterPlanMode / ExitPlanMode after
    // approval). Sync the composer chip for the ACTIVE session so it
    // reflects runtime reality instead of the stale startup mode. Only the
    // active session's chip is updated — other tabs keep their own config.
    // Persist fire-and-forget so a resumed turn starts in the right mode.
    if (e.type === "mode.change") {
      if (sid === get().activeSessionId) {
        set({ permissionMode: e.mode });
        void api.session.updateSettings({ sessionId: sid, permissionMode: e.mode }).catch((err) => {
          console.error("updateSettings(mode.change) failed:", err);
        });
      }
      return;
    }
    // upstream.issue — transient transport trouble on the session's model
    // channel (the OpenAI bridge retrying a connect timeout / reset). No
    // message-stream impact: the hint renders beside the streaming spinner
    // (ChatPane) so a 10s+ stall reads as "网络在重试" instead of a hang.
    // kind "ok" (a retried request went through) and turn-end paths clear it,
    // plus the decay timer above as the safety net.
    if (e.type === "upstream.issue") {
      if (e.kind === "ok") {
        clearUpstreamIssue(set, sid);
        return;
      }
      set((s) => ({
        upstreamIssueBySession: {
          ...s.upstreamIssueBySession,
          [sid]: { cause: e.cause, attempt: e.attempt, attempts: e.attempts },
        },
      }));
      const prev = upstreamIssueDecayTimers.get(sid);
      if (prev) clearTimeout(prev);
      upstreamIssueDecayTimers.set(
        sid,
        setTimeout(() => {
          upstreamIssueDecayTimers.delete(sid);
          clearUpstreamIssue(set, sid);
        }, UPSTREAM_ISSUE_DECAY_MS),
      );
      return;
    }
    // subagent.update: REPLACE semantics — swap the full roster.
    if (e.type === "subagent.update") {
      // If the user has manually interrupted this session, the abort unwinds
      // late subagent.update events (from flushFinal / in-flight
      // flushSubagents) whose roster may still carry `running` backgrounded
      // subagents. Those would resurrect a "killed" subagent and re-lock the
      // composer. Filter any `running` entry down to `killed` so the user's
      // stop intent wins. REPLACE semantics otherwise.
      // Bump unread when a backgrounded subagent just finished (transitioned
      // to completed/failed) - the user asked something to run in the
      // background and it's now done; they'd want to know without watching.
      const prevAgents = get().subagentsBySession[sid] ?? [];
      const prevRunning = new Set(prevAgents.filter((a) => a.status === "running").map((a) => a.taskId));
      const justFinished = e.agents.some(
        (a) => (a.status === "completed" || a.status === "failed") && prevRunning.has(a.taskId),
      );
      if (justFinished) {
        bumpUnread();
        pushToast("info", translate(get().locale, "store.toast.backgroundTaskDone"), translate(get().locale, "store.toast.backgroundTaskDoneBody"));
      }
      set((s) => {
        const agents = s.interruptedBySession[sid]
          ? e.agents.map((a) => (a.status === "running" ? { ...a, status: "killed" as const } : a))
          : e.agents;
        return { subagentsBySession: { ...s.subagentsBySession, [sid]: agents } };
      });
      return;
    }
    // subagent.transcript: REPLACE one subagent's transcript (inner key =
    // the spawning Task tool_use id). Process-lifetime data — no persistence,
    // cleared when the next turn starts (see sendPrompt).
    if (e.type === "subagent.transcript") {
      set((s) => {
        const inner = s.subagentTranscriptsBySession[sid];
        if (inner?.[e.parentToolUseId] === e.blocks) return {};
        return {
          subagentTranscriptsBySession: {
            ...s.subagentTranscriptsBySession,
            [sid]: { ...(inner ?? {}), [e.parentToolUseId]: e.blocks },
          },
        };
      });
      return;
    }
    // token-usage.updated: replace this session's context snapshot. The
    // adapter already normalized everything (usedTokens / maxTokens / pct /
    // warning), so we just store + the chip renders. Main also persists this
    // to the session row, so it round-trips on reload via hydrateContextSnapshot.
    // We also mirror it into the sessionsByProject cache so the next
    // selectSession/openTab's hydrate reads a fresh value instead of the
    // stale snapshot captured at list time (which could be null/invalid and
    // trigger the else-delete branch, hiding the ring until the next event).
    if (e.type === "token-usage.updated") {
      if (!isValidSnapshot(e.snapshot)) return;
      set((s) => {
        const patch: Partial<SessionState> = {
          contextSnapshotBySession: { ...s.contextSnapshotBySession, [sid]: e.snapshot },
        };
        // Keep the in-memory session row cache in sync. Only touch the list
        // entry actually found (no-op if this session isn't in the cache, e.g.
        // archived / not yet loaded).
        const cached = findSession(s.sessionsByProject, s.archivedSessionsByProject, s.pinnedSessions, sid);
        if (cached && cached.contextSnapshot !== e.snapshot) {
          patch.sessionsByProject = patchSessionInCache(
            s.sessionsByProject, cached.projectId, sid, { contextSnapshot: e.snapshot },
          );
          // Pinned rows live in the global pinned bucket, not the per-project
          // list — mirror the snapshot there too.
          const pinnedIdx = s.pinnedSessions.findIndex((x) => x.id === sid);
          if (pinnedIdx !== -1) {
            patch.pinnedSessions = s.pinnedSessions.map((x, i) =>
              i === pinnedIdx ? { ...x, contextSnapshot: e.snapshot } : x,
            );
          }
        }
        return patch;
      });
      return;
    }
    if (e.type === "question.ask") {
      bumpUnread();
      pushToast("warning", translate(get().locale, "store.toast.agentQuestion"), e.questions[0]?.question);
      set((s) => ({
        pendingQuestionBySession: {
          ...s.pendingQuestionBySession,
          [sid]: { questions: e.questions, requestId: e.requestId },
        },
      }));
      return;
    }
    if (e.type === "approval.request") {
      // Mirror the main-side ApprovalBridge queue: head = element 0.
      // De-dup by requestId so a re-emitted event doesn't double-push.
      bumpUnread();
      pushToast("warning", translate(get().locale, "store.toast.toolApprovalNeeded"), e.toolName);
      set((s) => ({
        pendingApprovals: [
          ...s.pendingApprovals.filter((p) => p.requestId !== e.requestId),
          e,
        ],
      }));
      return;
    }
    if (e.type === "plan.approval_request") {
      // ExitPlanMode: the model drafted a plan and is awaiting the user's
      // approve/reject decision. One-at-a-time per session (the model calls
      // ExitPlanMode once per plan). REPLACE so a re-emit doesn't stack.
      // Also refresh the inline plan block's hasApproval flag -> true so its
      // badge flips to 待审阅, mirroring the composer approval sheet.
      bumpUnread();
      pushToast("warning", translate(get().locale, "store.toast.planApprovalPending"), translate(get().locale, "store.toast.planApprovalPendingBody"));
      set((s) => {
        const list = s.messagesBySession[sid] ?? EMPTY_MESSAGES;
        // The plan text on the approval request is the model's ExitPlanMode
        // payload — re-sync the inline block so it shows exactly what the
        // user is being asked to approve (phase stays "ready" per the prior
        // plan.update emitted by the adapter on ExitPlanMode).
        const next = upsertLivePlanBlock(list, e.plan, "ready", true, s.runningTurnStartedAt[sid] ?? Date.now());
        return {
          pendingPlanApprovalBySession: {
            ...s.pendingPlanApprovalBySession,
            [sid]: e,
          },
          messagesBySession: next === list
            ? s.messagesBySession
            : { ...s.messagesBySession, [sid]: next },
        };
      });
      return;
    }
    if (e.type === "turn.files") {
      // Drives TWO things:
      //  1. turnFilesBySession[sid] — the in-memory mirror of the LATEST
      //     turn's files (used by rewindTurn's empty-check + the Write-diff
      //     beforeMap until the block freezes). Kept as a single slot since
      //     only the latest turn is rewindable.
      //  2. A `kind: "turn-files"` block on the current turn's trailing
      //     assistant message — the per-turn card the user actually sees in
      //     the stream. Frozen in place at turn.done, persisted via the
      //     blocks round-trip, so every turn keeps its own card in history.
      set((s) => {
        const list = s.messagesBySession[sid] ?? EMPTY_MESSAGES;
        const next = upsertLiveTurnFilesBlock(list, e.files);
        return {
          turnFilesBySession: { ...s.turnFilesBySession, [sid]: e.files },
          messagesBySession: next === list
            ? s.messagesBySession
            : { ...s.messagesBySession, [sid]: next },
        };
      });
      // turn.files is emitted from flushFinal(), which runs AFTER the `result`
      // message already emitted turn.done. So the saveMessages fired at turn.done
      // captured a snapshot WITHOUT this card. Persist just the changed message
      // now (the card is attached to the just-closed turn's trailing assistant
      // message) so it survives restart - otherwise reopening the session loses
      // every turn's modified-files card. IPC ordering preserves "last write
      // wins" since this call lands after the turn.done one.
      //
      // Incremental upsert: only the trailing assistant message gained a block,
      // so we only need to write that one row instead of the whole session.
      {
        const list = get().messagesBySession[sid];
        if (list && list.length > 0) {
          const last = list[list.length - 1];
          void api.session.upsertMessages({ sessionId: sid, messages: toRecords(sid, [last]) });
        }
      }
      return;
    }
    if (e.type === "compact.result") {
      // A context compaction completed (manual /compact or auto-compact).
      // Push a compact-summary block onto the current turn's trailing
      // assistant message so the user sees what happened in the stream.
      set((s) => {
        const list = s.messagesBySession[sid] ?? EMPTY_MESSAGES;
        const block: Block = {
          kind: "compact-summary",
          trigger: e.trigger,
          preTokens: e.preTokens,
          postTokens: e.postTokens,
          durationMs: e.durationMs,
        };
        // Use the send-time anchor (stamped in sendPrompt) so the compact
        // card's turnMeta continues the synthesized pendingTurn row's timing
        // seamlessly - same pattern as tool.use / text.delta. Falls back to
        // now if the anchor is missing (resumed/legacy turn).
        const startedAt = s.runningTurnStartedAt[sid] ?? Date.now();
        const next = appendCompactSummaryBlock(list, block, startedAt);
        return next === list
          ? s
          : { messagesBySession: { ...s.messagesBySession, [sid]: next } };
      });
      // Persist so the card survives reload. Incremental upsert: only the
      // trailing assistant message (or a freshly-appended turn opener) changed.
      {
        const list = get().messagesBySession[sid];
        if (list && list.length > 0) {
          const last = list[list.length - 1];
          void api.session.upsertMessages({ sessionId: sid, messages: toRecords(sid, [last]) });
        }
      }
      return;
    }
    if (e.type === "turn.rewound") {
      // Unified rewind handling: mark the matching `turn-files` card
      // `rewound: true` IN PLACE and NEVER remove it — the card stays in
      // the stream as a visible trace that this turn was rolled back
      // (mirroring SDK checkpoint semantics: file rollback never rolls
      // back the conversation). The card matches by path-set equality
      // against `e.targetFiles` (the requested paths, before failures).
      //
      // The only difference between a latest-turn and a historical rewind
      // is the latest-turn BUCKET (turnFilesBySession): when the marked
      // card is the live one (isLatestTurn), the bucket is cleared so
      // downstream consumers (file-tree dots, diff sources) stop treating
      // those files as "this turn's changes". Historical cards leave the
      // bucket alone — it belongs to a different, later turn.
      let rewoundLatest = false;
      const rewoundChanged: ChatMessage[] = [];
      set((s) => {
        const list = s.messagesBySession[sid] ?? EMPTY_MESSAGES;
        const targetSet = new Set(e.targetFiles);
        let changed = false;
        const next = list.map((m) => {
          let touched = false;
          const blocks = m.blocks.map((b) => {
            if (
              b.kind === "turn-files" &&
              !b.rewound &&
              b.files.length === targetSet.size &&
              b.files.every((f) => targetSet.has(f.filePath))
            ) {
              touched = true;
              if (b.isLatestTurn) rewoundLatest = true;
              return { ...b, rewound: true };
            }
            return b;
          });
          if (!touched) return m;
          changed = true;
          const updated = { ...m, blocks };
          rewoundChanged.push(updated);
          return updated;
        });
        if (!changed) return s;
        // If the rewound card was the live one, also clear the latest-turn
        // bucket (its files are back on disk — no longer "this turn's").
        return rewoundLatest
          ? {
              messagesBySession: { ...s.messagesBySession, [sid]: next },
              turnFilesBySession: { ...s.turnFilesBySession, [sid]: [] },
            }
          : { messagesBySession: { ...s.messagesBySession, [sid]: next } };
      });
      // Persist the rewound state so the marker survives session reopen.
      // (The card is kept, so this is a mutation, not a removal.) Incremental
      // upsert: only the rows whose blocks actually changed need writing.
      if (rewoundChanged.length > 0) {
        void api.session.upsertMessages({ sessionId: sid, messages: toRecords(sid, rewoundChanged) });
      }
      return;
    }

    set((s) => {
      const list = s.messagesBySession[sid] ?? [];
      let next: ChatMessage[] = list;

      switch (e.type) {
        case "text.delta": {
          // Buffer the delta — flushDeltas will apply accumulated text in a
          // single rAF-bound setState, collapsing many single-char deltas into
          // one React update per frame (~60 Hz instead of per-char).
          const key = `${sid}:${e.messageId}`;
          const existing = deltaBuf.get(key);
          if (existing) {
            existing.text += e.text;
          } else {
            deltaBuf.set(key, { sessionId: sid, messageId: e.messageId, text: e.text, thinking: "" });
          }
          scheduleDeltaFlush();
          // Don't add to `next` — flushDeltas mutates the store directly.
          break;
        }
        case "thinking": {
          const key = `${sid}:${e.messageId}`;
          const existing = deltaBuf.get(key);
          if (existing) {
            existing.thinking += e.text;
          } else {
            deltaBuf.set(key, { sessionId: sid, messageId: e.messageId, text: "", thinking: e.text });
          }
          scheduleDeltaFlush();
          break;
        }
        case "tool.use": {
          // messageId path: the event carries the owning message (pi: the
          // PiMessageAdapter forwards the narration messageId snapshot at
          // toolcall_start; claude: the SdkMessageAdapter reuses the
          // preceding text/thinking block's messageId). The narration text
          // was already flushed to that message (forceDeltaFlush above), so
          // append the tool directly to it. This keeps the interleaved
          // "text → tool → text → tool" timeline intact; without it every
          // tool would pile onto the turn's opener via the heuristic below.
          const targetIdx = e.messageId ? next.findIndex((m) => m.id === e.messageId) : -1;
          if (targetIdx >= 0) {
            const block: Block = { kind: "tool_use", toolCallId: e.toolCallId, toolName: e.toolName, input: e.input, status: "running" };
            const updated = { ...next[targetIdx], blocks: [...next[targetIdx].blocks, block] };
            next = next.map((m, i) => (i === targetIdx ? updated : m));
            break;
          }
          // Fallback (no usable messageId — e.g. a tool block with no
          // preceding text/thinking in the same assistant message, or a
          // legacy event): target the open turn's chronologically-LAST
          // assistant message (findOpenTurnLastAssistant — NOT the opener,
          // and NOT a naive "last assistant message": appending to the opener
          // would place this tool BEFORE narration messages that already
          // streamed, corrupting the arrival-order timeline the completed-
          // turn process/reply split relies on; a naive last-assistant scan
          // would, after an edit-resend / history truncation, hit a CLOSED
          // turn's message and merge two turns into one giant panel).
          const openIdx = findOpenTurnLastAssistant(next);
          let lastAssistant = openIdx >= 0 ? next[openIdx] : undefined;
          if (!lastAssistant) {
            // No open-turn assistant message exists — this tool_use starts a
            // fresh turn. Stamp turnMeta so the renderer shows the per-turn
            // stat row above this message. Past turns' messages still carry
            // their (now-ended) turnMeta, so we checked endedAt above, not
            // just presence.
            const isNewTurn = !next.some(
              (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
            );
            // Prefer the send-time anchor (stamped in sendPrompt) so the real
            // turnMeta continues the synthesized pendingTurn row's timing
            // seamlessly - otherwise the duration would jump. Falls back to
            // now if the anchor is missing (resumed/legacy turn).
            const startedAt = (isNewTurn && s.runningTurnStartedAt[sid]) || Date.now();
            lastAssistant = {
              id: `a_${Date.now()}`,
              sessionId: sid,
              role: "assistant",
              blocks: [],
              createdAt: Date.now(),
              ...(isNewTurn ? { turnMeta: { startedAt } } : {}),
            };
            next = [...next, lastAssistant];
            // A new turn opened (no prior open-turn assistant message) — demote
            // any previous latest turn-files card to read-only.
            if (isNewTurn) next = demotePreviousLatestTurnFiles(next);
          }
          const block: Block = { kind: "tool_use", toolCallId: e.toolCallId, toolName: e.toolName, input: e.input, status: "running" };
          const updated = { ...lastAssistant, blocks: [...lastAssistant.blocks, block] };
          next = next.map((m) => (m.id === lastAssistant!.id ? updated : m));
          break;
        }
        case "tool.result": {
          next = next.map((m) => {
            const hasBlock = m.blocks.some((b) => b.kind === "tool_use" && b.toolCallId === e.toolCallId);
            if (!hasBlock) return m;
            // If the result carries image(s) (e.g. a Claude-path screenshot),
            // attach inline image blocks right after the tool_use card. A single
            // result may carry multiple images. Skip images already present for
            // this toolCallId (the Pi path may have added some via browser.image
            // events) — match by data to dedupe, not by mere existence.
            const imgs = extractImagesFromToolResult(e.content);
            const blocks: Block[] = m.blocks.map((b) => {
              if (b.kind === "tool_use" && b.toolCallId === e.toolCallId) {
                return { ...b, status: e.isError ? "error" : "done", result: e.content };
              }
              return b;
            });
            if (imgs.length > 0) {
              const tuIdx = blocks.findIndex((b) => b.kind === "tool_use" && b.toolCallId === e.toolCallId);
              const existing = new Set(
                blocks.filter((b) => b.kind === "image").map((b) => (b as { data: string }).data),
              );
              const toAdd: Block[] = [];
              for (const img of imgs) {
                if (!existing.has(img.data)) {
                  toAdd.push({ kind: "image", toolCallId: e.toolCallId, data: img.data, mimeType: img.mimeType });
                }
              }
              if (toAdd.length > 0) blocks.splice(tuIdx + 1, 0, ...toAdd);
            }
            return { ...m, blocks };
          });
          break;
        }
        case "browser.image": {
          // Pi path: the provider emits this when browser_screenshot runs.
          // Attach an inline image block right after the tool_use card,
          // deduped by toolCallId (an earlier tool.result may have already
          // extracted the image from the result content).
          next = next.map((m) => {
            const tuIdx = m.blocks.findIndex((b) => b.kind === "tool_use" && b.toolCallId === e.toolCallId);
            if (tuIdx < 0) return m;
            const hasImage = m.blocks.some((b) => b.kind === "image" && b.toolCallId === e.toolCallId);
            if (hasImage) return m;
            const imageBlock = { kind: "image" as const, toolCallId: e.toolCallId, data: e.data, mimeType: e.mimeType };
            const blocks = [...m.blocks];
            blocks.splice(tuIdx + 1, 0, imageBlock);
            return { ...m, blocks };
          });
          break;
        }
        case "turn.incomplete": {
          // Gateway-truncated turn (empty final response). The adapter emits
          // this immediately BEFORE turn.done — append the warning card and
          // toast here, and flag the session so the turn.done case skips its
          // misleading "回合完成" toast/unread bump (already done here).
          next = [
            ...next,
            {
              id: `ti_${Date.now()}`,
              sessionId: sid,
              role: "assistant",
              blocks: [
                {
                  kind: "turn-incomplete",
                  incompleteKind: e.kind,
                  pendingToolNames: e.pendingToolCalls.map((c) => c.toolName),
                },
              ],
              createdAt: Date.now(),
            },
          ];
          bumpUnread();
          pushToast(
            "warning",
            translate(get().locale, "store.toast.turnIncomplete"),
            translate(
              get().locale,
              e.kind === "empty-response"
                ? "chatStream.turnIncomplete.emptyDesc"
                : "chatStream.turnIncomplete.danglingDesc",
            ),
          );
          set((s) => ({ turnIncompleteBySession: { ...s.turnIncompleteBySession, [sid]: true } }));
          break;
        }
        case "error": {
          next = [...next, { id: `err_${Date.now()}`, sessionId: sid, role: "assistant", blocks: [{ kind: "error", message: e.message }], createdAt: Date.now() }];
          // An error terminates the turn just like turn.done - stamp the
          // end time so the duration row freezes.
          const errEndedAt = Date.now();
          next = next.map((m) =>
            m.turnMeta && m.turnMeta.endedAt === undefined
              ? { ...m, turnMeta: { ...m.turnMeta, endedAt: errEndedAt } }
              : m,
          );
          bumpUnread();
          pushToast("error", translate(get().locale, "store.toast.errorOccurred"), e.message);
          set((s) => {
            const runningTurnStartedAt = { ...s.runningTurnStartedAt };
            delete runningTurnStartedAt[sid];
            return {
              runningBySession: { ...s.runningBySession, [sid]: false },
              runningTurnStartedAt,
              // Only drop approvals + files belonging to this session; the
              // head pendingApprovals is per-session already, but it's a
              // flat array - filter down to the affected one.
              pendingApprovals: s.pendingApprovals.filter((p) => p.sessionId !== sid),
              turnFilesBySession: { ...s.turnFilesBySession, [sid]: [] },
            };
          });
          // Turn over — any live upstream-retry hint is stale (a later retry
          // re-arms it for the next turn).
          clearUpstreamIssue(set, sid);
          break;
        }
        case "turn.done": {
          // A turn.incomplete arrived just before this turn.done — the work
          // did NOT finish (gateway returned an empty final response) and its
          // own case already toasted a warning + bumped unread. Consume the
          // flag so we don't ALSO toast "回合完成" on a truncated turn.
          const turnIncomplete = !!get().turnIncompleteBySession[sid];
          if (turnIncomplete) {
            set((s) => {
              const turnIncompleteBySession = { ...s.turnIncompleteBySession };
              delete turnIncompleteBySession[sid];
              return { turnIncompleteBySession };
            });
          }
          // Bump unread for non-active sessions on turn completion - the
          // result is ready and the user may have switched away. Skipped for
          // interrupted turns (the user initiated the stop, no surprise),
          // for tool_use turns (the adapter will resume streaming shortly;
          // the intermediate result is not a "done" signal), and for
          // incomplete turns (see above).
          if (e.reason !== "interrupted" && e.reason !== "tool_use" && !turnIncomplete) {
            bumpUnread();
            pushToast("info", translate(get().locale, "store.toast.turnComplete"), translate(get().locale, "store.toast.turnCompleteBody"));
          }
          // Close out any tool_use still "running": the turn ended without a
          // matching tool.result (plan mode, or interrupted).
          next = next.map((m) => ({
            ...m,
            blocks: m.blocks.map((b) =>
              b.kind === "tool_use" && b.status === "running"
                ? { ...b, status: "done" as const, result: b.result ?? "(no result — turn ended)" }
                : b,
            ),
          }));
          // Stamp the turn's end time on its first assistant message so
          // the per-turn "工作时长" stat row freezes (stops ticking live).
          const endedAt = Date.now();
          next = next.map((m) =>
            m.turnMeta && m.turnMeta.endedAt === undefined
              ? { ...m, turnMeta: { ...m.turnMeta, endedAt } }
              : m,
          );
          // Freeze or prune the inline plan block(s) on this just-closed turn.
          // An approved plan (phase "ready" + non-empty text) stays as a frozen
          // historical card in the stream; drafting / cleared / empty plans are
          // removed (they represent an in-progress or rejected draft). A plan-
          // only assistant message that prunes to empty is dropped entirely.
          // Keyed off endedAt so we touch only THIS turn's messages.
          next = freezeOrPrunePlanBlocks(next, endedAt);
          // Finalize the just-closed turn's turn-files block: mark it
          // isLatestTurn=true (it's now the latest rewindable turn) and demote
          // every earlier turn's card to read-only. turn-files blocks are
          // never pruned — each turn that touched files keeps its card in
          // history. Keyed off endedAt so only THIS turn's messages are
          // promoted; older turns get demoted by demotePreviousLatestTurnFiles.
          next = freezeLatestTurnFilesBlock(next, endedAt);
          // Any pending approvals are stale: the turn ended, the SDK won't
          // be waiting on them anymore. Drop the queue for this session so
          // a stale card doesn't linger in another tab's composer.
          // turnFilesBySession is NOT cleared here — the `turn.files` event
          // already arrived (immediately before turn.done via flushFinal)
          // and populated it. Clearing here would race with that and could
          // wipe the file list mid-event. The `turn.rewound` event is
          // what clears it on user rewind.
          //
          // Activity-capsule state (plan draft, subagent roster) is also
          // wiped here. The adapter normally emits `plan.update phase:cleared`
          // and final `subagent.update` events before turn.done, so this
          // is a defensive net for turns where neither was active (e.g.
          // a pure Q&A turn that never spawned anything). Either way, the
          // next turn starts with a clean capsule.
          set((s) => {
            const { [sid]: _dropPlan, ...restPlanApprovals } = s.pendingPlanApprovalBySession;
            // If any subagent is still `running` (typically a backgrounded task
            // whose lifecycle outlives this turn's stream), KEEP the roster so
            // the renderer can keep the composer locked + show the task as
            // in-progress. Only clear when nothing is running (the normal
            // case - foreground tasks were force-completed by the adapter).
            // EXCEPTION: a user-interrupted session (sentinel set by
            // interrupt()) must NOT keep a running roster - the abort's late
            // subagent.update can leave a backgrounded subagent "running" and
            // re-lock the composer after the user explicitly stopped. Clear it.
            const curAgents = s.subagentsBySession[sid] ?? [];
            const interrupted = !!s.interruptedBySession[sid];
            const hasRunning = !interrupted && curAgents.some((a) => a.status === "running");
            // Append a finalized usage record for this turn (for the activity
            // capsule's consumption history). Derive the turn's start from the
            // first assistant message still carrying this turn's turnMeta.
            const snap = s.contextSnapshotBySession[sid];
            const turnStart =
              next.find((m) => m.turnMeta && m.turnMeta.endedAt === endedAt)?.turnMeta?.startedAt ??
              endedAt;
            const prevHistory = s.usageHistoryBySession[sid] ?? [];
            const history =
              snap != null
                ? [
                    ...prevHistory,
                    {
                      endedAt,
                      durationMs: Math.max(0, endedAt - turnStart),
                      totalProcessedTokens: snap.totalProcessedTokens,
                      outputTokens: snap.outputTokens,
                      cacheReadTokens: snap.cacheReadTokens ?? 0,
                      cacheCreationTokens: snap.cacheCreationTokens ?? 0,
                      costUsd: snap.costUsd,
                      usedTokens: snap.usedTokens,
                      model: snap.model,
                    } satisfies TurnUsageRecord,
                  ]
                : prevHistory;
            // Mirror the appended record into the session row cache — same
            // rationale as the contextSnapshot mirror in token-usage.updated:
            // hydrateUsageHistory re-reads the ROW on every selectSession /
            // openTab, and the row as loaded predates this turn. Without the
            // mirror, switching away and back replaces the bucket with the
            // stale row value, wiping this turn's record until the next full
            // list reload (turns panel shows 无用量记录).
            let rowsUsagePatch: Partial<SessionState> | null = null;
            if (history !== prevHistory) {
              const cached = findSession(
                s.sessionsByProject, s.archivedSessionsByProject, s.pinnedSessions, sid,
              );
              if (cached && cached.usageHistory !== history) {
                rowsUsagePatch = {
                  sessionsByProject: patchSessionInCache(
                    s.sessionsByProject, cached.projectId, sid, { usageHistory: history },
                  ),
                };
                const pinnedIdx = s.pinnedSessions.findIndex((x) => x.id === sid);
                if (pinnedIdx !== -1) {
                  rowsUsagePatch.pinnedSessions = s.pinnedSessions.map((x, i) =>
                    i === pinnedIdx ? { ...x, usageHistory: history } : x,
                  );
                }
              }
            }
            return {
              runningBySession: { ...s.runningBySession, [sid]: false },
              // Turn closed - drop the send-time anchor so the synthesized
              // pendingTurn row stops rendering (it keys off isRunning, but
              // clearing this is belt-and-suspenders and keeps the slice tidy
              // for the next turn).
              runningTurnStartedAt: (() => {
                const m = { ...s.runningTurnStartedAt };
                delete m[sid];
                return m;
              })(),
              pendingApprovals: s.pendingApprovals.filter((p) => p.sessionId !== sid),
              pendingPlanApprovalBySession: restPlanApprovals,
              // Keep the plan card visible when the plan was APPROVED (phase
              // "ready" with non-empty text) so it persists in the message
              // stream after the turn ends and across thread reopen. Clear
              // drafting / empty / cleared plans — those represent an
              // unapproved draft or the absence of a plan.
              planBySession: {
                ...s.planBySession,
                [sid]: (s.planBySession[sid]?.phase === "ready" && s.planBySession[sid]?.plan)
                  ? s.planBySession[sid]
                  : { plan: "", phase: "cleared" },
              },
              subagentsBySession: hasRunning
                ? s.subagentsBySession
                : { ...s.subagentsBySession, [sid]: [] },
              usageHistoryBySession: { ...s.usageHistoryBySession, [sid]: history },
              ...(rowsUsagePatch ?? {}),
            };
          });
          // Turn closed — drop any live upstream-retry hint (the channel may
          // still flap next turn, which re-arms it).
          clearUpstreamIssue(set, sid);
          break;
        }
        default:
          break;
      }

      return { messagesBySession: { ...s.messagesBySession, [sid]: next } };
    });

    // At terminal events the snapshot is final — persist it so the history
    // survives restart. Fire-and-forget; don't block the UI.
    //
    // Incremental upsert: only this turn's messages changed (the send-time
    // user message + every assistant message produced this turn). Persisting
    // just those rows avoids the O(N) DELETE+re-INSERT of a full snapshot on
    // every turn — the cost is O(this turn) regardless of session length.
    if (e.type === "turn.done" || e.type === "error") {
      const snapshot = get().messagesBySession[sid];
      if (snapshot) {
        // Identify this turn's messages by the captured send-time anchor.
        // Falls back to full saveMessages when the anchor is missing (e.g. a
        // turn done arrived for a session we never started, or resumed mid-
        // turn) — preserving the old robustness.
        const tail =
          turnStartAtCapture != null
            ? snapshot.filter(
                (m) => m.createdAt >= turnStartAtCapture || m.turnMeta?.startedAt === turnStartAtCapture,
              )
            : snapshot;
        const toSave = tail.length > 0 ? tail : snapshot;
        void api.session.upsertMessages({ sessionId: sid, messages: toRecords(sid, toSave) });
      }
      // The session may have just gone fully idle — if the user queued a
      // prompt while busy, fire the head now. drainPromptQueueIfIdle is a
      // no-op when still busy (e.g. backgrounded subagents still running) or
      // when the queue is empty.
      get().drainPromptQueueIfIdle(sid);
    }
  },

  setSettingsOpen: (open, section) =>
    set(open ? { settingsOpen: true, settingsSection: section ?? null } : { settingsOpen: false, settingsSection: null }),

  setModelConfigPromptOpen: (open) => set({ modelConfigPromptOpen: open }),

  setWindowFocused: (focused) => {
    set({ isWindowFocused: focused });
    // When the window regains focus, the active session is by definition
    // "seen" - clear its unread badge so the dot doesn't linger after the
    // user returns. Non-active sessions keep their badges (the user hasn't
    // looked at those yet).
    if (focused) {
      const activeId = get().activeSessionId;
      if (activeId && get().unreadBySession[activeId]) {
        set((s) => {
          const unreadBySession = { ...s.unreadBySession };
          delete unreadBySession[activeId];
          return { unreadBySession };
        });
      }
    }
  },

  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setSearchDialogOpen: (open) => set({ searchDialogOpen: open }),
  setLeftOpen: (open) => {
    // While wide-panel (3:7) mode is on the left sidebar must stay closed —
    // guard in the store so no caller/command can open it.
    if (open && get().widePanelOpen) return;
    set({ leftOpen: open });
  },
  setRightOpen: (open) => set({ rightOpen: open }),
  setBottomTerminalOpen: (open) => set({ bottomTerminalOpen: open }),
  setBrowserPanelOpen: (open) => {
    // Opening the fullscreen overlay forces the right panel closed so the
    // embedded sidebar browser unmounts — the two containers must never be
    // active at once (they'd fight over the shared WebContentsView). Closing
    // the overlay leaves rightOpen as-is (the user can reopen the panel).
    if (open) {
      set({ browserPanelOpen: true, rightOpen: false });
    } else {
      set({ browserPanelOpen: false });
    }
  },
  setWidePanelOpen: (open) => {
    const s = get();
    if (open === s.widePanelOpen) return;
    if (open) {
      // Enter wide mode: snapshot the pre-enter layout so exit can restore it,
      // hide the left sidebar and close any browser overlay (it would cover the
      // wide layout). rightPanelTab is left untouched — the right 8/10 keeps
      // whatever tab is already active.
      set({
        widePanelSnapshot: {
          leftOpen: s.leftOpen,
          rightOpen: s.rightOpen,
          rightWidth: s.rightWidth,
        },
        widePanelOpen: true,
        leftOpen: false,
        // The right panel is the mode's centerpiece — always show it on enter.
        // (The titlebar right-panel toggle then hides/shows it during the
        // mode; exit still restores the pre-enter rightOpen from the snapshot.)
        rightOpen: true,
        browserPanelOpen: false,
      });
    } else {
      const snap = s.widePanelSnapshot;
      set({
        widePanelOpen: false,
        widePanelSnapshot: null,
        leftOpen: snap?.leftOpen ?? true,
        rightOpen: snap?.rightOpen ?? true,
        rightWidth: snap?.rightWidth ?? s.rightWidth,
      });
    }
  },
  setBrowserTabCount: (count) => set({ browserTabCount: Math.max(0, count) }),
  setBrowserDeviceToolbarOpen: (open) => set({ browserDeviceToolbarOpen: open }),
  suppressBrowserView: (suppressed) =>
    set((s) => ({ browserViewSuppressed: Math.max(0, s.browserViewSuppressed + (suppressed ? 1 : -1)) })),
  setBrowserTabs: (tabs) => set({ browserTabs: tabs }),
  setBrowserActiveTabId: (id) => set({ browserActiveTabId: id }),
  addBrowserTab: (tab) => set((s) => ({ browserTabs: [...s.browserTabs, tab] })),
  removeBrowserTab: (id) =>
    set((s) => ({ browserTabs: s.browserTabs.filter((t) => t.id !== id) })),
  patchBrowserTab: (browserId, patch) =>
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => (t.browserId === browserId ? { ...t, ...patch } : t)),
    })),
  openUrlInBrowser: (url) => {
    // Reveal the browser sidebar + stage the URL. BrowserPanel opens it in a
    // NEW tab: when tabs already exist it creates one for the URL; when none
    // exist (panel first opened) the first-tab effect loads it into the
    // initial tab. Goes through setRightPanelTab so the first-open panel-width
    // fit (iPhone 14 Pro) applies here too.
    get().setRightPanelTab("browser");
    set({ rightOpen: true, pendingBrowserUrl: url });
  },
  adoptAgentBrowserTab: (browserId, info) => {
    const s = get();
    const existing = s.browserTabs.find((t) => t.browserId === browserId);
    if (existing) {
      // Already adopted — refresh url/title ONLY and activate it. We must NOT
      // overwrite device/orientation/customWidth/customHeight: the user may have
      // manually selected a device preset or custom size, and an agent
      // navigation (which defaults device to "desktop") must never clobber that
      // selection. Chromium device emulation also persists across navigations,
      // so the main process keeps the user's emulation without re-applying.
      if (info.url || info.title) {
        set({
          browserTabs: s.browserTabs.map((t) =>
            t.browserId === browserId
              ? {
                  ...t,
                  ...(typeof info.url === "string" ? { url: info.url } : {}),
                  ...(typeof info.title === "string" ? { title: info.title } : {}),
                }
              : t,
          ),
        });
      }
      if (s.browserActiveTabId !== existing.id) set({ browserActiveTabId: existing.id });
      return false;
    }
    // Register a new tab for the agent-created view. device comes from the
    // agent's navigate call (default desktop = no emulation, full viewport).
    const tab: BrowserTab = {
      id: `agent-${browserId}`,
      browserId,
      url: info.url ?? "",
      title: info.title ?? "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      pickMode: false,
      device: info.device ?? "desktop",
      orientation: info.orientation,
    };
    set({ browserTabs: [...s.browserTabs, tab], browserActiveTabId: tab.id });
    return true;
  },

  // ── Draggable pane sizes ──
  // adjust* apply an incremental delta (from the drag handle) to the current
  // value, clamp, and set synchronously (instant UI). The DB write is
  // debounced so a drag (many mousemove events) only hits the settings table
  // once after the user stops. reset* restore the defaults (double-click).
  adjustLeftWidthPct: (deltaPct) => {
    // The divider sits to the RIGHT of the sidebar, so dragging it right
    // (delta>0) widens the sidebar — no sign flip (unlike the right-bar /
    // bottom-terminal dividers). delta is already in percentage points; the
    // caller converted px via the container width.
    const next = clampLeftWidthPct(get().leftWidthPct + deltaPct);
    set({ leftWidthPct: next });
    schedulePaneWidthPersist(get);
  },
  adjustRightWidth: (deltaPx) => {
    const next = clampRightWidth(get().rightWidth - deltaPx);
    set({ rightWidth: next });
    schedulePaneWidthPersist(get);
  },
  adjustBottomTerminalHeight: (deltaPx) => {
    // Divider sits on TOP of the terminal. Dragging the handle DOWN (delta>0)
    // pushes it toward the terminal, so the terminal SHRINKS — same sign flip
    // as the right-bar divider. Drag UP (delta<0) to grow it.
    const next = clampBottomTerminalHeight(get().bottomTerminalHeight - deltaPx);
    set({ bottomTerminalHeight: next });
    schedulePaneWidthPersist(get);
  },
  adjustEditorWidthPct: (deltaPx) => {
    // The divider sits to the LEFT of the editor column. Dragging it RIGHT
    // (delta>0) should move the divider rightward, which SHRINKS the editor
    // (the pane on the right of the handle) — same sign flip as the right-bar
    // and bottom-terminal dividers. Without the flip the divider moved
    // opposite to the cursor (drag left → editor shrank → handle appeared to
    // jump right).
    const next = clampEditorWidthPct(get().editorWidthPct - deltaPx);
    set({ editorWidthPct: next });
    schedulePaneWidthPersist(get);
  },
  resetLeftWidthPct: () => {
    set({ leftWidthPct: LEFT_WIDTH_PCT_DEFAULT });
    schedulePaneWidthPersist(get);
  },
  resetRightWidth: () => {
    set({ rightWidth: 360 });
    schedulePaneWidthPersist(get);
  },
  resetBottomTerminalHeight: () => {
    set({ bottomTerminalHeight: 280 });
    schedulePaneWidthPersist(get);
  },
  resetEditorWidthPct: () => {
    set({ editorWidthPct: 50 });
    schedulePaneWidthPersist(get);
  },
  adjustWidePanelPct: (deltaPx) => {
    // Divider sits LEFT of the right panel in the wide-panel split, so a drag
    // right (delta>0) shrinks the right pane — same sign flip as the editor
    // divider. In-memory only (no schedulePaneWidthPersist).
    set({ widePanelPct: clampWidePanelPct(get().widePanelPct - deltaPx) });
  },
  resetWidePanelPct: () => {
    set({ widePanelPct: WIDE_PANEL_PCT_DEFAULT });
  },

  /** Update the center-pane display mode. The local store flips
   *  immediately so the layout change is instant; the DB write is
   *  fire-and-forget so a failed write doesn't block the UI. On the
   *  next app start, `init` re-hydrates from the `settings` table. */
  setDisplayMode: async (mode) => {
    set({ displayMode: mode });
    try {
      await api.setting.set({ key: DISPLAY_MODE_SETTING_KEY, value: mode });
    } catch (err) {
      console.error("setting.set(displayMode) failed:", err);
    }
  },

  /** Direct focus switch for the unified center tab bar (tabs displayMode).
   *  See the `centerTabFocus` field doc — natural actions flip it too. */
  setCenterTabFocus: (focus) => {
    set({ centerTabFocus: focus });
  },

  /** Update the UI language. Same immediate-flip + fire-and-forget-persist
   *  pattern as setDisplayMode. Also mirrors the choice onto
   *  <html lang> so assistive tech + font selection follow the UI language. */
  setLocale: async (locale) => {
    set({ locale });
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
    try {
      await api.setting.set({ key: UI_LOCALE_SETTING_KEY, value: locale });
    } catch (err) {
      console.error("setting.set(locale) failed:", err);
    }
  },

  /** Update the session auto-archive rules. Same immediate-flip +
   *  fire-and-forget-persist pattern as setDisplayMode; the main-process
   *  AutoArchiver re-reads the key on its next tick. */
  setAutoArchiveConfig: async (config) => {
    set({ autoArchiveConfig: config });
    try {
      await api.setting.set({ key: AUTO_ARCHIVE_SETTING_KEY, value: JSON.stringify(config) });
    } catch (err) {
      console.error("setting.set(autoArchive) failed:", err);
    }
  },

  /** Update the chat density. Same immediate-flip + fire-and-forget-persist
   *  pattern as setDisplayMode; the CSS vars are re-applied reactively by
   *  useChatAppearance subscribing to `chatDensity`. */
  setChatDensity: async (mode) => {
    set({ chatDensity: mode });
    try {
      await api.setting.set({ key: UI_CHAT_DENSITY_SETTING_KEY, value: mode });
    } catch (err) {
      console.error("setting.set(chatDensity) failed:", err);
    }
  },

  /** Toggle the left-bar project view between flat and grouped. Same
   *  immediate-flip + fire-and-forget-persist pattern as setDisplayMode. */
  setProjectView: async (mode) => {
    set({ projectView: mode });
    try {
      await api.setting.set({ key: UI_PROJECT_VIEW_SETTING_KEY, value: mode });
    } catch (err) {
      console.error("setting.set(projectView) failed:", err);
    }
  },

  /** Write the current groupMeta to the settings blob (fire-and-forget). */
  persistGroupMeta: (meta) => {
    try {
      void api.setting.set({
        key: UI_PROJECT_GROUPS_SETTING_KEY,
        value: JSON.stringify(meta),
      });
    } catch (err) {
      console.error("setting.set(projectGroups) failed:", err);
    }
  },

  /** Set a group's color. `rgb` is a "R G B" triplet or null (default). */
  setGroupColor: (name, rgb) => {
    const meta = get().groupMeta;
    const next: ProjectGroupsMeta = {
      ...meta,
      [name]: { ...meta[name], color: rgb },
    };
    set({ groupMeta: next });
    get().persistGroupMeta(next);
  },

  /** Persist a new group order. `orderedNames` is the full group-name list in
   *  the desired order; index becomes each group's `order`. */
  setGroupOrder: (orderedNames) => {
    const meta = get().groupMeta;
    const next: ProjectGroupsMeta = { ...meta };
    orderedNames.forEach((name, i) => {
      next[name] = { ...next[name], order: i };
    });
    set({ groupMeta: next });
    get().persistGroupMeta(next);
  },

  /** Migrate a group's metadata when it's renamed (color + order follow). */
  renameGroupMeta: (oldName, newName) => {
    const meta = get().groupMeta;
    if (!meta[oldName]) return;
    const { [oldName]: entry, ...rest } = meta;
    const next: ProjectGroupsMeta = { ...rest, [newName]: entry };
    set({ groupMeta: next });
    get().persistGroupMeta(next);
  },

  /** Assign a project to a group (left-bar "grouped" view). Pass null to
   *  remove it. The returned project replaces the stale copy in state. */
  setProjectGroup: async (id, group) => {
    const { project } = await api.project.setGroup({ id, group });
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }));
  },

  /** Rename a project (display-only). The returned project replaces the
   *  stale copy in state — every consumer (left bar, archive bin, settings
   *  project pickers) reads the same `projects` array and follows along. */
  renameProject: async (id, name) => {
    const { project } = await api.project.rename({ id, name });
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }));
  },

  /** Pin/unpin a project. The row's POSITION changes (pinned section vs
   *  flat list / group), and the authoritative ordering lives in the DB's
   *  list query — rather than hand-maintaining that order in the renderer,
   *  refetch the whole (small) list after the write. */
  setProjectPinned: async (id, pinned) => {
    await api.project.setPinned({ id, pinned });
    const { projects } = await api.project.list();
    set({ projects });
  },

  /** Persist a drag-to-reorder. The renderer sends the full ordered id list
   *  (across the current view); here we optimistically reorder the in-memory
   *  `projects` array to match (keeping each project object reference stable
   *  so consumers keyed on identity don't re-render), then fire-and-forget
   *  the DB write. Projects not present in `orderedIds` (e.g. archived rows
   *  filtered out of the drag view) keep their relative position at the end. */
  reorderProjects: async (orderedIds) => {
    set((s) => {
      const byId = new Map(s.projects.map((p) => [p.id, p]));
      const next: Project[] = [];
      const seen = new Set<string>();
      for (const id of orderedIds) {
        const p = byId.get(id);
        if (p && !seen.has(id)) {
          next.push(p);
          seen.add(id);
        }
      }
      // Append any projects not in orderedIds (archived / filtered out) so
      // they aren't dropped from state.
      for (const p of s.projects) {
        if (!seen.has(p.id)) next.push(p);
      }
      return { projects: next };
    });
    try {
      await api.project.reorder({ orderedIds });
    } catch (err) {
      console.error("project.reorder failed:", err);
    }
  },

  setChatFontSize: async (px) => {
    const clamped = clampFontSize(px);
    set({ chatFontSize: clamped });
    try {
      await api.setting.set({
        key: UI_CHAT_FONT_SIZE_SETTING_KEY,
        value: String(clamped),
      });
    } catch (err) {
      console.error("setting.set(chatFontSize) failed:", err);
    }
  },

  setRightPanelFontSize: async (px) => {
    const clamped = clampRightPanelFontSize(px);
    set({ rightPanelFontSize: clamped });
    try {
      await api.setting.set({
        key: UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY,
        value: String(clamped),
      });
    } catch (err) {
      console.error("setting.set(rightPanelFontSize) failed:", err);
    }
  },

  setPasteTagThresholdChars: async (n) => {
    const clamped = clampPasteTagThresholdChars(n);
    set({ pasteTagThresholdChars: clamped });
    try {
      await api.setting.set({
        key: UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY,
        value: String(clamped),
      });
    } catch (err) {
      console.error("setting.set(pasteTagThresholdChars) failed:", err);
    }
  },

  setVoiceInputMode: async (mode) => {
    set({ voiceInputMode: mode });
    try {
      await api.setting.set({ key: UI_VOICE_INPUT_MODE_SETTING_KEY, value: mode });
    } catch (err) {
      console.error("setting.set(voiceInputMode) failed:", err);
    }
  },

  setVoiceLang: async (lang) => {
    set({ voiceLang: lang });
    try {
      await api.setting.set({ key: UI_VOICE_LANG_SETTING_KEY, value: lang });
    } catch (err) {
      console.error("setting.set(voiceLang) failed:", err);
    }
  },

  setVoiceEngine: async (engine) => {
    set({ voiceEngine: engine });
    try {
      await api.setting.set({ key: UI_VOICE_ENGINE_SETTING_KEY, value: engine });
    } catch (err) {
      console.error("setting.set(voiceEngine) failed:", err);
    }
  },

  setVoiceMicPermission: async (perm) => {
    set({ voiceMicPermission: perm });
    try {
      await api.setting.set({ key: UI_VOICE_MIC_PERMISSION_SETTING_KEY, value: perm });
    } catch (err) {
      console.error("setting.set(voiceMicPermission) failed:", err);
    }
  },

  setVoiceModelDir: async (dir) => {
    set({ voiceModelDir: dir });
    try {
      await api.setting.set({ key: UI_VOICE_MODEL_DIR_SETTING_KEY, value: dir });
    } catch (err) {
      console.error("setting.set(voiceModelDir) failed:", err);
    }
  },

  setUserMessageColor: async (rgb) => {
    // null or malformed → treat as "use theme default" and clear any stored
    // value so the default re-asserts cleanly on reload.
    const safe = rgb && RGB_TRIPLET_RE.test(rgb) ? rgb : null;
    set({ userMessageColor: safe });
    try {
      await api.setting.set({
        key: UI_USER_MSG_COLOR_SETTING_KEY,
        value: safe ?? "",
      });
    } catch (err) {
      console.error("setting.set(userMessageColor) failed:", err);
    }
  },

  setAccentColor: async (rgb) => {
    // Same normalization as setUserMessageColor: null or malformed → clear
    // the override so the per-theme --accent default re-asserts.
    const safe = rgb && RGB_TRIPLET_RE.test(rgb) ? rgb : null;
    set({ accentColor: safe });
    try {
      await api.setting.set({
        key: UI_ACCENT_COLOR_SETTING_KEY,
        value: safe ?? "",
      });
    } catch (err) {
      console.error("setting.set(accentColor) failed:", err);
    }
  },

  setEditorTheme: async (mode, id) => {
    // Optimistic: the new choice is in the store immediately so mounted
    // editors re-theme live; the DB write is fire-and-forget like the other
    // appearance setters.
    const next = { ...get().editorTheme, [mode]: id };
    set({ editorTheme: next });
    try {
      await api.setting.set({
        key: UI_EDITOR_THEME_SETTING_KEY,
        value: JSON.stringify(next),
      });
    } catch (err) {
      console.error("setting.set(editorTheme) failed:", err);
    }
  },

  /** Bind (or rebind) a keyboard shortcut. Optimistic: the in-memory override
   *  map flips immediately so the next keydown uses the new chord; the DB
   *  write is fire-and-forget. Passing `null` removes the override for
   *  `commandId`, so the command falls back to its compiled-in default
   *  (or to "no binding" if it has none). The whole override map is serialized
   *  as one JSON blob — only user-changed entries are stored, defaults live
   *  in code. */
  setShortcutOverride: (commandId, accel) => {
    const next = { ...get().shortcutOverrides };
    if (accel) next[commandId] = accel;
    else delete next[commandId];
    set({ shortcutOverrides: next });
    try {
      void api.setting.set({
        key: UI_SHORTCUTS_SETTING_KEY,
        value: JSON.stringify(next),
      });
    } catch (err) {
      console.error("setting.set(shortcuts) failed:", err);
    }
  },

  /** Clear all shortcut overrides, restoring every default binding. The
   *  in-memory map empties immediately; the DB write persists an empty blob. */
  resetAllShortcuts: () => {
    set({ shortcutOverrides: {} });
    try {
      void api.setting.set({
        key: UI_SHORTCUTS_SETTING_KEY,
        value: "{}",
      });
    } catch (err) {
      console.error("setting.set(shortcuts reset) failed:", err);
    }
  },

  /** Toggle the "recording a chord" sentinel. The global keydown listener
   *  suppresses dispatch while this is true so a captured chord doesn't
   *  also fire the command it's being assigned to. Not persisted. */
  setShortcutRecording: (recording) => {
    set({ shortcutRecording: recording });
  },

  /** Persist the active session's permission mode. The local slot is updated
   *  immediately so the chip reflects the change without a round-trip; the
   *  DB write is fire-and-forget — if it fails, the next `selectSession`
   *  (or app restart) will re-hydrate from the row. */
  setPermissionMode: (mode) => {
    const sessionId = get().activeSessionId;
    set({ permissionMode: mode });
    if (sessionId) {
      void api.session.updateSettings({ sessionId, permissionMode: mode }).catch((err) => {
        console.error("updateSettings(permissionMode) failed:", err);
      });
    }
  },

  setEnvChoice: (choice) => {
    set({ envChoice: choice });
    const g = get();
    const sessionId = g.activeSessionId;
    const active = sessionId
      ? findSession(g.sessionsByProject, g.archivedSessionsByProject, g.pinnedSessions, sessionId)
      : undefined;
    // Any UN-MATERIALIZED session in the foreground (local OR worktree
    // intent — it still has no git footprint) → the choice edits THAT
    // session's environment, both directions. This is what makes the chip
    // read as "this thread's environment" until the first turn locks it.
    if (active && !active.worktreePath) {
      const envMode = choice === "local" ? ("local" as const) : ("worktree" as const);
      // null on the local flip clears any stale form intent on the row.
      const wtStyle =
        choice === "wt-branch" ? ("branch" as const) : choice === "wt-detached" ? ("detached" as const) : null;
      void api.session
        .updateSettings({ sessionId: active.id, envMode, wtStyle })
        .catch((err) => {
          console.error("updateSettings(envMode) failed:", err);
        });
      // Patch the cached row so the chip reflects it locally without
      // waiting for the session.changed round-trip.
      set((s) => ({
        sessionsByProject: patchSessionInCache(s.sessionsByProject, active.projectId, active.id, {
          envMode,
          wtStyle,
        }),
      }));
      return;
    }
    // No session in the foreground (empty state) — or the session is already
    // materialized (locked; the UI disables switching): fall through to the
    // persisted DEFAULT for new sessions. Stored as the EnvChoice string
    // (the legacy "true"/"false" values still hydrate — see init).
    void api.setting
      .set({ key: SESSION_WORKTREE_DEFAULT_SETTING_KEY, value: choice })
      .catch((err) => {
        console.error("setting.set(worktreeDefault) failed:", err);
      });
  },

  /** Persist the active session's model. See `setPermissionMode` for the
   *  optimistic-local / fire-and-forget pattern. */
  setModel: (model) => {
    const sessionId = get().activeSessionId;
    set((s) => ({
      model,
      lastModelByProvider: {
        ...s.lastModelByProvider,
        [s.providerId]: { model, customModelId: s.customModelId },
      },
    }));
    if (sessionId) {
      void api.session.updateSettings({ sessionId, model }).catch((err) => {
        console.error("updateSettings(model) failed:", err);
      });
    }
    // Remember the pick as the next-session default (restored at boot).
    persistComposerSelection(get());
  },
  /** Persist the active session's reasoning effort. See `setPermissionMode`
   *  for the pattern. */
  setEffort: (effort) => {
    const sessionId = get().activeSessionId;
    set({ effort });
    if (sessionId) {
      void api.session.updateSettings({ sessionId, effort }).catch((err) => {
        console.error("updateSettings(effort) failed:", err);
      });
    }
  },

  /** Pick a built-in model or one of a custom-config's models. Both
   *  `customModelId` and `model` (the model id) are part of the session's
   *  persisted config, so a single updateSettings patch covers the change. */
  setCustomModel: (id, modelArg) => {
    set((s) => {
      let nextModel: string;
      if (!id) {
        nextModel = "default";
      } else if (modelArg) {
        // Caller picked a specific model (e.g. "deepseek-v4-pro"); trust it.
        nextModel = modelArg;
      } else {
        // No model given — fall back to the config's first model so the
        // chip/dropdown shows something meaningful. If none is configured
        // (shouldn't happen for a saved config), fall back to "default".
        const cfg = s.customModels.find((m) => m.id === id);
        const first = cfg?.models.find((m) => m.id.trim())?.id ?? "default";
        nextModel = first;
      }
      return {
        customModelId: id,
        model: nextModel,
        lastModelByProvider: {
          ...s.lastModelByProvider,
          [s.providerId]: { model: nextModel, customModelId: id },
        },
      };
    });
    // Persist the new binding + model to the session row. We compute the
    // resolved model from the same logic as above (re-read post-set to be
    // sure) and send both fields in one patch.
    const sessionId = get().activeSessionId;
    if (sessionId) {
      const { model, customModelId } = get();
      void api.session.updateSettings({ sessionId, model, customModelId }).catch((err) => {
        console.error("updateSettings(customModel) failed:", err);
      });
    }
    // Remember the pick as the next-session default (restored at boot).
    persistComposerSelection(get());
  },

  reloadCustomModels: async () => {
    try {
      const { models } = await api.customModel.list();
      set({ customModels: models });
      // A persisted composer pick whose custom config was deleted falls back
      // to auto.
      validateComposerSelection(set, get);
    } catch (err) {
      console.error("reloadCustomModels failed:", err);
    }
  },

  setProvider: (id) => {
    // Always update the "next session" slot — new threads inherit this.
    // When switching to a *different* provider: model ids live in
    // per-provider namespaces (claude uses gateway model ids like
    // "deepseek-v4-pro"; pi uses "provider/modelId" strings), so a leftover
    // value would either render as a raw id in the chip or point at a model
    // the new provider can't resolve. Instead of snapping to "default",
    // remember the outgoing provider's selection (so switching back restores
    // it) and re-apply the target provider's last remembered model — dropped
    // back to "default" when the remembered model has since been deleted.
    // customModelId is a claude-only concept (gateway configs), so it must be
    // cleared on any switch away.
    const prevProviderId = get().providerId;
    const providerChanged = prevProviderId !== id;
    // Restore result for the target provider — kept so the session-row sync
    // below persists the SAME model the composer now shows (a row left at
    // "default"/stale would clobber the restore on the next
    // syncConfigFromSession).
    let restored: { model: string; customModelId: string | null };
    if (providerChanged) {
      const s = get();
      const nextMap = { ...s.lastModelByProvider };
      nextMap[prevProviderId] = { model: s.model, customModelId: s.customModelId };
      const remembered = nextMap[id];
      restored =
        isValidRememberedModel(s, id, remembered) && remembered.model !== "default"
          ? { model: remembered.model, customModelId: remembered.customModelId }
          : { model: "default", customModelId: null };
      set({ providerId: id, ...restored, lastModelByProvider: nextMap });
    } else {
      restored = { model: get().model, customModelId: get().customModelId };
      set({ providerId: id });
    }
    // Remember the pick as the next-session default (restored at boot).
    persistComposerSelection(get());

    // If a blank (message-less) session is currently active, also sync the
    // change onto its session row so the provider is fixed correctly before
    // the first turn. This keeps the left-bar rows, session tabs, and the
    // titlebar thread icon (all of which read session.providerId) in sync
    // as the user picks a different SDK. A session with messages is already
    // locked — ProviderDropdown hides the chip, so we never reach here for it,
    // and we guard defensively in case the action is called directly.
    const sid = get().activeSessionId;
    if (!sid) return;
    const bucket = get().messagesBySession[sid];
    if (bucket && bucket.length > 0) return;

    const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, sid);
    if (!sess || sess.providerId === id) return;
    const projectId = sess.projectId;

    set((s) => {
      const patchRow = (list: Session[]): Session[] =>
        list.map((x) =>
          x.id === sid
            ? { ...x, providerId: id, model: restored.model, customModelId: restored.customModelId }
            : x,
        );
      const nextByProject = { ...s.sessionsByProject };
      if (nextByProject[projectId]) {
        nextByProject[projectId] = patchRow(nextByProject[projectId]);
      }
      const nextArchived = { ...s.archivedSessionsByProject };
      if (nextArchived[projectId]) {
        nextArchived[projectId] = patchRow(nextArchived[projectId]);
      }
      // `sessions` is a derived alias of the active project's list; refresh it
      // only when it currently points at this session's project.
      const nextSessions = s.activeProjectId === projectId && nextByProject[projectId]
        ? nextByProject[projectId]
        : s.sessions;
      return { sessionsByProject: nextByProject, archivedSessionsByProject: nextArchived, sessions: nextSessions };
    });

    // Persist the provider change to the session row, along with the restored
    // model (so the row stays consistent with what the composer shows and a
    // later syncConfigFromSession doesn't clobber the restore). Fire-and-
    // forget, like the other updateSettings callers.
    void api.session
      .updateSettings(
        providerChanged
          ? { sessionId: sid, providerId: id, model: restored.model, customModelId: restored.customModelId }
          : { sessionId: sid, providerId: id },
      )
      .catch((err) => {
        console.error("updateSettings(providerId) failed:", err);
      });
  },

  reloadProviders: async () => {
    try {
      const { providers } = await api.provider.list();
      set({ providers });
      // A persisted composer pick for a provider that no longer exists falls
      // back to the default provider + auto.
      validateComposerSelection(set, get);
    } catch (err) {
      console.error("reloadProviders failed:", err);
    }
  },

  reloadPiAvailableModels: async () => {
    try {
      const { models } = await api.piModels.listAvailable();
      set({ piAvailableModels: models });
      // A persisted composer pick whose pi model was deleted falls back
      // to auto.
      validateComposerSelection(set, get);
    } catch (err) {
      console.error("reloadPiAvailableModels failed:", err);
    }
  },

  reloadLspLanguages: async () => {
    try {
      const { languages } = await api.lsp.list();
      set({ lspLanguages: languages });
      // Java just enabled (or hydration finished with it enabled) → start
      // the import now rather than at the first openDocument.
      get().prewarmJavaLspForActiveProject();
      // When the TypeScript server is enabled, suppress Monaco's built-in
      // tsWorker diagnostics so we don't get duplicate squiggles. The setup
      // module exposes this toggle; it's a no-op if Monaco isn't loaded yet.
      try {
        const tsEnabled = languages.some((l) => l.language === "typescript" && l.enabled);
        await import("@renderer/lib/monacoSetup.js").then((m) => {
          if (typeof m.setTsWorkerDiagnosticsEnabled === "function") {
            m.setTsWorkerDiagnosticsEnabled(!tsEnabled);
          }
        });
      } catch {
        // Monaco not yet imported (no editor mounted) - skip; will be applied
        // on next reload once monacoSetup is loaded.
      }
    } catch (err) {
      console.error("reloadLspLanguages failed:", err);
    }
  },

  prewarmJavaLspForActiveProject: () => {
    if (!isElectron) return;
    if (!get().lspLanguages.some((l) => l.language === "java" && l.enabled)) return;
    const pid = get().activeProjectId;
    const path = pid ? get().projects.find((p) => p.id === pid)?.path : undefined;
    if (!path) return;
    void api.lsp.prewarm({ workspacePath: path }).catch((err) => {
      console.debug("lsp prewarm skipped:", err);
    });
  },

  reloadSkills: async () => {
    // Resolve the active project's path. skills.list scans that root's
    // .claude/skills in addition to the user-global dir; without a project
    // there's nothing project-scoped to add (global-only would mislead the
    // menu into showing skills that may not apply), so we no-op.
    const pid = get().activeProjectId;
    const project = pid ? get().projects.find((p) => p.id === pid) : undefined;
    if (!project) {
      set({ skills: EMPTY_SKILLS });
      return;
    }
    try {
      const { skills } = await api.skills.list({ projectPath: project.path });
      set({ skills: skills.length ? skills : EMPTY_SKILLS });
    } catch (err) {
      console.error("reloadSkills failed:", err);
    }
  },

  dismissQuestion: () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const pending = get().pendingQuestionBySession[sessionId];
    // Resolve the provider's pending Deferred as DISMISSED so the model's
    // turn CONTINUES (it sees the question was skipped and decides what to
    // do). The old behavior only cleared the local card, leaving the model
    // blocked forever waiting for answers.
    if (pending) {
      const requestId = pending.requestId ?? `sentinel_${sessionId}_${Date.now()}`;
      void api.claude
        .respondQuestion({ sessionId, requestId, answers: {}, dismissed: true })
        .catch((err) => {
          console.error("respondQuestion(dismiss) failed:", err);
        });
    }
    set((s) => {
      const { [sessionId]: _drop, ...rest } = s.pendingQuestionBySession;
      return { pendingQuestionBySession: rest };
    });
  },

  /** Submit the user's answers to the active session's pending
   *  AskUserQuestion. Resolves the provider's pending user-input Deferred
   *  via `claude:respondQuestion` so the SAME turn continues — this is the
   *  fix for the old bug where submitting answers started a *new* turn
   *  (via sendPrompt) instead of resuming the in-flight one.
   *
   *  `requestId` correlation: the question.ask event carried a requestId;
   *  we pass it back so main finds the right Deferred. Sentinel-fallback
   *  requests (no Deferred on the main side) are handled by main — it
   *  composes the answers into a follow-up prompt. Either way we clear
   *  the local pending card; if the IPC fails the card stays so the user
   *  can retry. */
  submitQuestion: async (answers, sessionIdArg) => {
    const sessionId = sessionIdArg ?? get().activeSessionId;
    if (!sessionId) return;
    const pending = get().pendingQuestionBySession[sessionId];
    if (!pending) return;
    const requestId = pending.requestId ?? `sentinel_${sessionId}_${Date.now()}`;
    try {
      await api.claude.respondQuestion({ sessionId, requestId, answers });
      // Only dismiss on success — a failed IPC leaves the card in place
      // so the user can retry instead of thinking they answered.
      set((s) => {
        const { [sessionId]: _drop, ...rest } = s.pendingQuestionBySession;
        return { pendingQuestionBySession: rest };
      });
    } catch (err) {
      console.error("claude.respondQuestion failed:", err);
    }
  },

  /** Approve or deny the head of the approval queue. The IPC resolves the
   *  matching canUseTool on the main side. Only on a successful resolve do
   *  we shift the head off — a failed IPC leaves the card in place so the
   *  user can retry instead of thinking they approved something they didn't. */
  decideApproval: async (requestId, granted, always) => {
    // Find the head matching this id (defensive — UI always passes head[0]).
    const head = get().pendingApprovals.find((p) => p.requestId === requestId);
    if (!head) return;
    // Resolve the owning session from the request itself — with the side chat
    // running concurrently the foreground activeSessionId may be a DIFFERENT
    // session than the one whose approval is being answered.
    const sessionId = head.sessionId;
    try {
      await api.claude.approve({ sessionId, requestId, granted, always });
    } catch (err) {
      // Don't shift on failure; surface the error to the console so the
      // user/dev can see it without a modal interrupting the queue flow.
      console.error("claude.approve failed:", err);
      return;
    }
    set((s) => ({
      pendingApprovals: s.pendingApprovals.filter((p) => p.requestId !== requestId),
    }));
  },

  /** Submit the user's approve/reject decision on a pending ExitPlanMode
   *  plan. Calls `claude:respondPlanApproval` which resolves the provider's
   *  pending plan-approval Deferred — the SAME turn then continues (approve
   *  → SDK exits plan mode + starts executing; reject → SDK stays in plan
   *  mode, model revises). `feedback` is the user's plan-adjustment opinion
   *  from the approval sheet: on approve it's delivered to the model
   *  alongside the approval (execution incorporates it); on reject it serves
   *  as the reason. Clears the pending card on success; on failure the card
   *  stays so the user can retry. */
  submitPlanApproval: async (requestId, approved, editedPlan, reason, feedback) => {
    // Look up by requestId across ALL per-session buckets — the pending plan
    // may belong to the side chat while the foreground active session is its
    // parent (or vice versa).
    let sessionId: string | null = null;
    let pending: PlanApprovalRequestEvent | undefined;
    for (const [sid, p] of Object.entries(get().pendingPlanApprovalBySession)) {
      if (p.requestId === requestId) {
        sessionId = sid;
        pending = p;
        break;
      }
    }
    if (!pending || !sessionId) return;
    try {
      await api.claude.respondPlanApproval({ sessionId, requestId, approved, editedPlan, reason, feedback });
      set((s) => {
        const { [sessionId]: _drop, ...rest } = s.pendingPlanApprovalBySession;
        // Drop the 待审阅 badge on the inline plan block now that the user
        // has decided. On approve the adapter will follow up with a
        // plan.update phase:"ready" (block stays, freezes at turn.done);
        // on reject it emits phase:"cleared" which removes the block. Either
        // way we flip hasApproval off immediately so the badge doesn't linger.
        const list = s.messagesBySession[sessionId] ?? EMPTY_MESSAGES;
        const next = upsertLivePlanBlock(list, pending.plan, "ready", false, s.runningTurnStartedAt[sessionId] ?? Date.now());
        // Clear the staged editor draft now that the decision is submitted -
        // the draft only mattered while the approval was pending.
        const { [sessionId]: _dropDraft, ...restDrafts } = s.planApprovalDraftBySession;
        return {
          pendingPlanApprovalBySession: rest,
          planApprovalDraftBySession: restDrafts,
          messagesBySession: next === list
            ? s.messagesBySession
            : { ...s.messagesBySession, [sessionId]: next },
        };
      });
    } catch (err) {
      console.error("claude.respondPlanApproval failed:", err);
    }
  },

  handoffPlanApproval: async (sessionId, requestId, target, feedback) => {
    const s0 = get();
    const pending = s0.pendingPlanApprovalBySession[sessionId];
    if (!pending || pending.requestId !== requestId) return;
    // The flows below rebind the ACTIVE session's config slots and sendPrompt
    // is active-session scoped — the handoff must run from the foreground tab
    // that owns this approval sheet.
    if (sessionId !== s0.activeSessionId) return;
    // Prefer the staged editor draft (PlanViewer edits): unlike a plain
    // approve it is NOT delivered through the ExitPlanMode dialog, so the
    // kickoff prompt is its only carrier to the executing agent.
    const planText = s0.planApprovalDraftBySession[sessionId] ?? pending.plan;
    const fb = feedback?.trim() ? feedback.trim() : undefined;
    // Capture the turn anchor BEFORE interrupt() wipes it, so the badge-flip
    // below lands on the same live plan block the sheet was showing.
    const anchor = s0.runningTurnStartedAt[sessionId] ?? Date.now();

    // End the blocked turn WITHOUT answering the ExitPlanMode dialog: the
    // abort means no request.resolved will ever arrive, so clear the local
    // pending state here (mirrors submitPlanApproval's cleanup — sheet gone,
    // 待审阅 badge dropped, staged draft released).
    await get().interrupt(sessionId);
    set((s) => {
      const { [sessionId]: _drop, ...rest } = s.pendingPlanApprovalBySession;
      const { [sessionId]: _dropDraft, ...restDrafts } = s.planApprovalDraftBySession;
      const list = s.messagesBySession[sessionId] ?? EMPTY_MESSAGES;
      const next = upsertLivePlanBlock(list, planText, "ready", false, anchor);
      return {
        pendingPlanApprovalBySession: rest,
        planApprovalDraftBySession: restDrafts,
        messagesBySession: next === list
          ? s.messagesBySession
          : { ...s.messagesBySession, [sessionId]: next },
      };
    });

    const kickoff = buildPlanKickoffPrompt(planText, fb, target.kind === "remodel");
    if (target.kind === "remodel") {
      // Rebind this session's model in ONE patch. Going through the existing
      // setters is a poor fit: setCustomModel(null, id) resets model to
      // "default" (its null branch ignores the id), and setModel alone would
      // leave a stale customModelId behind — two fire-and-forget
      // updateSettings calls could also race. The inline patch avoids all
      // three and lands a single IPC.
      set((s) => ({
        model: target.model,
        customModelId: target.customModelId,
        lastModelByProvider: {
          ...s.lastModelByProvider,
          [s.providerId]: { model: target.model, customModelId: target.customModelId },
        },
      }));
      void api.session
        .updateSettings({ sessionId, model: target.model, customModelId: target.customModelId })
        .catch((err) => {
          console.error("updateSettings(plan handoff remodel) failed:", err);
        });
      persistComposerSelection(get());
      // Fresh turn in the SAME thread: transcript context carries via resume,
      // only the model changed. interrupt() already cleared the running flag,
      // and sendPrompt clears the interrupt sentinel itself.
      void get().sendPrompt(kickoff);
      return;
    }
    // newSession: same project as the planning thread, executor chosen in the
    // sheet. The kickoff rides the per-session prompt queue so the existing
    // send-model guard + busy-check apply (it fires the moment the new tab
    // is idle — which a brand-new session always is).
    const sess = findSession(
      get().sessionsByProject,
      get().archivedSessionsByProject,
      get().pinnedSessions,
      sessionId,
    );
    const projectId = sess?.projectId ?? get().activeProjectId;
    // No resolvable project → nothing to create (startSession would no-op
    // anyway); the newSid guard below keeps the enqueue from misfiring.
    if (projectId) {
      try {
        await get().startSession(projectId, {
          providerId: target.providerId,
          model: target.model,
          customModelId: target.customModelId,
        });
      } catch (err) {
        // The planning thread is already interrupted + cleaned up; log and
        // stop here rather than surfacing an unhandled rejection (the user
        // can still send the kickoff manually if they want).
        console.error("plan handoff: startSession failed:", err);
        return;
      }
    }
    const newSid = get().activeSessionId;
    if (newSid && newSid !== sessionId) {
      // The new session renders the handoff as "note + plan card" (same
      // PlanStreamBlock the planning session showed) instead of dumping the
      // raw kickoff text — `prompt` still carries the full kickoff to the
      // model, and the plan block persists with the user message so the card
      // survives session reloads.
      const note = fb
        ? translate(get().locale, "chat.plan.kickoffNoteWithFeedback", { feedback: fb })
        : translate(get().locale, "chat.plan.kickoffNote");
      const displayBlocks: Block[] = [
        { kind: "text", text: note },
        { kind: "plan", planId: LIVE_PLAN_ID, plan: planText, phase: "ready" },
      ];
      get().enqueuePrompt(newSid, { prompt: kickoff, displayText: note, displayBlocks });
      get().drainPromptQueueIfIdle(newSid);
    }
  },

  openPlanDrawer: (sessionId, plan) => {
    // The web (phone) shell has no editor column / PlanViewer — open the
    // read-only plan view in the mobile fullscreen overlay instead. Same
    // action serves both shells so every call site stays transport-neutral.
    if (!isElectron) {
      set({ mobileViewer: { kind: "plan", plan } });
      return;
    }
    set((s) => ({
      planDrawerPlanBySession: { ...s.planDrawerPlanBySession, [sessionId]: plan },
      planTabActiveBySession: { ...s.planTabActiveBySession, [sessionId]: true },
      // Opening the plan (from a plan card / approval prompt) surfaces the
      // plan tab — in tabs displayMode that means focusing the editor view.
      ...(s.displayMode === "tabs" ? { centerTabFocus: "editor" as const } : {}),
    }));
  },
  openMobileViewer: (target) => {
    set({ mobileViewer: target });
  },
  closeMobileViewer: () => {
    set({ mobileViewer: null });
  },
  closePlanDrawer: (sessionId) => {
    set((s) => {
      const { [sessionId]: _dropPlan, ...restPlan } = s.planDrawerPlanBySession;
      const { [sessionId]: _dropActive, ...restActive } = s.planTabActiveBySession;
      const { [sessionId]: _dropDraft, ...restDrafts } = s.planApprovalDraftBySession;
      // When closing the plan tab, restore the active file to the first open
      // file (if any) so the editor column stays visible instead of hiding
      // entirely. This mirrors closing a file tab that shifts to the next.
      const pid = s.activeProjectId;
      const openFiles = pid ? s.ideOpenFilesByProject[pid] ?? [] : [];
      const restoreFile = openFiles.length > 0 ? openFiles[0] : null;
      return {
        planDrawerPlanBySession: restPlan,
        planTabActiveBySession: restActive,
        planApprovalDraftBySession: restDrafts,
        ...(pid && restoreFile
          ? { ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: restoreFile } }
          : {}),
        // Unified bar: with a file to fall back to the editor view survives
        // (keep the current focus); otherwise return to the chat view.
        centerTabFocus: restoreFile ? s.centerTabFocus : ("chat" as const),
      };
    });
  },
  setPlanTabActive: (sessionId, active) => {
    set((s) => ({
      planTabActiveBySession: { ...s.planTabActiveBySession, [sessionId]: active },
      // Activating the plan tab (tab click / restore) focuses the editor
      // view in tabs displayMode.
      ...(active && s.displayMode === "tabs"
        ? { centerTabFocus: "editor" as const }
        : {}),
    }));
  },
  setPlanApprovalDraft: (sessionId, draft) => {
    set((s) => ({
      planApprovalDraftBySession: { ...s.planApprovalDraftBySession, [sessionId]: draft },
    }));
  },
  updatePlanDrawerPlan: (sessionId, plan) => {
    set((s) => {
      // No-op if no plan tab is open for this session - avoids opening one
      // as a side effect of a stray save.
      if (s.planDrawerPlanBySession[sessionId] == null) return s;
      return {
        planDrawerPlanBySession: { ...s.planDrawerPlanBySession, [sessionId]: plan },
      };
    });
  },

  rewindTurn: async (files, targetFiles) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    if (files.length === 0) {
      // Nothing to rewind — defensive (UI shouldn't allow the click).
      return;
    }
    try {
      await api.claude.rewindTurn({ sessionId, files, targetFiles });
      // Don't optimistically clear turnFiles — wait for the `turn.rewound`
      // event from main so the UI only updates when files are actually
      // back on disk. If the IPC call returns successfully but main fails
      // partway through restore, the (smaller) restored list still
      // arrives via the event and we clear from there.
    } catch (err) {
      console.error("claude.rewindTurn failed:", err);
    }
  },

  revealInFileTree: (filePath) => {
    // Panel-first: switching the tab + bumping the focus nonce both matter
    // even before the tree reveal lands — the user asked to GO somewhere, so
    // make sure the destination is visible. setRightPanelTab persists the
    // tab like any manual tab click does.
    get().setRightPanelTab("files");
    set((s) => ({
      ideFocusNonce: s.ideFocusNonce + 1,
      ideTreeReveal: { filePath, nonce: (s.ideTreeReveal?.nonce ?? 0) + 1 },
    }));
  },

  refreshClaudeHealth: async () => {
    const health = await api.claudeHealthCheck();
    set({ claudeInstalled: health.installed });
  },

  enqueueChatFile: (filePath) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    set((s) => {
      const prev = s.chatFileQueueBySession[sessionId] ?? [];
      return {
        chatFileQueueBySession: {
          ...s.chatFileQueueBySession,
          [sessionId]: [...prev, filePath],
        },
        // The attachment lands in the composer — bring the chat view back so
        // the user sees it happen (tabs displayMode).
        ...(s.displayMode === "tabs" ? { centerTabFocus: "chat" as const } : {}),
      };
    });
  },

  drainChatFileQueue: (sessionIdArg?: string) => {
    const sessionId = sessionIdArg ?? get().activeSessionId;
    if (!sessionId) return [];
    const queued = get().chatFileQueueBySession[sessionId];
    if (!queued || queued.length === 0) return [];
    set((s) => {
      const { [sessionId]: _drop, ...rest } = s.chatFileQueueBySession;
      return { chatFileQueueBySession: rest };
    });
    return queued;
  },

  enqueueChatElement: (element) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    set((s) => {
      const prev = s.chatElementQueueBySession[sessionId] ?? [];
      return {
        chatElementQueueBySession: {
          ...s.chatElementQueueBySession,
          [sessionId]: [...prev, element],
        },
      };
    });
  },

  drainChatElementQueue: (sessionIdArg?: string) => {
    const sessionId = sessionIdArg ?? get().activeSessionId;
    if (!sessionId) return [];
    const queued = get().chatElementQueueBySession[sessionId];
    if (!queued || queued.length === 0) return [];
    set((s) => {
      const { [sessionId]: _drop, ...rest } = s.chatElementQueueBySession;
      return { chatElementQueueBySession: rest };
    });
    return queued;
  },

  enqueuePrompt: (sessionId, item) => {
    const queued: QueuedPrompt = { ...item, id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
    set((s) => {
      const prev = s.promptQueueBySession[sessionId] ?? [];
      return {
        promptQueueBySession: {
          ...s.promptQueueBySession,
          [sessionId]: [...prev, queued],
        },
      };
    });
  },

  removeQueuedPrompt: (sessionId, id) => {
    set((s) => {
      const prev = s.promptQueueBySession[sessionId];
      if (!prev || prev.length === 0) return {};
      const next = prev.filter((q) => q.id !== id);
      return {
        promptQueueBySession: {
          ...s.promptQueueBySession,
          [sessionId]: next,
        },
      };
    });
  },

  clearPromptQueue: (sessionId) => {
    set((s) => {
      if (!s.promptQueueBySession[sessionId]) return {};
      const { [sessionId]: _drop, ...rest } = s.promptQueueBySession;
      return { promptQueueBySession: rest };
    });
  },

  saveComposerDraft: (sessionId, draft) => {
    set((s) => ({
      composerDraftBySession: { ...s.composerDraftBySession, [sessionId]: draft },
    }));
  },

  clearComposerDraft: (sessionId) => {
    set((s) => {
      if (!s.composerDraftBySession[sessionId]) return {};
      const { [sessionId]: _drop, ...rest } = s.composerDraftBySession;
      return { composerDraftBySession: rest };
    });
  },

  drainPromptQueueIfIdle: (sessionId) => {
    const s = get();
    // Only drain when fully idle: no running turn AND no running background
    // subagent (a backgrounded task keeps the session logically busy even
    // after the parent turn's stream closed).
    if (s.runningBySession[sessionId]) return;
    const agents = s.subagentsBySession[sessionId] ?? [];
    if (agents.some((a) => a.status === "running")) return;
    const q = s.promptQueueBySession[sessionId];
    if (!q || q.length === 0) return;
    const head = q[0];
    // Send-time model guard, checked BEFORE dropping the head: if the active
    // provider has nothing configured, the subsequent sendPrompt would be
    // blocked and the dropped item lost. Keep it queued + raise the dialog.
    if (!resolveSendModel(s)) {
      set({ modelConfigPromptOpen: true });
      return;
    }
    // Drop the head from the queue BEFORE sending so the user sees it leave
    // immediately, and so a failed send doesn't loop on the same item.
    set((st) => ({
      promptQueueBySession: {
        ...st.promptQueueBySession,
        [sessionId]: st.promptQueueBySession[sessionId]?.slice(1) ?? [],
      },
    }));
    // Reuse the normal send path: it appends the user message, flips busy,
    // and fires sendTurn. If that turn later ends with another queued item,
    // its turn.done handler will call drainPromptQueueIfIdle again — so the
    // whole queue drains one item per turn, in order. Explicit sessionId so
    // a background/side session's queue never drains into the foreground one.
    void s.sendPrompt(head.prompt, head.attachments, head.displayText, head.skillNames, head.images, head.displayBlocks, sessionId);
  },

  sendQueuedPromptNow: async (sessionId, id) => {
    const q = get().promptQueueBySession[sessionId] ?? EMPTY_PROMPT_QUEUE;
    const item = q.find((x) => x.id === id);
    if (!item) return;
    // If the session is busy (running turn or running background subagent),
    // interrupt it first so this prompt can fire immediately as a new turn.
    // interrupt() awaits the IPC and synchronously clears runningBySession +
    // demotes running subagents, so sendPrompt's busy guard lets us through.
    const agents = get().subagentsBySession[sessionId] ?? EMPTY_SUBAGENTS;
    const busy =
      get().runningBySession[sessionId] || agents.some((a) => a.status === "running");
    if (busy) {
      await get().interrupt(sessionId);
    }
    // Drop only this item; the rest of the queue is preserved.
    get().removeQueuedPrompt(sessionId, id);
    // Reuse the normal send path. sendPrompt clears the interruptedBySession
    // sentinel, so the old turn's late turn.done{interrupted} is filtered by
    // the existing race guard (sendPrompt / editAndResendMessage rely on it).
    await get().sendPrompt(item.prompt, item.attachments, item.displayText, item.skillNames, item.images, item.displayBlocks, sessionId);
  },

  reorderPromptQueue: (sessionId, newOrder) => {
    set((s) => {
      const prev = s.promptQueueBySession[sessionId];
      if (!prev || prev.length === 0) return {};
      const byId = new Map(prev.map((q) => [q.id, q]));
      const next: QueuedPrompt[] = [];
      const seen = new Set<string>();
      for (const id of newOrder) {
        const q = byId.get(id);
        if (q && !seen.has(id)) {
          next.push(q);
          seen.add(id);
        }
      }
      // Append any items not referenced in newOrder so nothing is lost.
      for (const q of prev) {
        if (!seen.has(q.id)) next.push(q);
      }
      return {
        promptQueueBySession: {
          ...s.promptQueueBySession,
          [sessionId]: next,
        },
      };
    });
  },

  /* ─────────────────── IDE right-panel actions ─────────────────── */

  setRightPanelTab: (tab) => {
    // First-time browser open: the sidebar browser defaults to the iPhone 14
    // Pro preset (393 CSS pt wide). If the right panel is narrower than that
    // (default 360), widen it so the mobile view renders at true device size
    // instead of being clamped by syncBounds to the narrow stage. Only on the
    // FIRST open (no tabs yet) and never shrinks an already-wider panel — the
    // user's manually-dragged width is respected from then on.
    if (tab === "browser") {
      const s = get();
      if (s.browserTabs.length === 0 && s.rightWidth < RIGHT_WIDTH_BROWSER_FIT) {
        set({ rightWidth: clampRightWidth(RIGHT_WIDTH_BROWSER_FIT) });
      }
    }
    set({ rightPanelTab: tab });
    void api.setting.set({ key: UI_RIGHT_PANEL_TAB_SETTING_KEY, value: tab }).catch((err) => {
      console.error("setting.set(rightPanelTab) failed:", err);
    });
  },

  openSideChatPanel: () => {
    set({ rightOpen: true });
    get().setRightPanelTab("sidechat");
    // Refresh the current main session's list if we have one (cheap; keeps
    // titles/status fresh after restarts or background changes).
    const parent = get().activeSessionId;
    if (parent) void get().hydrateSideChats(parent);
  },

  hydrateSideChats: async (parentSessionId) => {
    try {
      const { sessions } = await api.claude.listSideChats({ parentSessionId });
      set((s) => ({ sideChatsByParent: { ...s.sideChatsByParent, [parentSessionId]: sessions } }));
    } catch (err) {
      console.error("listSideChats failed:", err);
    }
  },

  createSideChat: async () => {
    const s = get();
    const parentSessionId = s.activeSessionId;
    if (!parentSessionId) return;
    // Same send-model guard as sendPrompt: "default" resolves to the first
    // configured model; nothing configured → raise the config dialog instead
    // of silently using the provider's internal default.
    const resolvedModel = resolveSendModel(s);
    if (!resolvedModel) {
      set({ modelConfigPromptOpen: true });
      return;
    }
    // The parent main session's row carries the owning projectId (FK is
    // NOT NULL); resolve it from the loaded caches.
    const parentRow =
      s.sessionsByProject[s.activeProjectId ?? ""]?.find((x) => x.id === parentSessionId) ??
      s.pinnedSessions.find((x) => x.id === parentSessionId);
    if (!parentRow) return;
    try {
      const { session } = await api.claude.startSession({
        projectId: parentRow.projectId,
        kind: "side",
        parentSessionId,
        providerId: s.providerId,
        model: resolvedModel.model !== "default" ? resolvedModel.model : undefined,
        effort: s.effort,
        permissionMode: s.permissionMode,
        customModelId: resolvedModel.customModelId,
      });
      set((st) => {
        const existing = st.sideChatsByParent[parentSessionId] ?? [];
        return {
          sideChatsByParent: {
            ...st.sideChatsByParent,
            // The main process reuses the parent's still-fresh "Quick ask"
            // shell when one exists — that row is already in the list, so it
            // updates in place (prepending would duplicate the React key and
            // teleport an old row to the top; the list is created_at-ordered
            // like the DB query behind hydrateSideChats). New rows land at
            // the front, matching listSideByParent's DESC order.
            [parentSessionId]: existing.some((x) => x.id === session.id)
              ? existing.map((x) => (x.id === session.id ? session : x))
              : [session, ...existing],
          },
          activeSideChatId: session.id,
          // Locally-created — or a reused shell, which by definition has no
          // messages (the first sent question rewrites the placeholder
          // title): empty bucket IS the full history (same as startSession).
          messagesBySession: { ...st.messagesBySession, [session.id]: [] },
          hasMoreMessagesBySession: { ...st.hasMoreMessagesBySession, [session.id]: false },
          historyLoadedBySession: { ...st.historyLoadedBySession, [session.id]: true },
        };
      });
    } catch (err) {
      console.error("createSideChat failed:", err);
    }
  },

  selectSideChat: async (sessionId) => {
    set({ activeSideChatId: sessionId });
    // Lazy-load persisted history (no-op when already hydrated / live).
    await get().prefetchSessionMessages(sessionId);
  },

  closeSideChatView: () => set({ activeSideChatId: null }),

  askInSideChat: async (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const parent = get().activeSessionId;
    if (!parent) return;
    // Ensure the active side chat belongs to the CURRENT parent — the user
    // may have switched main sessions since the last one was opened (a stale
    // activeSideChatId would route the quote into another thread).
    let target = get().activeSideChatId;
    const owned =
      !!target && (get().sideChatsByParent[parent] ?? []).some((s) => s.id === target);
    if (!owned) {
      await get().createSideChat();
      target = get().activeSideChatId;
      if (!target) return; // no model configured — config dialog is up
    }
    get().openSideChatPanel();
    set((s) => ({
      sideChatSeedBySession: { ...s.sideChatSeedBySession, [target as string]: trimmed },
    }));
  },

  drainSideChatSeed: (sessionId) => {
    set((s) => {
      if (!(sessionId in s.sideChatSeedBySession)) return {};
      const next = { ...s.sideChatSeedBySession };
      delete next[sessionId];
      return { sideChatSeedBySession: next };
    });
  },

  openSubagentTranscript: (sessionId, taskId) => {
    set({ pendingSubagentView: { sessionId, taskId }, rightOpen: true });
    get().setRightPanelTab("sidechat");
  },

  clearPendingSubagentView: () => {
    set({ pendingSubagentView: null });
  },

  setPendingBookmarkJump: (jump) => {
    set({ pendingBookmarkJump: jump });
  },

  clearPendingBookmarkJump: () => {
    set({ pendingBookmarkJump: null });
  },

  setCustomCommandsByProject: (projectId, commands) => {
    set((s) => ({
      customCommandsByProject: { ...s.customCommandsByProject, [projectId]: commands },
    }));
    void api.setting
      .set({ key: UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY, value: JSON.stringify(get().customCommandsByProject) })
      .catch((err) => console.error("setting.set(customCommandsByProject) failed:", err));
  },

  addCustomCommand: (projectId, cmd) => {
    const prev = get().customCommandsByProject[projectId] ?? [];
    const next: CustomCommand = { ...cmd, id: `cmd-${Date.now().toString(36)}` };
    get().setCustomCommandsByProject(projectId, [...prev, next]);
  },

  updateCustomCommand: (projectId, cmd) => {
    const prev = get().customCommandsByProject[projectId] ?? [];
    get().setCustomCommandsByProject(
      projectId,
      prev.map((c) => (c.id === cmd.id ? cmd : c)),
    );
  },

  removeCustomCommand: (projectId, id) => {
    const prev = get().customCommandsByProject[projectId] ?? [];
    get().setCustomCommandsByProject(
      projectId,
      prev.filter((c) => c.id !== id),
    );
  },

  openFileInIde: (filePath, opts) => {
    const pid = get().activeProjectId;
    if (!pid) return; // no active project - nothing to scope to
    const prev = get().ideOpenFilesByProject[pid] ?? [];
    const mode = get().ideEditorMode;
    // Normalize for case-insensitive dedup on Windows/macOS: if the file is
    // already open under a different case (e.g. LSP returns `d:\foo` but the
    // file tree stored `D:\foo`), reuse the existing path string so we don't
    // create a duplicate tab. On Linux paths are case-sensitive as-is.
    const lowerFile = filePath.toLowerCase();
    const existing = prev.find((p) => p.toLowerCase() === lowerFile);
    const canonicalPath = existing ?? filePath;
    // Navigation history: record the location being LEFT (goto-definition
    // invocation, chat link, file-tree open...) so Alt+← can come back to it.
    // Only meaningful navigation — switching to another file or an explicit
    // line reveal; re-opening the same file without a reveal doesn't move the
    // cursor and would only pollute the stack. History-driven reveals
    // (navigateBack/Forward) manage the stacks themselves.
    if (
      !navHistoryRevealing &&
      (opts?.line != null || canonicalPath !== (get().ideActiveFileByProject[pid] ?? null))
    ) {
      const outgoing = currentNavEntryFor(get);
      if (outgoing) get().pushNavHistory(outgoing);
    }
    // In "replace" mode, opening a file discards everything else - at most
    // one file is open at a time. In "tabs" mode, files accumulate (dedup:
    // re-opening an already-open file just activates it).
    const open =
      mode === "replace"
        ? [canonicalPath]
        : existing
          ? prev
          : [...prev, canonicalPath];
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode = { ...prevViewMode };
    // A review/diff request is an explicit intent -> force diff mode (don't
    // leave a stale "edit" the user may have toggled for a different purpose).
    if (opts?.diff) viewMode[canonicalPath] = "diff";
    // A line reveal (goto-definition / navigation history) targets source code
    // and is only consumed by the EditPane — force "edit" so a stale "diff"
    // or "preview" view-mode for this file doesn't swallow the reveal.
    else if (opts?.line != null) viewMode[canonicalPath] = "edit";
    // Files that render as a read-only preview default to "preview" on FIRST
    // open (no prior view-mode for this file): Markdown (rendered), images
    // (<img> via app-resource://), and unsupported binary types (Office docs,
    // archives, etc. - shown as a "can't preview" notice). Re-opening respects
    // the user's earlier choice (e.g. they switched to "edit") since the entry
    // already exists. A diff request above takes precedence over this default.
    else if (
      !(canonicalPath in prevViewMode) &&
      (isMarkdownPath(canonicalPath) || isImagePath(canonicalPath) || isUnsupportedPath(canonicalPath))
    ) {
      viewMode[canonicalPath] = "preview";
    }
    // A before-snapshot passed by a turn-files card (works for HISTORICAL
    // turns whose snapshot is gone from turnFilesByProject). Stashed
    // per-file so FileEditor can use it as the diff's left pane.
    const prevDiffBefore = get().ideDiffBeforeByProject[pid] ?? {};
    const diffBefore =
      opts?.diff && opts.before != null
        ? { ...prevDiffBefore, [canonicalPath]: opts.before }
        : prevDiffBefore;
    set((s) => ({
      ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
      ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: canonicalPath },
      ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
      ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
      // Bump the focus nonce so App opens the right panel if collapsed.
      ideFocusNonce: s.ideFocusNonce + 1,
      // Unified center bar (tabs displayMode): opening a file focuses the
      // editor so it gets the full center width. Gated on tabs mode — the
      // split layout in single mode ignores the flag, and keeping single
      // mode out of it makes a later mode switch land on the chat.
      ...(s.displayMode === "tabs" ? { centerTabFocus: "editor" as const } : {}),
      // If a line was requested (goto-definition), stash a reveal target +
      // bump the nonce so the EditPane scrolls to it once mounted/active.
      ...(opts?.line != null
        ? {
            idePendingReveal: {
              filePath: canonicalPath,
              line: opts.line,
              column: opts.column ?? 1,
            },
            ideRevealNonce: s.ideRevealNonce + 1,
          }
        : {}),
    }));
    persistIdeBuckets(get);
  },

  clearIdePendingReveal: () => {
    if (get().idePendingReveal) set({ idePendingReveal: null });
  },

  pushNavHistory: (entry) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const back = get().navBackByProject[pid] ?? [];
    // Dedup a consecutive identical entry (guards against double-pushes when
    // a provider and openFileInIde both try to record the same jump origin).
    const top = back[back.length - 1];
    if (top && sameNavEntry(top, entry)) return;
    set((s) => ({
      navBackByProject: { ...s.navBackByProject, [pid]: [...back, entry].slice(-NAV_HISTORY_CAP) },
      // Any new navigation invalidates the forward stack (standard back/forward semantics).
      navForwardByProject: { ...s.navForwardByProject, [pid]: [] },
    }));
  },

  navigateBack: () => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const back = get().navBackByProject[pid] ?? [];
    if (back.length === 0) return;
    const target = back[back.length - 1];
    // Snapshot the location being LEFT onto the forward stack so
    // navigateForward can return here (skip when it equals the target —
    // nothing visually changes).
    const cur = currentNavEntryFor(get);
    const prevForward = get().navForwardByProject[pid] ?? [];
    const forward =
      cur && !sameNavEntry(cur, target)
        ? [...prevForward, cur].slice(-NAV_HISTORY_CAP)
        : prevForward;
    set((s) => ({
      navBackByProject: { ...s.navBackByProject, [pid]: back.slice(0, -1) },
      navForwardByProject: { ...s.navForwardByProject, [pid]: forward },
    }));
    navHistoryRevealing = true;
    try {
      get().openFileInIde(target.filePath, { line: target.line, column: target.column });
    } finally {
      navHistoryRevealing = false;
    }
  },

  navigateForward: () => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const forward = get().navForwardByProject[pid] ?? [];
    if (forward.length === 0) return;
    const target = forward[forward.length - 1];
    // Mirror of navigateBack: push the location being left back onto the
    // back stack so the next Alt+← undoes this forward.
    const cur = currentNavEntryFor(get);
    const prevBack = get().navBackByProject[pid] ?? [];
    const back =
      cur && !sameNavEntry(cur, target)
        ? [...prevBack, cur].slice(-NAV_HISTORY_CAP)
        : prevBack;
    set((s) => ({
      navBackByProject: { ...s.navBackByProject, [pid]: back },
      navForwardByProject: { ...s.navForwardByProject, [pid]: forward.slice(0, -1) },
    }));
    navHistoryRevealing = true;
    try {
      get().openFileInIde(target.filePath, { line: target.line, column: target.column });
    } finally {
      navHistoryRevealing = false;
    }
  },

  closeFileInIde: (filePath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const prev = get().ideOpenFilesByProject[pid] ?? [];
    const idx = prev.indexOf(filePath);
    if (idx === -1) return; // not open — nothing to do
    const open = prev.filter((p) => p !== filePath);
    // Active shifts to the previous file (or next, or null).
    let active = get().ideActiveFileByProject[pid] ?? null;
    if (active === filePath) {
      active = open[idx - 1] ?? open[idx] ?? null;
    }
    // Clean up the per-file view mode for the closed file.
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode = { ...prevViewMode };
    delete viewMode[filePath];
    // Clean up the per-file before-snapshot override too.
    const prevDiffBefore = get().ideDiffBeforeByProject[pid] ?? {};
    const diffBefore = { ...prevDiffBefore };
    delete diffBefore[filePath];
    set((s) => {
      // Unified center bar: when the closed file was the last one and no
      // plan tab is active, fall back to the chat view.
      const sid = s.activeSessionId;
      const planActive = !!(sid && s.planTabActiveBySession[sid]);
      return {
        ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
        ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: active },
        ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
        ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
        centerTabFocus: active == null && !planActive ? ("chat" as const) : s.centerTabFocus,
      };
    });
    persistIdeBuckets(get);
  },

  closeFilesUnderDir: (dirPath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    // Prefix used to match descendants: a trailing separator so a dir "/a/b"
    // doesn't match siblings like "/a/bb/x" (the dir itself is never an open
    // file, so we only need the descendant form here).
    const prefix = dirPath.endsWith("/") ? dirPath : dirPath + "/";
    const prevOpen = get().ideOpenFilesByProject[pid] ?? [];
    const removed = new Set(prevOpen.filter((p) => p.startsWith(prefix)));
    if (removed.size === 0 && !(get().ideExpandedDirsByProject[pid] ?? []).some((d) => d.startsWith(prefix))) {
      // Nothing to close and no expanded dirs under it — still fall through to
      // the (possibly empty) expanded-dirs cleanup below, which is cheap.
    }
    const open = prevOpen.filter((p) => !removed.has(p));
    // Active shifts away if it was under the removed dir.
    let active = get().ideActiveFileByProject[pid] ?? null;
    if (active && removed.has(active)) {
      const idx = prevOpen.indexOf(active);
      active = open[idx - 1] ?? open[idx] ?? null;
    }
    // Clean up per-file view-mode + diff-before for the removed paths.
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode: Record<string, FileViewMode> = {};
    for (const [k, v] of Object.entries(prevViewMode)) {
      if (!removed.has(k)) viewMode[k] = v;
    }
    const prevDiffBefore = get().ideDiffBeforeByProject[pid] ?? {};
    const diffBefore: Record<string, string> = {};
    for (const [k, v] of Object.entries(prevDiffBefore)) {
      if (!removed.has(k)) diffBefore[k] = v;
    }
    // Drop expanded-dir records under the removed dir too.
    const prevExpanded = get().ideExpandedDirsByProject[pid] ?? [];
    const expanded = prevExpanded.filter((d) => d !== dirPath && !d.startsWith(prefix));
    set((s) => {
      // Same unified-bar fallback as closeFileInIde (see there).
      const sid = s.activeSessionId;
      const planActive = !!(sid && s.planTabActiveBySession[sid]);
      return {
        ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
        ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: active },
        ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
        ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
        ideExpandedDirsByProject: { ...s.ideExpandedDirsByProject, [pid]: expanded },
        centerTabFocus: active == null && !planActive ? ("chat" as const) : s.centerTabFocus,
      };
    });
    persistIdeBuckets(get);
  },

  renamePathInIde: (oldPath, newPath, isDir) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    if (isDir) {
      // Re-prefix every open file and expanded dir that lives under oldPath.
      const prefix = oldPath.endsWith("/") ? oldPath : oldPath + "/";
      const prevOpen = get().ideOpenFilesByProject[pid] ?? [];
      const hadDescendant = prevOpen.some((p) => p === oldPath || p.startsWith(prefix));
      const prevExpanded = get().ideExpandedDirsByProject[pid] ?? [];
      const hadExpanded = prevExpanded.some((d) => d === oldPath || d.startsWith(prefix));
      if (!hadDescendant && !hadExpanded) return; // nothing under it
      const open = prevOpen.map((p) => (p === oldPath ? newPath : p.startsWith(prefix) ? newPath + p.slice(oldPath.length) : p));
      let active = get().ideActiveFileByProject[pid] ?? null;
      if (active) {
        active = active === oldPath ? newPath : active.startsWith(prefix) ? newPath + active.slice(oldPath.length) : active;
      }
      const reKey = (obj: Record<string, FileViewMode> | Record<string, string>) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k === oldPath) out[newPath] = v as string;
          else if (k.startsWith(prefix)) out[newPath + k.slice(oldPath.length)] = v as string;
          else out[k] = v as string;
        }
        return out;
      };
      const viewMode = reKey(get().ideFileViewModeByProject[pid] ?? {}) as Record<string, FileViewMode>;
      const diffBefore = reKey(get().ideDiffBeforeByProject[pid] ?? {});
      const expanded = prevExpanded.map((d) => (d === oldPath ? newPath : d.startsWith(prefix) ? newPath + d.slice(oldPath.length) : d));
      set((s) => ({
        ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
        ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: active },
        ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
        ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
        ideExpandedDirsByProject: { ...s.ideExpandedDirsByProject, [pid]: expanded },
      }));
      persistIdeBuckets(get);
      return;
    }
    // Single file rename: rewrite the single path if it's open.
    const prevOpen = get().ideOpenFilesByProject[pid] ?? [];
    const idx = prevOpen.indexOf(oldPath);
    if (idx === -1) return;
    const open = prevOpen.slice();
    open[idx] = newPath;
    let active = get().ideActiveFileByProject[pid] ?? null;
    if (active === oldPath) active = newPath;
    const reKey = <V>(obj: Record<string, V>): Record<string, V> => {
      if (!(oldPath in obj)) return obj;
      const out: Record<string, V> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k === oldPath ? newPath : k] = v;
      }
      return out;
    };
    const viewMode = reKey(get().ideFileViewModeByProject[pid] ?? {});
    const diffBefore = reKey(get().ideDiffBeforeByProject[pid] ?? {});
    set((s) => ({
      ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
      ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: active },
      ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
      ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
    }));
    persistIdeBuckets(get);
  },

  closeOtherFilesInIde: (keepFilePath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const prev = get().ideOpenFilesByProject[pid] ?? [];
    if (!prev.includes(keepFilePath)) return;
    const open = [keepFilePath];
    // Clean up per-file view-mode + diff-before for the dropped paths.
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode: Record<string, FileViewMode> = {};
    if (keepFilePath in prevViewMode) viewMode[keepFilePath] = prevViewMode[keepFilePath];
    const prevDiffBefore = get().ideDiffBeforeByProject[pid] ?? {};
    const diffBefore: Record<string, string> = {};
    if (keepFilePath in prevDiffBefore) diffBefore[keepFilePath] = prevDiffBefore[keepFilePath];
    set((s) => ({
      ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
      ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: keepFilePath },
      ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
      ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
    }));
    persistIdeBuckets(get);
  },

  closeAllFilesInIde: () => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const prev = get().ideOpenFilesByProject[pid] ?? [];
    if (prev.length === 0) return;
    set((s) => {
      // Unified-bar fallback: no files left — the plan tab may still own the
      // editor view; otherwise return to the chat.
      const sid = s.activeSessionId;
      const planActive = !!(sid && s.planTabActiveBySession[sid]);
      return {
        ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: [] },
        ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: null },
        ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: {} },
        ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: {} },
        centerTabFocus: !planActive ? ("chat" as const) : s.centerTabFocus,
      };
    });
    persistIdeBuckets(get);
  },

  setIdeActiveFile: (filePath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    // Navigation history: switching the active file via a tab click records
    // where the user is leaving. Same-file activation (a re-click on the
    // current tab) moves nothing and must not pollute the stack; history-
    // driven reveals are excluded via the flag.
    if (
      !navHistoryRevealing &&
      filePath !== (get().ideActiveFileByProject[pid] ?? null)
    ) {
      const outgoing = currentNavEntryFor(get);
      if (outgoing) get().pushNavHistory(outgoing);
    }
    set((s) => ({
      ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: filePath },
      // Clicking a file tab (unified bar) focuses the editor view.
      ...(s.displayMode === "tabs" ? { centerTabFocus: "editor" as const } : {}),
    }));
    persistIdeBuckets(get);
  },

  clearIdeActiveFile: () => {
    const pid = get().activeProjectId;
    if (!pid) return;
    set((s) => ({
      ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: null },
      // Semantically a "hide the editor" move (titlebar toggle; the plan-tab
      // click overrides it right after by activating the plan tab). In tabs
      // displayMode this pulls the center back to the chat view.
      centerTabFocus: "chat",
    }));
    persistIdeBuckets(get);
  },

  /** Move an open file within the active project's editor tab strip.
   *  Mirrors `reorderTab` but scoped to ideOpenFilesByProject. */
  reorderIdeFile: (from, to) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const open = get().ideOpenFilesByProject[pid] ?? [];
    if (
      from === to ||
      from < 0 ||
      from >= open.length ||
      to < 0 ||
      to >= open.length
    ) {
      return;
    }
    const next = [...open];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set((s) => ({
      ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: next },
    }));
    persistIdeBuckets(get);
  },

  setIdeFileViewMode: (filePath, mode) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode = { ...prevViewMode, [filePath]: mode };
    set((s) => ({
      ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
    }));
    // Not persisted (view mode is ephemeral — see the field doc).
  },

  setIdeEditorMode: (mode) => {
    // When switching to "replace", collapse the ACTIVE project's open-file
    // list to just the active file (if any) so the invariant "≤1 file open"
    // holds immediately for the project the user is looking at.
    if (mode === "replace") {
      const pid = get().activeProjectId;
      if (pid) {
        const active = get().ideActiveFileByProject[pid] ?? null;
        const open = active ? [active] : [];
        set((s) => ({
          ideEditorMode: mode,
          ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
        }));
        persistIdeBuckets(get);
      } else {
        set({ ideEditorMode: mode });
      }
    } else {
      set({ ideEditorMode: mode });
    }
    void api.setting
      .set({ key: UI_IDE_EDITOR_MODE_SETTING_KEY, value: mode })
      .catch((err) => console.error("setting.set(ideEditorMode) failed:", err));
  },

  setGitDiffOpenMode: (mode) => {
    set({ gitDiffOpenMode: mode });
    void api.setting
      .set({ key: UI_GIT_DIFF_OPEN_MODE_SETTING_KEY, value: mode })
      .catch((err) => console.error("setting.set(gitDiffOpenMode) failed:", err));
  },

  openGitDiffDialogTab: (tab) => {
    set((s) => {
      // Dedup by file path: re-clicking the same file refreshes its snapshot
      // and moves it to the end (most-recent) rather than opening a duplicate.
      const existing = s.gitDiffDialogTabs.find((t) => t.id === tab.id);
      const tabs = existing
        ? s.gitDiffDialogTabs.map((t) => (t.id === tab.id ? { ...t, ...tab } : t))
        : [...s.gitDiffDialogTabs, tab];
      return {
        gitDiffDialogTabs: tabs,
        gitDiffDialogActiveId: tab.id,
        // Opening a tab always surfaces the dialog.
        gitDiffDialogOpen: true,
      };
    });
  },

  closeGitDiffDialogTab: (id) => {
    set((s) => {
      const idx = s.gitDiffDialogTabs.findIndex((t) => t.id === id);
      if (idx === -1) return {};
      const tabs = s.gitDiffDialogTabs.filter((t) => t.id !== id);
      // If the closed tab was active, shift to an adjacent one (prefer the
      // previous; otherwise the next; otherwise none).
      let activeId = s.gitDiffDialogActiveId;
      let open = s.gitDiffDialogOpen;
      if (activeId === id) {
        activeId = tabs[idx - 1]?.id ?? tabs[idx]?.id ?? null;
        // No tabs left -> close the dialog too.
        open = tabs.length > 0;
      }
      return { gitDiffDialogTabs: tabs, gitDiffDialogActiveId: activeId, gitDiffDialogOpen: open };
    });
  },

  setGitDiffDialogActive: (id) => {
    set({ gitDiffDialogActiveId: id });
  },

  setGitDiffDialogOpen: (open) => {
    set({ gitDiffDialogOpen: open });
  },

  setGitDiffDialogViewMode: (mode) => {
    set({ gitDiffDialogViewMode: mode });
  },

  toggleDirExpanded: (dirPath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const prev = get().ideExpandedDirsByProject[pid] ?? [];
    const open = prev.includes(dirPath) ? prev.filter((p) => p !== dirPath) : [...prev, dirPath];
    set((s) => ({
      ideExpandedDirsByProject: { ...s.ideExpandedDirsByProject, [pid]: open },
    }));
    persistIdeBuckets(get);
  },

  setDirExpanded: (dirPath, open) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const prev = get().ideExpandedDirsByProject[pid] ?? [];
    const has = prev.includes(dirPath);
    let next: string[];
    if (open && !has) next = [...prev, dirPath];
    else if (!open && has) next = prev.filter((p) => p !== dirPath);
    else return; // already in the desired state
    set((s) => ({
      ideExpandedDirsByProject: { ...s.ideExpandedDirsByProject, [pid]: next },
    }));
    persistIdeBuckets(get);
  },

  saveFileContent: async (filePath, content) => {
    try {
      const { ok } = await api.file.writeFile({ filePath, content });
      return ok;
    } catch (err) {
      console.error("file.writeFile failed:", err);
      return false;
    }
  },

  setGitDiffBefore: (filePath, before) => {
    get().setGitDiffPair(filePath, { before });
  },

  setGitDiffPair: (filePath, pair) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    set((s) => ({
      gitDiffByProject: {
        ...s.gitDiffByProject,
        [pid]: { ...(s.gitDiffByProject[pid] ?? {}), [filePath]: pair },
      },
    }));
  },

  clearGitDiffBefore: (filePath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    set((s) => {
      const projMap = s.gitDiffByProject[pid];
      if (!projMap || !(filePath in projMap)) return {};
      const next = { ...projMap };
      delete next[filePath];
      return { gitDiffByProject: { ...s.gitDiffByProject, [pid]: next } };
    });
  },

  setCommitGenModel: (modelId) => {
    set({ commitGenModel: modelId });
    void api.setting
      .set({ key: UI_COMMIT_GEN_MODEL_SETTING_KEY, value: modelId ?? "" })
      .catch((err) => console.error("setting.set(commitGenModel) failed:", err));
  },

  setCommitGenPrompt: (prompt) => {
    set({ commitGenPrompt: prompt });
    void api.setting
      .set({ key: UI_COMMIT_GEN_PROMPT_SETTING_KEY, value: prompt })
      .catch((err) => console.error("setting.set(commitGenPrompt) failed:", err));
  },

  setConflictResolveModel: (modelId) => {
    set({ conflictResolveModel: modelId });
    void api.setting
      .set({ key: UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY, value: modelId ?? "" })
      .catch((err) => console.error("setting.set(conflictResolveModel) failed:", err));
  },

  setTitleGenEnabled: (enabled) => {
    set({ titleGenEnabled: enabled });
    void api.setting
      .set({ key: UI_TITLE_GEN_ENABLED_SETTING_KEY, value: enabled ? "on" : "off" })
      .catch((err) => console.error("setting.set(titleGenEnabled) failed:", err));
  },

  setTitleGenModel: (modelId) => {
    set({ titleGenModel: modelId });
    void api.setting
      .set({ key: UI_TITLE_GEN_MODEL_SETTING_KEY, value: modelId ?? "" })
      .catch((err) => console.error("setting.set(titleGenModel) failed:", err));
  },

  setOutputStyle: (style) => {
    set({ outputStyle: style });
    void api.setting
      .set({ key: AGENT_OUTPUT_STYLE_SETTING_KEY, value: style ?? "" })
      .catch((err) => console.error("setting.set(outputStyle) failed:", err));
  },

  toggleCollapsedGitRepo: (repoPath) => {
    set((s) => {
      const next = { ...s.collapsedGitRepos };
      if (next[repoPath]) {
        delete next[repoPath]; // remove key when expanding
      } else {
        next[repoPath] = true;
      }
      void api.setting
        .set({ key: UI_GIT_COLLAPSED_REPOS_SETTING_KEY, value: JSON.stringify(next) })
        .catch((err) => console.error("setting.set(gitCollapsedRepos) failed:", err));
      return { collapsedGitRepos: next };
    });
  },
}));

// Stable empty arrays (e.g. EMPTY_MESSAGES, EMPTY_TODOS) are exported
// directly at their declaration site (see the "Stable empty arrays" block
// above) so they can be imported individually without a re-export step.
