import { useState, useRef, useEffect, useMemo, memo, useCallback } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconPlayerStop,
  IconSend2,
  IconChevronDown,
  IconArrowDown,
  IconAlertTriangle,
  IconSettings,
  IconArrowRight,
  IconCopy,
  IconCheck,
  IconLoader2,
  IconPaperclip,
  IconX,
  IconPencil,
  IconBolt,
  IconChevronRight,
  IconGripVertical,
} from "@renderer/lib/icons.js";
import { useSessionStore, EMPTY_MESSAGES, EMPTY_TODOS, EMPTY_SUBAGENTS, EMPTY_CHAT_QUEUE, EMPTY_ELEMENT_QUEUE, EMPTY_PROMPT_QUEUE, EMPTY_BOOKMARKS, type Block, type ChatMessage, type TodoItem, type TurnMeta, type QueuedPrompt } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { api } from "@renderer/lib/api.js";
import { findNormalizedTextRange, highlightRange } from "@renderer/lib/textFind.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useNow } from "@renderer/hooks/useNow.js";
import { useComposerRowFit } from "@renderer/hooks/useComposerRowFit.js";
import type { SubagentSnapshot } from "@contracts/runtime";
import type { SessionBookmark } from "@contracts/session";
import type { FileSearchEntry } from "@contracts/ipc";
import { prepareImageForSend } from "@renderer/lib/imageResize.js";
import type { PromptImage } from "@renderer/stores/sessionStore.js";
import {
  type ContentTag,
  appendUniqueFileTags,
  composePromptWithTags,
  makeContentTag,
  makeFileTag,
  makeElementTag,
  shouldPromoteToTag,
  FILE_DRAG_MIME,
} from "@renderer/lib/contentTag.js";
import type { SkillInfo, BuiltInCommand } from "@renderer/lib/slashCommands.js";
import { MessageBlocks, TurnPanel, type ProceduralBlock, type BeforeContentMap } from "./MessageBlocks.js";
import { AttachMenuButton } from "./AttachMenuButton.js";
import { MicButton } from "./MicButton.js";
import { ComposerToolbar } from "./ComposerToolbar.js";
import { ComposerToolbarToggle } from "./ComposerToolbarToggle.js";
import { ProviderDropdown } from "./ProviderDropdown.js";
import { QuestionPrompt } from "./QuestionPrompt.js";
import { ApprovalPrompt } from "./ApprovalPrompt.js";
import { PlanApprovalPrompt } from "./PlanApprovalPrompt.js";
import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor.js";
import { ContentTagChip } from "./ContentTagChip.js";
import { TagPopover } from "./TagPopover.js";
import { FileMentionPicker, type FileMentionPickerMode } from "./FileMentionPicker.js";
import { EmptyThreadWelcome } from "./EmptyThreadWelcome.js";
import { SlashCommandPicker } from "./SlashCommandPicker.js";
import { StatusCapsule } from "./StatusCapsule.js";
import { MessageTimeline, type UserItemIndexMap } from "./MessageTimeline.js";
import { SelectionToolbar, type SelectionToolbarState } from "./SelectionToolbar.js";
import { BookmarkFly } from "./BookmarkFly.js";
import { LegendList, type LegendListRef } from "@legendapp/list/react";

/**
 * Center pane: message stream + input box for a SINGLE session.
 *
 * The component receives its target sessionId as a prop so the same
 * instance type can be reused under different render strategies
 * (currently the active session only, but the signature is ready for
 * multiple simultaneous mounts if we ever want to keep hidden tabs
 * alive). All per-session state is read by keying into the store's
 * per-session buckets with this prop — no `activeSessionId` lookups
 * inside the component, so the running turn / composer / scroll
 * position are all 100% bound to this sessionId.
 */

/** 第一条消息与顶部(标签条 / 标题栏)之间的留白。作为滚动内容的顶部
 *  padding,停在顶部时可见,向下滚动后随内容滚走。 */
const MESSAGE_LIST_TOP_PADDING = 10;

/** Picker trigger chars → picker kind. CJK soft keyboards often emit
 *  full-width variants (／ U+FF0F, ＠ U+FF20) for the slash/at keys, so
 *  both forms trigger; the full-width char itself lands inside the replaced
 *  token range and is swallowed by the inserted pill. */
const TRIGGER_CHARS: Record<string, "mention" | "slash"> = {
  "@": "mention",
  "＠": "mention",
  "/": "slash",
  "／": "slash",
};

/** Uint8Array → base64. Chunked so large pasted files don't blow the call
 *  stack (String.fromCharCode spread is limited to ~32K args per call). */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** A staged (not-yet-sent) user image in the composer. Held as a full data
 *  URL so the thumbnail chip renders without an extra read; normalized to a
 *  sendable PromptImage by prepareImageForSend at send time. */
interface PendingImage {
  id: string;
  name: string;
  dataUrl: string;
}

/** Ceiling for staged images (matches the SendTurn contract's max 20). */
const MAX_PENDING_IMAGES = 20;

/** Stable empty reference for the timeline's bookmark items (memo stability —
 *  never return a fresh [] from the derivation when there's nothing to show). */
const EMPTY_BOOKMARK_TIMELINE: {
  bookmarkId: string;
  message: ChatMessage;
  index: number;
  excerpt: string;
  title: string | null;
}[] = [];

/** Nearest scrollable ancestor of `el` below (and excluding) `stopAt` —
 *  i.e. the virtual list's own scroll container. Jump centering targets THIS
 *  element only: a bare scrollIntoView also scrolls every scrollable
 *  ancestor (app shell panes), which can leave the row visually off even
 *  though "something" scrolled. */
function findScrollParent(el: Element, stopAt: Element): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur && cur !== stopAt) {
    const oy = getComputedStyle(cur).overflowY;
    if ((oy === "auto" || oy === "scroll") && cur.scrollHeight > cur.clientHeight + 4) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/** Preserve a user-typed message's single line breaks when rendering through
 *  Markdown: a lone "\n" is a soft break that markdown collapses to a space,
 *  so every newline that is NOT part of a blank-line gap ("\n\n") becomes a
 *  hard break ("  \n"). Purely a display transform — the stored text and the
 *  copy/edit flows keep the raw "\n". */
function preserveUserLineBreaks(text: string): string {
  return text.replace(/\n(?!\n)/g, "  \n");
}

/** Distance from the bottom (px) under which the list is considered "at the
 *  bottom" - the jump-to-bottom button is hidden, and new content auto-follows.
 *  The button appears once the user scrolls more than this far below the
 *  latest content, i.e. as soon as they scroll up past one screenful. */
const NEAR_BOTTOM_THRESHOLD = 80;

/** Pixel distance from the top of the scroll surface that triggers loading
 *  one page of older messages. A couple of rows is enough — the fetch is
 *  async and the store dedupes concurrent calls. */
const NEAR_TOP_THRESHOLD = 120;

/** Format a wall-clock ms timestamp as HH:MM:SS (local time). */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format a wall-clock ms timestamp as a full local date-time string
 *  "YYYY-MM-DD HH:MM:SS". Used for the user-bubble hover tooltip so the user
 *  can see exactly when a prompt was sent. */
function fmtFullDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format a duration (ms) as a compact human string:
 *  < 1s → "<1s", < 60s → "12.3s", < 60m → "1m 23s", else → "1h 05m". */
function fmtDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${String(mm).padStart(2, "0")}m`;
}

/** Per-turn stat row shown ABOVE the first assistant message of a turn:
 *  "开始 14:32:05 · 用时 12.3s". While the turn is still streaming
 *  (turnMeta.endedAt undefined) the duration ticks live; once the turn ends it
 *  freezes at its final value.
 *
 *  IMPORTANT: the live duration is driven by `useNow` (a single app-wide
 *  1s interval shared via useSyncExternalStore), NOT a component-local
 *  setInterval. This component renders inside a LegendList virtualized item,
 *  and during streaming the list recycles/remounts its containers on nearly
 *  every delta flush. A local setInterval would be torn down by each remount's
 *  cleanup before its first 1000ms tick ever fires - leaving the duration
 *  stuck at "<1s" for the whole turn. The global clock survives remounts.
 *  Rendered as a centered pill (timestamp + duration) flanked by gradient
 *  rules so it reads as a distinct turn-separator between the user prompt
 *  and the assistant reply. A live (running) turn shows the equalizer glyph
 *  (.live-eq, shared with TurnPanel's header pill) inside the pill. */
function TurnStatRow({ meta }: { meta: TurnMeta }) {
  // Only subscribe to the global ticker while the turn is still running -
  // frozen turns compute a static duration and pay nothing.
  const now = useNow();
  const end = meta.endedAt ?? now;
  const duration = Math.max(0, end - meta.startedAt);
  const live = meta.endedAt === undefined;

  return (
    <div className="my-3 flex items-center gap-2.5">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent to-edge" />
      <div className="flex items-center gap-1.5 rounded-full border border-edge bg-surface-muted px-3 py-1 text-xs shadow-sm">
        {live && (
          <span className="live-eq shrink-0" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        )}
        <span className="tabular-nums text-content-muted">{fmtClock(meta.startedAt)}</span>
        <span className="text-content-subtle">·</span>
        <span className="tabular-nums text-content-muted">{fmtDuration(duration)}</span>
      </div>
      <div className="h-px flex-1 bg-gradient-to-l from-transparent to-edge" />
    </div>
  );
}

/** Whether a block is "procedural" (model process: thinking / tool calls) —
 *  the surface that gets hidden inside a TurnPanel — vs "display" (text /
 *  plan / turn-files / error / attachment) which stays visible to the user.
 *  NOTE: this predicate describes PANEL MEMBERSHIP, not the process/reply
 *  boundary — the boundary anchors only on real tool calls (see
 *  groupMessagesForRender); a post-tool thinking block must not swallow the
 *  reply text that preceded it. */
function isProceduralBlock(b: Block): b is ProceduralBlock {
  return b.kind === "thinking" || b.kind === "tool_use";
}

/** Meta / bookkeeping tools update the model's own task list. They get invoked
 *  any time the model ticks a todo item — frequently as the LAST action of a
 *  turn, right as it finishes writing its answer — so they must not anchor the
 *  process/reply split (see groupMessagesForRender): treating TaskUpdate as the
 *  boundary would fold everything before it, often the bulk of the reply, into
 *  the hidden TurnPanel and leave only the text after it visible. They still
 *  belong to the process surface, so they're routed into the panel explicitly. */
const META_TOOL_NAMES = new Set(["TaskUpdate", "TaskCreate", "TodoWrite"]);

function isMetaToolBlock(b: Block): boolean {
  return b.kind === "tool_use" && META_TOOL_NAMES.has(b.toolName);
}

/** Render item after turn-level grouping. A `turnGroup` bundles a whole
 *  turn: its process blocks (hidden behind a TurnPanel header) plus any
 *  reply text that should stay visible below the panel. The precomputed
 *  isStreamingTail / isTurnTail flags carry per-message semantics into the
 *  grouped dimension:
 *  - isStreamingTail: this item is the live streaming end of the running turn.
 *  - isTurnTail: this item is the LAST assistant item of a COMPLETED turn
 *    (the turn ended, and the next item is a user message or the stream end).
 *    Drives the copy button - we only show copy on a finished turn's final
 *    assistant message, not on every intermediate assistant message. */
type RenderItem =
  | {
      kind: "single";
      msg: ChatMessage;
      isStreamingTail: boolean;
      isTurnTail: boolean;
    }
  | {
      kind: "turnGroup";
      /** The turn's process surface, in order: thinking, tool calls, AND any
       *  text the model emitted between tools (e.g. "let me read this first").
       *  Everything up to and including the LAST tool call goes here, plus
       *  thinking blocks wherever they land (they never anchor the split).
       *  Fed to TurnPanel (hidden behind the header). Empty for turns with
       *  neither tools nor thinking. */
      panelBlocks: Block[];
      /** Messages carrying the turn's DISPLAY blocks — only what comes AFTER
       *  the last tool call (the final reply text, plus plan / turn-files /
       *  error / attachment). Rendered below the panel, always visible.
       *  Empty for pure-tool turns (plan mode, interrupts). */
      textMsgs: ChatMessage[];
      turnMeta?: TurnMeta;
      isStreamingTail: boolean;
      isTurnTail: boolean;
    }
  | {
      // Synthesized turn-separator pill shown between send and the first
      // assistant content block. Not a real message - it's derived in
      // groupMessagesForRender from runningTurnStartedAt so the user sees
      // immediate running feedback (the pill carries its own accent pulse
      // dot while live) before any token lands. Disappears the moment a
      // real assistant turnMeta appears.
      kind: "pendingTurn";
      turnMeta: TurnMeta;
    };

/** Whether the assistant message at index `i` is the tail of a COMPLETED turn:
 *  the turn is not still running (either because a later user message started
 *  a new turn, or because the stream ended and isRunning is false), AND the
 *  next message is not another assistant message of the same turn. In
 *  practice: it's an assistant message followed by a user message, or the
 *  last assistant message when no turn is running. */
function isCompletedTurnTail(
  messages: ChatMessage[],
  i: number,
  isRunning: boolean,
): boolean {
  const m = messages[i];
  if (!m || m.role !== "assistant") return false;
  // If this is the very last message, the turn is completed only when nothing
  // is running.
  if (i === messages.length - 1) return !isRunning;
  // Otherwise the turn is completed when the next message starts a new turn
  // (a user prompt) - the assistant run that ended here is finalized.
  const next = messages[i + 1];
  return next?.role === "user";
}

/** Pull every per-turn "footer card" block out of the given messages and
 *  return them separately. Two kinds qualify:
 *   - `turn-files` ("本轮修改了 N 个文件") — strictly a per-turn summary footer
 *     and must ALWAYS render as the turn's LAST visible item, after all the
 *     model's reply text;
 *   - `plan` (approved plan card) — belongs at the turn's end too, ABOVE the
 *     turn-files card ("本轮修改" sits below the plan), and still at the very
 *     bottom when the turn has no modified-files card.
 *
 *  The store attaches these blocks to whatever assistant message was current
 *  at the time their events landed (array-last at turn.files / the trailing
 *  open-turn message at plan.update), but a turn's reply can span multiple
 *  assistant messages and a carrying message may also hold earlier reply text
 *  or tool calls. A plan block in particular almost always sits BEFORE the
 *  last tool call in the timeline (plan mode = research → plan → execute), so
 *  without extraction it would fold into the process panel and vanish. This
 *  helper is the single source of truth for the extraction: the completed-turn
 *  branch and the orphan branch call it, so both cards stay pinned to the
 *  turn's end in the FROZEN (post-turn) view regardless of event ordering.
 *  The LIVE streaming branch deliberately does NOT call it — footer cards stay
 *  inline on their host message while the turn runs (see the isStreamingTail
 *  branch below for why). Returns the cleaned messages (dropping any left
 *  empty by the extraction) plus the extracted blocks in their original order,
 *  plans and files kept separate so callers can order plan → files. Pure — no
 *  mutation of the input array. */
function extractFooterBlocks(msgs: ChatMessage[]): {
  cleaned: ChatMessage[];
  plans: Block[];
  files: Block[];
} {
  const plans: Block[] = [];
  const files: Block[] = [];
  const cleaned = msgs
    .map((msg) => {
      const planBlocks = msg.blocks.filter((b) => b.kind === "plan");
      const fileBlocks = msg.blocks.filter((b) => b.kind === "turn-files");
      if (planBlocks.length === 0 && fileBlocks.length === 0) return msg;
      plans.push(...planBlocks);
      files.push(...fileBlocks);
      return {
        ...msg,
        blocks: msg.blocks.filter((b) => b.kind !== "plan" && b.kind !== "turn-files"),
      };
    })
    .filter((msg) => msg.blocks.length > 0); // drop messages left empty by the extraction
  return { cleaned, plans, files };
}

/** Group the raw message stream into render items at the TURN level. Every
 *  assistant message belonging to one turn (from the turn-opener carrying
 *  `turnMeta` up to the next turn-opener or a user message) is merged into a
 *  single `turnGroup`: all thinking/tool_use blocks fold into the TurnPanel
 *  (process, hidden by default), while text/plan/turn-files reply blocks stay
 *  visible below it.
 *
 *  Turn boundaries follow the same heuristic the store uses: a message that
 *  carries a fresh `turnMeta` (the opener) starts a new turn. Pure function
 *  over the message list — no store mutation. */
function groupMessagesForRender(
  messages: ChatMessage[],
  isRunning: boolean,
  /** Send-time anchor (runningTurnStartedAt[sid]) used to synthesize a
   *  pendingTurn row before the first assistant block arrives. Undefined
   *  when no turn is in flight or the anchor wasn't stamped. */
  runningTurnStartedAt?: number,
): RenderItem[] {
  const items: RenderItem[] = [];

  // Per-turn accumulator: the turn's blocks in arrival order, each tagged
  // with its source message. We keep the full timeline (procedural + text)
  // and only decide the process/reply split at flush time — once we know
  // where the LAST tool call landed. Everything up to and including that
  // last tool (and any text woven between tools) is process → panel;
  // anything after it is the final reply → visible below the panel.
  type TimedBlock = { block: Block; msg: ChatMessage };
  let turnBlocks: TimedBlock[] = [];
  let turnMeta: TurnMeta | undefined;
  /** Index (into `messages`) of the last raw message added to the open turn
   *  — used to derive isStreamingTail / isTurnTail. */
  let lastTurnMsgIndex = -1;
  let hasOpenTurn = false;

  const flush = () => {
    if (!hasOpenTurn) return;
    const lastMsg = messages[lastTurnMsgIndex];
    const isStreamingTail =
      isRunning && !!lastMsg && lastMsg.role === "assistant" && lastTurnMsgIndex === messages.length - 1;
    const isTurnTail =
      !!lastMsg && lastMsg.role === "assistant" && isCompletedTurnTail(messages, lastTurnMsgIndex, isRunning);

    // LIVE turn → flat output. While the turn is still streaming we do NOT
    // group its messages into a turnGroup — the user watches the RAW stream
    // in arrival order (narration text, tool cards, reply text all inline),
    // and the process/result split is applied only once the turn completes
    // (the regroup below folds the process into the panel and leaves the
    // post-last-tool reply visible). A narration text and its tool_use also
    // arrive as SEPARATE events (claude sends text and tool_use as
    // independent assistant messages; the tool attaches to the narration
    // message only when its tool.use lands), so grouping during streaming
    // would briefly classify the narration as the final reply (it sits after
    // the previous tool), then yank it back into the panel when its tool
    // arrives — a visible flicker. Emit every message of the live turn as
    // its own single item instead; each message's own MessageBlocks still
    // folds consecutive batch tools into one card.
    if (isStreamingTail) {
      // Each live message carries its OWN blocks verbatim — plan and
      // turn-files blocks included. The footer cards are NOT extracted to
      // the stream's end here: re-pinning a live plan card to the bottom
      // meant every newly streamed message landed ABOVE it, pushing it
      // further down while maintainScrollAtEnd kept re-snapping scroll to
      // the moving end — the card visibly jumped on each delta ("闪烁"),
      // especially during post-approval execution and plan revision, where
      // output keeps flowing long after the card appeared. Keeping the card
      // inline on its host message gives it a stable position: new content
      // appends BELOW it and scrolls past naturally. When the turn
      // completes, the branch below re-runs the footer extraction and pins
      // the frozen cards to the turn's end in one coherent re-layout (the
      // turn collapses into a panel at that moment anyway).
      const byMsg = new Map<ChatMessage, Block[]>();
      for (const { block, msg } of turnBlocks) {
        const arr = byMsg.get(msg);
        if (arr) arr.push(block);
        else byMsg.set(msg, [block]);
      }
      const streamingTailId = lastMsg?.id;
      for (const [msg, blocks] of byMsg) {
        items.push({
          kind: "single",
          msg: { ...msg, blocks },
          isStreamingTail: msg.id === streamingTailId,
          isTurnTail: false,
        });
      }
      turnBlocks = [];
      turnMeta = undefined;
      lastTurnMsgIndex = -1;
      hasOpenTurn = false;
      return;
    }

    // Find the index of the LAST real TOOL CALL (excluding meta tools) — the
    // process/reply boundary. Everything at or before it is "process" —
    // including any text the model wove between tool calls ("let me read
    // this first", "tests passed, now…"). Thinking blocks deliberately do
    // NOT anchor the boundary: with interleaved thinking the model can emit
    // text → think → more text as ONE final answer, and anchoring on the
    // thinking block would fold the earlier segment into the panel, leaving
    // only the last segment as the visible reply. Thinking (and meta tools)
    // are instead re-routed into the panel wherever they land, so EVERY
    // post-tool text segment stays in the reply.
    let lastToolIdx = -1;
    for (let j = 0; j < turnBlocks.length; j++) {
      if (turnBlocks[j].block.kind === "tool_use" && !isMetaToolBlock(turnBlocks[j].block)) {
        lastToolIdx = j;
      }
    }

    let panelBlocks: Block[] = [];
    const textMsgs: ChatMessage[] = [];

    // Completed turn (isStreamingTail false): every tool is attached by now,
    // so narration text sits before the last tool (inside the panel) and the
    // true final reply after it (outside). Pure-text turns have no procedural
    // block at all and render as plain messages.
    const replyByMsg = new Map<ChatMessage, Block[]>();
    for (let j = 0; j < turnBlocks.length; j++) {
      const { block, msg } = turnBlocks[j];
      // Process surface: blocks at-or-before the last real tool (procedural +
      // woven text), plus any thinking / meta-tool blocks wherever they
      // landed — those never anchor the boundary but must not leak into the
      // reply, so re-route them here: a mid-answer thinking pause or a
      // trailing task-list update stays in the panel while the text around
      // it remains visible.
      if (j <= lastToolIdx || isProceduralBlock(block)) {
        panelBlocks.push(block);
      } else {
        // Reply surface: blocks after the last real tool, regrouped by source
        // message so each textMsg renders with its original identity (id, role).
        const arr = replyByMsg.get(msg);
        if (arr) arr.push(block);
        else replyByMsg.set(msg, [block]);
      }
    }
    for (const [msg, blocks] of replyByMsg) {
      textMsgs.push({ ...msg, blocks });
    }

    // Pull approved plan cards out of the PROCESS surface. A plan block almost
    // always sits BEFORE the last tool call in the timeline (plan mode =
    // research tools → EnterPlanMode → ExitPlanMode → execution tools), so the
    // slice above folds it into panelBlocks — hidden behind the collapsed
    // panel. The approved plan card must stay visible: extract it here and
    // re-emit it below the reply, above the modified-files card.
    const panelPlans: Block[] = [];
    if (panelBlocks.some((b) => b.kind === "plan")) {
      panelPlans.push(...panelBlocks.filter((b) => b.kind === "plan"));
      panelBlocks = panelBlocks.filter((b) => b.kind !== "plan");
    }

    // Pull the "本轮修改了 N 个文件" turn-files card out of the PROCESS
    // surface. turn.files is emitted at the very end of the turn (flushFinal)
    // and attached to the current turn's trailing assistant message. When that
    // message ALSO carries the turn's LAST tool_use (pure-tool turns, or a
    // turn whose only text precedes the last edit), the slice above folds the
    // turn-files block into panelBlocks — hiding it behind the collapsed
    // TurnPanel ("开始用时" surface). Rescue it here (mirroring the plan +
    // image rescues below) so the footer extraction picks it up and pins it
    // to the turn's end. Without this, the card would intermittently appear
    // inside the panel instead of at the turn's bottom.
    const panelTurnFiles: Block[] = [];
    if (panelBlocks.some((b) => b.kind === "turn-files")) {
      panelTurnFiles.push(...panelBlocks.filter((b) => b.kind === "turn-files"));
      panelBlocks = panelBlocks.filter((b) => b.kind !== "turn-files");
    }

    // Pull ALL screenshot image blocks out of the PROCESS surface too. Images
    // are user-facing RESULTS, not process: they're attached right after their
    // tool_use (which sits inside the panel), so the slice above would fold
    // them behind the collapsed TurnPanel and the user would never see the
    // screenshots. Extract every image (from both panelBlocks and the reply
    // textMsgs, in case one landed after the last tool) into a single
    // gallery, re-emitted as one trailing message — the render layer's
    // groupBlocks merges consecutive image blocks into a swipeable gallery.
    const panelImages: Extract<Block, { kind: "image" }>[] = [];
    if (panelBlocks.some((b) => b.kind === "image")) {
      panelImages.push(...(panelBlocks.filter((b) => b.kind === "image") as Extract<Block, { kind: "image" }>[]));
      panelBlocks = panelBlocks.filter((b) => b.kind !== "image");
    }
    // Images that landed after the last tool (rare, but possible when a
    // screenshot is the very last action) sit in textMsgs; sweep them out of
    // their host message and into the gallery.
    if (textMsgs.some((m) => m.blocks.some((b) => b.kind === "image"))) {
      const swept: ChatMessage[] = [];
      for (const m of textMsgs) {
        const imgs = m.blocks.filter((b) => b.kind === "image") as Extract<Block, { kind: "image" }>[];
        if (imgs.length > 0) {
          panelImages.push(...imgs);
          const rest = m.blocks.filter((b) => b.kind !== "image");
          if (rest.length > 0) swept.push({ ...m, blocks: rest });
        } else {
          swept.push(m);
        }
      }
      textMsgs.length = 0;
      textMsgs.push(...swept);
    }

    // Per-turn footer cards (plan + turn-files) must ALWAYS render at the very
    // end of the visible reply: the plan card above, the "本轮修改了 N 个文件"
    // card below it. The store attaches them to whatever assistant message was
    // current when their events landed (the array-last one at turn.files, the
    // trailing open-turn message at plan.update), but a turn's reply can span
    // multiple assistant messages, and the textMsgs order follows each
    // message's FIRST reply-block position in the timeline. So if a carrying
    // message also holds earlier reply text, its card would end up above
    // subsequent reply text ("card in the middle").
    //
    // Enforce the invariant at the render boundary: extractFooterBlocks pulls
    // every plan/turn-files block out of its host message; here we re-emit the
    // extracted cards as standalone trailing textMsgs in the order plan → files.
    // (Errors / compact-summary blocks are NOT moved - only plan and turn-files,
    // which are strictly per-turn footers.) The same helper runs in the LIVE
    // branch so the cards' positions are stable across the streaming→completed
    // transition. Runs whenever there is a footer candidate (including a plan
    // card rescued from panelBlocks on a pure-plan turn) so none is dropped.
    // panelTurnFiles (rescued above from the process surface) merges into the
    // files list so the modified-files card always pins to the turn's end too.
    if (textMsgs.length > 0 || panelPlans.length > 0 || panelTurnFiles.length > 0) {
      const { cleaned, plans, files } = extractFooterBlocks(textMsgs);
      const allPlans = [...panelPlans, ...plans];
      const allFiles = [...panelTurnFiles, ...files];
      if (allPlans.length > 0 || allFiles.length > 0) {
        textMsgs.length = 0;
        textMsgs.push(...cleaned);
        // Attach each extracted card to the LAST reply message's identity (so
        // copy/identity semantics stay sane), or synthesize a trailing message
        // if every reply was footer-only. STRIP turnMeta from the trailing
        // message: it's a synthetic split-off carrying only the card, and
        // keeping turnMeta would render a duplicate "开始 · 用时" stat row in
        // pure-text turns (where hideTurnStat is false because there's no panel).
        const tail = cleaned.length > 0 ? cleaned[cleaned.length - 1] : null;
        if (allPlans.length > 0) {
          textMsgs.push(
            tail
              ? { ...tail, id: `plan_tail_${tail.id}`, turnMeta: undefined, blocks: allPlans }
              : {
                  id: `plan_tail_${turnMeta?.startedAt ?? Date.now()}`,
                  sessionId: "",
                  role: "assistant",
                  blocks: allPlans,
                  createdAt: Date.now(),
                },
          );
        }
        if (allFiles.length > 0) {
          textMsgs.push(
            tail
              ? { ...tail, id: `files_tail_${tail.id}`, turnMeta: undefined, blocks: allFiles }
              : {
                  id: `files_tail_${turnMeta?.startedAt ?? Date.now()}`,
                  sessionId: "",
                  role: "assistant",
                  blocks: allFiles,
                  createdAt: Date.now(),
                },
          );
        }
      }
    }

    // Re-emit the turn's screenshots as ONE trailing gallery message (the
    // render layer's groupBlocks merges the consecutive image blocks into a
    // swipeable ImageGallery). Appended AFTER the footer cards so the visible
    // order is: reply text → plan/files cards → screenshots. A screenshot-only
    // turn (no reply text) still gets its gallery via the synthesized carrier.
    if (panelImages.length > 0) {
      const tail = textMsgs.length > 0 ? textMsgs[textMsgs.length - 1] : null;
      textMsgs.push(
        tail
          ? { ...tail, id: `images_tail_${tail.id}`, turnMeta: undefined, blocks: panelImages }
          : {
              id: `images_tail_${turnMeta?.startedAt ?? Date.now()}`,
              sessionId: "",
              role: "assistant",
              blocks: panelImages,
              createdAt: Date.now(),
            },
      );
    }

    items.push({
      kind: "turnGroup",
      panelBlocks,
      textMsgs,
      turnMeta,
      isStreamingTail,
      isTurnTail,
    });
    turnBlocks = [];
    turnMeta = undefined;
    lastTurnMsgIndex = -1;
    hasOpenTurn = false;
  };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (m.role === "user") {
      // A user prompt ends any open turn and emits as its own single item.
      flush();
      items.push({ kind: "single", msg: m, isStreamingTail: false, isTurnTail: false });
      continue;
    }

    // Assistant message. A turn-opener is the FIRST assistant message of a
    // turn — the only one that carries a turnMeta (the store stamps it at
    // turn creation, both for live turns and completed ones). Its presence
    // alone marks a new turn boundary; we don't check endedAt because a
    // completed (historical) turn's opener also has endedAt set, and it must
    // still group its turn's messages into one panel. Flush any open turn
    // first.
    const isOpener = !!m.turnMeta;
    if (isOpener) {
      flush();
      hasOpenTurn = true;
      turnMeta = m.turnMeta;
    }

    if (hasOpenTurn) {
      lastTurnMsgIndex = i;
      // Collect the full block timeline (procedural + display), preserving
      // order and source message. The process/reply split happens at flush.
      for (const b of m.blocks) {
        turnBlocks.push({ block: b, msg: m });
      }
    } else {
      // Assistant message with no open turn (e.g. legacy / orphaned data
      // without turnMeta). Render as a standalone single item so it isn't
      // lost — its own MessageBlocks will still fold any procedural run. Apply
      // the same footer-card extraction as the other branches for consistency:
      // a plan / turn-files card sitting on such a message would otherwise
      // render inline. The cards are re-emitted as trailing singles right after
      // this message, plan before turn-files.
      const isStreamingTail = isRunning && i === messages.length - 1;
      const isTurnTail = isCompletedTurnTail(messages, i, isRunning);
      const { cleaned, plans, files } = extractFooterBlocks([m]);
      for (const msg of cleaned) {
        items.push({ kind: "single", msg, isStreamingTail, isTurnTail });
      }
      const emitFooter = (prefix: string, blocks: Block[]) => {
        for (let k = 0; k < blocks.length; k++) {
          items.push({
            kind: "single",
            msg: {
              id: `${prefix}_${m.id}_${k}`,
              sessionId: m.sessionId,
              role: "assistant",
              blocks: [blocks[k]!],
              createdAt: m.createdAt,
            },
            isStreamingTail: false,
            isTurnTail: false,
          });
        }
      };
      emitFooter("plan_tail", plans);
      emitFooter("files_tail", files);
    }
  }
  flush();

  // Synthesize a pendingTurn row when a turn is in flight but no real
  // assistant content has arrived yet (no open turnMeta exists). This gives
  // the user immediate "开始 · 用时" + spinner feedback right after send,
  // instead of a blank gap until the first token lands. The moment a real
  // assistant message is created (with its own turnMeta), the open-turn
  // check above consumes it into a turnGroup and this row stops rendering.
  if (isRunning && runningTurnStartedAt != null) {
    const openTurnExists = messages.some(
      (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
    );
    if (!openTurnExists) {
      items.push({
        kind: "pendingTurn",
        turnMeta: { startedAt: runningTurnStartedAt },
      });
    }
  }

  return items;
}

/** Attachment record shape handed to the store's sendPrompt — shared by the
 *  send and enqueue paths so both assemble identical payloads. */
type SendAttachment = {
  preview: string;
  content: string;
  attachmentKind?: "paste" | "file" | "quote";
  filePath?: string;
};

/** Stream-facing attachment records from the composer tags. Element tags fold
 *  into "paste" for display purposes (they're inline content blocks, same as
 *  a paste); the "element" kind only matters inside the composer's
 *  ContentTag, not in the persisted attachment record. */
function composeSendAttachments(tags: ReadonlyArray<ContentTag>): SendAttachment[] {
  return tags.map((t) => ({
    preview: t.preview,
    content: t.content,
    attachmentKind: t.kind === "file" ? "file" : "paste",
    filePath: t.filePath,
  }));
}

// Memoized so that in tabs mode (where every open tab's ChatPane is mounted
// simultaneously and backgrounded via CSS), switching tabs only re-renders
// the two panes whose `isActive` actually flipped — the N-2 backgrounded
// panes are skipped entirely. All props are primitives / stable callbacks,
// so a shallow equality check is sufficient. Single mode uses a
// `key` to force remounts, which takes precedence over memo (no conflict).
/** How the composer's option chips (Model / Effort / Permission / ContextRing)
 *  are displayed: "auto" measures the row and folds into the single-icon
 *  toggle only when they don't fit (center-pane behavior); "collapsed" keeps
 *  them permanently folded behind the toggle icon (the side-chat panel, where
 *  the pane is narrow at every default width). */
export type ComposerChipsMode = "auto" | "collapsed";

export const ChatPane = memo(
  function ChatPane({
    sessionId,
    isActive = true,
    chipsMode = "auto",
  }: {
    sessionId: string | null;
    /** Whether this pane is the foreground tab. Multi-mount layouts pass false
     *  for backgrounded panes so one-shot effects (initial scroll-to-bottom)
     *  defer until the pane is actually shown. Defaults to true for the
     *  single-pane legacy path. */
    isActive?: boolean;
    /** Chip-row display mode — see {@link ComposerChipsMode}. */
    chipsMode?: ComposerChipsMode;
  }) {
    // `sessionId` is the prop — store lookups go through it directly, not
    // through `activeSessionId`. The store still tracks `activeSessionId`
    // for global single-slot concerns (model / effort / permissionMode
    // config) and those are kept in sync by the caller (the CenterPane
    // router in App.tsx). Sends pass this sessionId explicitly, so a pane
    // never fires into another session (e.g. the side chat running beside
    // its parent). `null` means "no session open" — we render the
    // empty-state placeholder and skip all the per-session store reads.
    if (sessionId === null) {
      return <EmptyCenterPane />;
    }
    return (
      <ChatPaneForSession sessionId={sessionId} isActive={isActive} chipsMode={chipsMode} />
    );
  },
  (prev, next) =>
    prev.sessionId === next.sessionId &&
    prev.isActive === next.isActive &&
    prev.chipsMode === next.chipsMode,
);

/** Empty-state shown when there's no active session to render (no tabs
 *  open, or the project has no sessions yet). Kept inline so the
 *  CenterPane router can mount a single component without us threading
 *  separate "empty" / "with-session" branches. */
function EmptyCenterPane() {
  const { t } = useI18n();
  const claudeInstalled = useSessionStore((s) => s.claudeInstalled);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center">
        {claudeInstalled === false ? (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-1.5 text-base font-semibold text-warning">
              <IconAlertTriangle size={18} />
              <span>{t("chat.cliNotFound")}</span>
            </div>
            <p className="text-sm text-content-muted">
              {t("chat.cliInstallPrefix")}
              <code className="rounded bg-surface-muted px-1 text-content">npm i -g @anthropic-ai/claude-code</code>
              {t("chat.cliInstallSuffix")}
            </p>
            <button
              onClick={() => setSettingsOpen(true)}
              className={cn(
                "inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-sm font-medium text-surface",
                "hover:brightness-110",
              )}
            >
              <IconSettings size={14} />
              {t("chat.cliConfigure")}
              <IconArrowRight size={14} />
            </button>
          </div>
        ) : (
          <p className="text-base font-medium text-content">{t("chat.emptyHint")}</p>
        )}
      </div>
    </div>
  );
}

/** Placeholder shimmer shown while a newly-opened session's first page of
 *  persisted messages is still loading. Mimics the rhythm of a real thread
 *  (user bubble → assistant paragraph → compact tool row) so the layout
 *  doesn't jump when actual content replaces it. */
function HistorySkeleton() {
  return (
    <div className="animate-pulse space-y-8" aria-hidden>
      {/* User message bubble (right-aligned, accent-tinted) */}
      <div className="flex justify-end">
        <div className="w-2/5 space-y-2 rounded-lg bg-surface-muted p-3">
          <div className="h-3 w-full rounded bg-surface-muted" />
          <div className="h-3 w-3/5 rounded bg-surface-muted" />
        </div>
      </div>
      {/* Assistant reply (left, plain paragraphs) */}
      <div className="space-y-2.5">
        <div className="h-3 w-full rounded bg-surface-muted" />
        <div className="h-3 w-11/12 rounded bg-surface-muted" />
        <div className="h-3 w-4/6 rounded bg-surface-muted" />
      </div>
      {/* Compact tool-call row */}
      <div className="flex items-center gap-2">
        <div className="h-5 w-40 rounded bg-surface-muted" />
        <div className="h-3 w-24 rounded bg-surface-muted/70" />
      </div>
      {/* Another assistant paragraph */}
      <div className="space-y-2.5">
        <div className="h-3 w-5/6 rounded bg-surface-muted" />
        <div className="h-3 w-2/5 rounded bg-surface-muted" />
      </div>
    </div>
  );
}

/** The actual per-session chat pane. Extracted into its own function so
 *  the prop-typed parent (ChatPane) can short-circuit on `sessionId ===
 *  null` without forcing every selector to handle the empty case. */
/** Amber hint rendered beside the streaming spinner while the session's
 *  model channel (the OpenAI bridge) retries a transport failure (connect
 *  timeout / reset / refused). The full cause — e.g. undici's connect-timeout
 *  detail with every attempted address — goes into the title tooltip; the
 *  visible line stays short so it fits the spinner row. */
function UpstreamRetryHint({
  issue,
}: {
  issue: { cause: string; attempt: number; attempts: number };
}) {
  const { t } = useI18n();
  return (
    <span className="flex min-w-0 items-center gap-1 text-warning" title={issue.cause}>
      <IconAlertTriangle size={12} className="shrink-0" />
      <span className="truncate">
        {t("chatStream.upstreamRetry", { attempt: issue.attempt, attempts: issue.attempts })}
      </span>
    </span>
  );
}

function ChatPaneForSession({
  sessionId,
  isActive,
  chipsMode = "auto",
}: {
  sessionId: string;
  isActive: boolean;
  chipsMode?: ComposerChipsMode;
}) {
  const { t, locale } = useI18n();
  // Content-aware collapse of the composer's bottom action row: when the chip
  // cluster (Model/Effort/Permission/ContextRing) can't fit on one line next
  // to the mic/provider/send cluster, `collapsed` hides the chips and shows
  // the single-icon menu toggle instead (see useComposerRowFit). Narrow hosts
  // (`chipsMode="collapsed"`, i.e. the side-chat panel) skip measuring and
  // stay folded at every width.
  const { rowRef: composerActionRowRef, collapsed: composerChipsCollapsed } =
    useComposerRowFit(chipsMode === "collapsed");
  const messages = useSessionStore((s) =>
    s.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
  );
  // Older-message pagination state for this session.
  const hasMoreMessages = useSessionStore((s) => !!s.hasMoreMessagesBySession[sessionId]);
  const loadingOlder = useSessionStore((s) => !!s.loadingOlderBySession[sessionId]);
  const loadOlderMessages = useSessionStore((s) => s.loadOlderMessages);
  // Per-thread "is running" — only true when THIS thread has a turn in flight.
  // A different thread's running turn must not lock the composer here.
  const isRunning = useSessionStore((s) => !!s.runningBySession[sessionId]);
  // Backgrounded subagents may still be running after the parent turn's
  // stream closes (their lifecycle is independent). While any is running we
  // keep the composer locked so the user can't start a competing prompt —
  // the stop button stays available to interrupt.
  const hasRunningSubagents = useSessionStore(
    (s) => (s.subagentsBySession[sessionId] ?? EMPTY_SUBAGENTS).some((a) => a.status === "running"),
  );
  const sessionBusy = isRunning || hasRunningSubagents;
  // Live upstream-transport retry (the OpenAI bridge retrying a connect
  // timeout / reset — UpstreamIssueEvent). Only meaningful while a turn is
  // streaming: rendered beside the streaming spinner so a 10s+ stall reads
  // as "网络在重试" instead of an unexplained hang. Stable reference — the
  // stored object only changes when a new retry lands.
  const upstreamIssue = useSessionStore((s) =>
    s.runningBySession[sessionId] ? s.upstreamIssueBySession[sessionId] : undefined,
  );
  // Send-time anchor for the synthesized pendingTurn row (see
  // groupMessagesForRender). Subscribed so the row appears the instant
  // sendPrompt stamps it, before any assistant token arrives. Returns
  // undefined when idle - a stable primitive, no referential churn.
  const runningTurnStartedAt = useSessionStore((s) => s.runningTurnStartedAt[sessionId]);
  // Merge consecutive purely-procedural assistant messages (thinking + tool
  // only, no text) into single render clusters so a multi-step turn reads
  // as one compact "思考 + N 个操作" card instead of N stacked cards.
  const renderItems = useMemo(
    () => groupMessagesForRender(messages, isRunning, runningTurnStartedAt),
    [messages, isRunning, runningTurnStartedAt],
  );
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const openSideChatPanel = useSessionStore((s) => s.openSideChatPanel);
  const interrupt = useSessionStore((s) => s.interrupt);
  const editAndResendMessage = useSessionStore((s) => s.editAndResendMessage);
  const claudeInstalled = useSessionStore((s) => s.claudeInstalled);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  // Tasks capsule + usage (both keyed by this sessionId).
  const todos = useSessionStore((s) =>
    s.todosBySession[sessionId] ?? EMPTY_TODOS,
  );
  // Subagent roster for this session.
  const subagents: SubagentSnapshot[] = useSessionStore((s) =>
    s.subagentsBySession[sessionId] ?? EMPTY_SUBAGENTS,
  );
  // Plan view: clicking a plan card/title calls openPlanDrawer, which stores
  // the plan text in planDrawerPlanBySession. CenterPane reads that and shows
  // the PlanViewer in the editor column (not a drawer here). Closing is
  // handled by the PlanViewer's close button in CenterPane.
  const openPlanDrawer = useSessionStore((s) => s.openPlanDrawer);
  // Project root absolute path for this session (used by the @ / add-context
  // file pickers). Resolved through the session's projectId → projects[].
  // Pinned sessions aren't in the per-project slices (they live in the global
  // pinned bucket), so that's scanned too.
  const projectPath = useSessionStore((s) => {
    let pid: string | undefined;
    for (const list of Object.values(s.sessionsByProject)) {
      const found = list?.find((x) => x.id === sessionId);
      if (found) {
        pid = found.projectId;
        break;
      }
    }
    if (!pid) pid = s.pinnedSessions.find((x) => x.id === sessionId)?.projectId;
    if (!pid) return null;
    return s.projects.find((p) => p.id === pid)?.path ?? null;
  });
  // Project display name (same resolution as projectPath, but returns the
  // name). Shown in the empty-thread project/branch indicator above the
  // composer. Falls back to the path basename when the project has no name.
  const projectName = useSessionStore((s) => {
    let pid: string | undefined;
    for (const list of Object.values(s.sessionsByProject)) {
      const found = list?.find((x) => x.id === sessionId);
      if (found) {
        pid = found.projectId;
        break;
      }
    }
    if (!pid) pid = s.pinnedSessions.find((x) => x.id === sessionId)?.projectId;
    if (!pid) return "";
    const p = s.projects.find((pr) => pr.id === pid);
    return p?.name ?? "";
  });
  // Pending AskUserQuestion (per-session bucket — another tab's question
  // does not clobber this one).
  const pendingQuestion = useSessionStore((s) => s.pendingQuestionBySession[sessionId] ?? null);
  const dismissQuestion = useSessionStore((s) => s.dismissQuestion);
  const submitQuestion = useSessionStore((s) => s.submitQuestion);
  // (No sessionId filter needed — the bucket lookup above already scopes
  // to this session.)
  const activeQuestion = pendingQuestion?.questions ?? null;
  // Pending tool-approval queue. The store holds approvals for all
  // sessions in one flat array; filter to this one before rendering.
  // Head = element 0 of the filtered sub-array.
  const pendingApprovals = useSessionStore((s) => s.pendingApprovals);
  const decideApproval = useSessionStore((s) => s.decideApproval);
  const headApproval = pendingApprovals.find((p) => p.sessionId === sessionId) ?? null;
  // Pending ExitPlanMode plan approval (one-at-a-time per session). The
  // model drafted a plan in plan mode and is awaiting the user's
  // approve/reject decision before executing.
  const pendingPlanApproval = useSessionStore(
    (s) => s.pendingPlanApprovalBySession[sessionId] ?? null,
  );
  const submitPlanApproval = useSessionStore((s) => s.submitPlanApproval);
  const handoffPlanApproval = useSessionStore((s) => s.handoffPlanApproval);
  // Pre-turn file contents for the Write-tool diff. Built from the per-turn
  // `kind: "turn-files"` blocks in the message stream — each turn records the
  // `before` of every file it touched, so scanning all of them (later turns
  // overwrite earlier ones per filePath) yields the most recent pre-turn
  // content for each path. This is exactly what the Write card's before/after
  // diff wants. Empty until the first turn.files block arrives.
  const beforeMap = useMemo<BeforeContentMap>(() => {
    const m: BeforeContentMap = new Map();
    for (const msg of messages) {
      for (const b of msg.blocks) {
        if (b.kind === "turn-files") {
          for (const f of b.files) m.set(f.filePath, f.before);
        }
      }
    }
    return m;
  }, [messages]);
  // All plan blocks across this session's message history. Used by the
  // StatusCapsule (count) and the ActivityPopover (title list). Frozen plan
  // blocks survive turn.done, so this includes every approved plan in the
  // session - not just the current one.
  const planBlocks = useMemo(
    () =>
      messages
        .flatMap((m) => m.blocks)
        .filter((b): b is Extract<Block, { kind: "plan" }> => b.kind === "plan"),
    [messages],
  );
  // ── Message bookmarks (selection → "添加书签" → capsule + timeline) ──
  const bookmarks: SessionBookmark[] = useSessionStore((s) =>
    s.bookmarksBySession[sessionId] ?? EMPTY_BOOKMARKS,
  );
  const addBookmark = useSessionStore((s) => s.addBookmark);
  const removeBookmark = useSessionStore((s) => s.removeBookmark);
  const renameBookmark = useSessionStore((s) => s.renameBookmark);
  const askInSideChat = useSessionStore((s) => s.askInSideChat);
  const sideChatSeed = useSessionStore((s) => s.sideChatSeedBySession[sessionId]);
  const drainSideChatSeed = useSessionStore((s) => s.drainSideChatSeed);
  // Floating [copy | add bookmark] toolbar anchored to the current text
  // selection inside the message stream. Local UI state is fine here: the
  // document holds exactly ONE selection and only the frontmost pane can
  // receive the mouseup that opens the toolbar (background tabs are
  // display:none, no mouse events).
  const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbarState | null>(null);
  // Fly-to-capsule animation: a small dot travels from the selection to the
  // status capsule right after adding a bookmark. Carries only the start
  // point; the target rect is read live (the capsule segment may be mounting
  // for the very first time as the optimistic count lands).
  const [bookmarkFlyFrom, setBookmarkFlyFrom] = useState<{ top: number; left: number } | null>(null);
  // Message-stream container (selection-ownership check) and capsule wrapper
  // (fly-animation target), both scoped to THIS pane instance.
  const streamAreaRef = useRef<HTMLDivElement>(null);
  const capsuleWrapRef = useRef<HTMLDivElement>(null);
  // Messages this thread's user has previously sent, oldest → newest, as
  // plain text. Drives the Up/Down history recall in the composer. Derived
  // from the message stream (the user message's `text` block holds exactly
  // what was typed), so it survives restarts and stays per-thread. Messages
  // with only attachment chips (no typed text) are skipped.
  const historyTexts = useMemo(() => {
    const out: string[] = [];
    for (const m of messages) {
      if (m.role !== "user") continue;
      for (const b of m.blocks) {
        if (b.kind === "text" && b.text.trim().length > 0) {
          out.push(b.text);
          break;
        }
      }
    }
    return out;
  }, [messages]);
  // The textarea is blocked while a turn is running, a backgrounded subagent
  // is still in flight, or a tool approval is awaiting the user's decision —
  // the approval panel takes the place of the input area entirely so the user
  // can't type a competing prompt.
  const inputBlocked = sessionBusy || !!headApproval;
  // The TEXTAREA specifically: unlocked while a turn is running so the user
  // can type ahead and enqueue the next prompt. Still hard-locked when an
  // approval / AskUserQuestion is pending (that panel owns the input area).
  const textareaLocked = !!headApproval || !!pendingQuestion;
  // Any of the three bottom prompts (tool approval / plan approval / question)
  // currently visible. When one is shown the composer card is hidden entirely
  // - the prompt takes its place in the flow, pushing the message stream up
  // instead of overlaying it. The composer stays mounted (state + Tiptap
  // history preserved) via `hidden` (display:none); it just isn't rendered.
  const hasPendingPrompt = !!headApproval || !!pendingPlanApproval || !!pendingQuestion;

  // Per-session prompt queue (FIFO). Survives tab switches — it lives in the
  // store, not component state, so draining from the turn-done handler can
  // reach it without a component reference. Stable EMPTY_PROMPT_QUEUE ref so
  // the selector never returns a fresh [] (would re-render forever).
  const queue: QueuedPrompt[] = useSessionStore(
    (s) => s.promptQueueBySession[sessionId] ?? EMPTY_PROMPT_QUEUE,
  );
  const enqueuePrompt = useSessionStore((s) => s.enqueuePrompt);
  const removeQueuedPrompt = useSessionStore((s) => s.removeQueuedPrompt);
  const clearPromptQueue = useSessionStore((s) => s.clearPromptQueue);
  const sendQueuedPromptNow = useSessionStore((s) => s.sendQueuedPromptNow);
  const reorderPromptQueue = useSessionStore((s) => s.reorderPromptQueue);

  const [value, setValue] = useState("");
  // ── Up/Down history recall ──
  // recallActive: the composer currently holds a recalled past message and
  // Up/Down should keep cycling history (until the user edits the text).
  // historyIndex: the recalled message's index into historyTexts (-1 = none).
  // recallFillRef: guards handleChange so the content change triggered by OUR
  // own setText fill doesn't exit recall mode — only a real user edit does.
  const [recallActive, setRecallActive] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const recallFillRef = useRef(false);
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  // Inline-edit mode for a user message. When set, the MessageRow with this id
  // swaps its bubble for an inline editor. Cleared on submit/cancel. Null when
  // no message is being edited.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const virtualListRef = useRef<LegendListRef>(null);
  // Recompute the "jump to bottom" button visibility from the live scroll
  // state. Returns true if the list is near the bottom (button hidden), false
  // otherwise. Used both by the onScroll handler and the data-change effect so
  // the button stays correct when content grows without a scroll event (e.g.
  // streaming deltas append while the user is parked mid-history).
  //
  // LegendList's `getState()` exposes three relevant values:
  //   - scroll        : current scroll offset from the top
  //   - scrollLength  : the *viewport* height (NOT total content height!)
  //   - contentLength : total scrollable content height
  // Distance from the bottom is therefore `contentLength - scroll - scrollLength`
  // (mirrors the library's own `distanceFromEnd` in checkAtBottom.ts). The
  // previous code used `scrollLength - scroll`, which treats the viewport
  // height as the content height and only surfaces the button after scrolling
  // up past ~one viewport minus 80px.
  const recomputeNearBottom = useCallback((): boolean => {
    const state = virtualListRef.current?.getState();
    if (!state) return true; // no list yet -> treat as "at bottom" (no button)
    const distanceFromEnd = state.contentLength - state.scroll - state.scrollLength;
    return distanceFromEnd < NEAR_BOTTOM_THRESHOLD;
  }, []);
  // Briefly suspend maintainScrollAtEnd while a TurnPanel expands/collapses.
  // Two suspension levels:
  //  - "layout" (manual user toggle): drop the itemLayout/layout triggers so
  //    LegendList stops snapping scroll to hold the bottom pinned on EVERY
  //    item-height change of the 200ms transition — that snap per frame
  //    shoved the expanded content upward ("往上挤") and the two animations
  //    beat against each other ("闪一下"). dataChange stays on so live
  //    streaming still auto-follows new messages.
  //  - "full" (the one-shot fold-away of a just-completed turn): ALSO drop
  //    dataChange. The turn.done regroup itself is a data change, and
  //    turn-files/plan cards keep landing for a few hundred ms after the
  //    turn ends — a live dataChange snap would yank scroll against the
  //    running fold transition.
  const [anchorSuspension, setAnchorSuspension] = useState<"layout" | "full" | null>(null);
  const pauseBottomAnchorTimer = useRef<number | null>(null);
  const settleScrollTimer = useRef<number | null>(null);
  const pauseBottomAnchor = useCallback(
    (opts?: { suspendDataChange?: boolean }) => {
      const mode: "layout" | "full" = opts?.suspendDataChange ? "full" : "layout";
      setAnchorSuspension(mode);
      if (pauseBottomAnchorTimer.current != null) {
        window.clearTimeout(pauseBottomAnchorTimer.current);
      }
      pauseBottomAnchorTimer.current = window.setTimeout(() => {
        pauseBottomAnchorTimer.current = null;
        setAnchorSuspension(null);
      }, mode === "full" ? 360 : 280);
      if (mode === "full") {
        // After the 200ms fold transition settles, glide back to the bottom
        // IF the user was following along. While the process rows collapsed,
        // the scroll container's native clamping usually kept the bottom
        // pinned already; this covers estimate undershoot from the regroup
        // and the turn-files card that lands just after turn.done. The
        // near-bottom check is snapshotted at pause START (before any height
        // changed) and OR-ed with the settle-time check: content changes
        // inside the window (the fold shrinking, the turn-files card growing)
        // distort the live distance-from-end, so the snapshot carries the
        // user's true intent; the live check still catches users who were
        // mid-list and remain mid-list.
        const wasNearBottom = recomputeNearBottom();
        if (settleScrollTimer.current != null) {
          window.clearTimeout(settleScrollTimer.current);
        }
        settleScrollTimer.current = window.setTimeout(() => {
          settleScrollTimer.current = null;
          if (wasNearBottom || recomputeNearBottom()) {
            void virtualListRef.current?.scrollToEnd({ animated: true });
          }
        }, 240);
      }
    },
    [recomputeNearBottom],
  );
  // Session switch / unmount mid-transition: drop pending timers so they
  // never fire against a stale list.
  useEffect(
    () => () => {
      if (pauseBottomAnchorTimer.current != null) window.clearTimeout(pauseBottomAnchorTimer.current);
      if (settleScrollTimer.current != null) window.clearTimeout(settleScrollTimer.current);
    },
    [],
  );
  // Rich-text editor handle (replaces the old <textarea> ref). Exposes
  // focus/serialize/insertSkill/etc. — see ComposerEditor.tsx.
  const editorRef = useRef<ComposerEditorHandle>(null);
  /** Guards the one-shot "scroll to bottom on session open" effect. Reset to
   *  false on mount (keyed by sessionId upstream, so a switch re-mounts us).
   *  Set true after the first successful scroll so streaming appends after that
   *  respect the user's scroll position (maintainScrollAtEnd handles the
   *  follow-along case) instead of yanking them back down. */
  const initialScrollDoneRef = useRef(false);
  // ── Composer inline pickers (@ mention / / slash) ──
  // "picker" drives a single floating list above the textarea. Only one of
  // mention/slash is active at a time. `triggerStart` is the index of the
  // leading @ or / so we can delete the whole token on pick / cancel.
  type PickerKind = "mention" | "slash" | null;
  const [pickerKind, setPickerKind] = useState<PickerKind>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const triggerStartRef = useRef<number | null>(null);
  // Anchor rect for the floating picker (the textarea's box, refreshed on open).
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);
  // "attach" mode: opened by the bottom-left + button (not by typing @). Same
  // UI as mention but multi-select and not tied to a textarea token.
  const [attachPickerOpen, setAttachPickerOpen] = useState(false);
  const [attachPickerQuery, setAttachPickerQuery] = useState("");
  const [attachAnchor, setAttachAnchor] = useState<DOMRect | null>(null);
  // Content tags: long/multi-line pastes promoted to chips above the
  // textarea so they don't bury the input area. Ephemeral per-turn UI
  // state (cleared on send). See lib/contentTag.ts for the promote rules.
  const [tags, setTags] = useState<ContentTag[]>([]);
  // Staged user-attached images (paste / OS picker) — thumbnail chips above
  // the editor, sent inline with the prompt as base64 content blocks.
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  // Whether a file-tree drag is currently hovering over the composer —
  // drives a highlight ring so the drop target is discoverable.
  const [dragOver, setDragOver] = useState(false);
  // Which tag's preview popover is open (by id); null = none.
  const [openTagId, setOpenTagId] = useState<string | null>(null);
  // Which queued-prompt card is expanded (by id); null = all collapsed.
  const [expandedQueueId, setExpandedQueueId] = useState<string | null>(null);
  // HTML5 drag-and-drop reorder state for the prompt queue.
  const [draggedQueueId, setDraggedQueueId] = useState<string | null>(null);
  const [dragOverQueueId, setDragOverQueueId] = useState<string | null>(null);
  // Refs to each chip's DOM node, keyed by tag id. Used to measure the
  // clicked chip's bounding box so the preview popover can anchor to its
  // top-right corner.
  const chipRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  // Bounding box of the chip that opened the current popover. Captured at
  // toggle time (not re-read every render) so the popover stays put even
  // if the chips row reflows while it's open.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  // User-message id → render-item index mapping for the virtual-list-based
  // MessageTimeline. Built once per renderItems change from the grouped data.
  const userMsgToRenderIndex = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < renderItems.length; i++) {
      const item = renderItems[i];
      if (item.kind === "single" && item.msg.role === "user") {
        m.set(item.msg.id, i);
      }
    }
    return m;
  }, [renderItems]);
  // All-message version of the map above — drives BOOKMARK jumps, which can
  // land on assistant replies (where the key conclusions live), not just user
  // messages. `single` rows map their own id; a `turnGroup` maps each of its
  // textMsgs to the GROUP's index (a jump lands on the turn's head — v1
  // doesn't pin-point inside the group, the flash highlights the reply row
  // once mounted).
  const msgToRenderIndex = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < renderItems.length; i++) {
      const item = renderItems[i];
      if (item.kind === "single") {
        m.set(item.msg.id, i);
      } else if (item.kind === "turnGroup") {
        for (const msg of item.textMsgs) m.set(msg.id, i);
      }
    }
    return m;
  }, [renderItems]);

  /** Scroll to the message a bookmark/timeline dash points at and flash the
   *  row. Silently no-ops when the id no longer maps (a stale bookmark whose
   *  message was truncated away).
   *
   *  Deterministic aiming via LegendList's own state: `getState().
   *  positionAtIndex(index)` gives the list's current position for the item
   *  (measured when rendered before, 80px-estimate otherwise) and
   *  `scrollToOffset` returns a promise — so we aim, AWAIT the scroll, and
   *  only then look at the DOM. Each retry re-aims with drift correction:
   *  a mounted reference row's real offset vs its claimed positionAtIndex
   *  exposes how far the estimate is off globally, and the correction is
   *  applied to the target. Residual error (and the "reply deep inside a
   *  tall turnGroup" case) is finished off by exact centering of the found
   *  row inside the list's own scroll container. Keyword fallback (excerpt
   *  head) covers the pathological case where the id row can't be found but
   *  its text is mounted. */
  const jumpToMessage = useCallback(
    (messageId: string, excerpt?: string) => {
      const index = msgToRenderIndex.get(messageId);
      const ref = virtualListRef.current;
      const root = streamAreaRef.current;
      if (index === undefined || !ref || !root) return;
      const needle = excerpt?.replace(/\s+/g, " ").trim().slice(0, 48);

      const findRow = (): Element | null => {
        const row = root.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
        if (row) return row;
        if (!needle) return null;
        return (
          [...root.querySelectorAll("[data-message-id]")].find((el) =>
            (el.textContent ?? "").replace(/\s+/g, " ").includes(needle),
          ) ?? null
        );
      };

      const centerAndFlash = (row: Element) => {
        const scroller = findScrollParent(row, root);
        // Precise target: the exact text the user had selected, re-found in
        // the rendered markdown (whitespace-normalized match across node
        // boundaries). Full excerpt first; a short prefix as fallback for
        // selections that spanned two messages at add time. Painted via the
        // CSS Custom Highlight API — no DOM mutation for React to clobber.
        let range: Range | null = null;
        if (needle) {
          range = findNormalizedTextRange(row, needle);
          if (!range && needle.length > 16) range = findNormalizedTextRange(row, needle.slice(0, 16));
        }
        if (range && highlightRange(range, 2600)) {
          const rRect = range.getBoundingClientRect();
          if (scroller) {
            const cRect = scroller.getBoundingClientRect();
            const target =
              scroller.scrollTop + (rRect.top - cRect.top) - cRect.height / 2 + rRect.height / 2;
            scroller.scrollTo({ top: Math.max(target, 0), behavior: "smooth" });
          } else {
            row.scrollIntoView({ block: "center", behavior: "smooth" });
          }
          return;
        }
        // Fallback: selection text not found (or no Highlight API) — center
        // and flash the whole row instead.
        if (scroller) {
          const cRect = scroller.getBoundingClientRect();
          const rRect = row.getBoundingClientRect();
          const target =
            scroller.scrollTop + (rRect.top - cRect.top) - cRect.height / 2 + rRect.height / 2;
          scroller.scrollTo({ top: Math.max(target, 0), behavior: "smooth" });
        } else {
          row.scrollIntoView({ block: "center", behavior: "smooth" });
        }
        row.classList.add("bookmark-flash");
        window.setTimeout(() => row.classList.remove("bookmark-flash"), 1400);
      };

      let attempts = 0;
      const locate = async (): Promise<void> => {
        attempts += 1;
        const row = findRow();
        if (row) {
          centerAndFlash(row);
          return;
        }
        if (attempts >= 5) return;
        // Target not mounted — re-aim with drift correction from a mounted
        // reference row, then await the scroll before looking again.
        const state = ref.getState();
        let aim = state.positionAtIndex(index);
        const refEl = root.querySelector("[data-message-id]");
        const refId = refEl?.getAttribute("data-message-id") ?? null;
        const refIdx = refId ? msgToRenderIndex.get(refId) : undefined;
        if (refEl instanceof HTMLElement && refIdx !== undefined) {
          const scroller = findScrollParent(refEl, root);
          if (scroller) {
            const actual =
              scroller.scrollTop +
              (refEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
            const claimed = state.positionAtIndex(refIdx);
            if (Number.isFinite(claimed)) aim += actual - claimed;
          }
        }
        await ref.scrollToOffset({ offset: Math.max(aim - state.scrollLength / 4, 0), animated: false });
        window.setTimeout(() => void locate(), 120);
      };

      void (async () => {
        const state = ref.getState();
        await ref.scrollToOffset({
          offset: Math.max(state.positionAtIndex(index) - state.scrollLength / 4, 0),
          animated: false,
        });
        await locate();
      })();
    },
    [msgToRenderIndex],
  );

  /** mouseup on the message stream: capture the finished text selection and
   *  open the floating [copy | add bookmark] toolbar. Runs after a tick so
   *  the selection is final. Selections outside this pane's container (the
   *  composer, another pane) never reach this — the handler is bound to this
   *  pane's stream area — but the containment check guards selections that
   *  END here after starting elsewhere. */
  const handleStreamMouseUp = useCallback(() => {
    window.setTimeout(() => {
      const container = streamAreaRef.current;
      if (!container) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString();
      if (!text || text.trim().length === 0) return;
      const node = sel.anchorNode;
      if (!node || !container.contains(node)) return;
      const element =
        node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
      const host = element?.closest("[data-message-id]");
      const messageId = host?.getAttribute("data-message-id");
      if (!messageId) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const role = messages.find((m) => m.id === messageId)?.role;
      setSelectionToolbar({
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        text,
        messageId,
        role: role === "user" ? "user" : "assistant",
      });
    }, 0);
  }, [messages]);

  /** Selection-toolbar "add bookmark": persist via the store (optimistic —
   *  the capsule segment appears immediately), start the fly-to-capsule
   *  animation from the selection, clear the selection, toast. */
  const handleAddBookmark = useCallback(
    (sel: SelectionToolbarState) => {
      // Collapse whitespace for the list display; full fidelity isn't needed
      // — the excerpt exists to RECOGNIZE the entry, the jump goes by
      // messageId alone.
      const excerpt = sel.text.trim().replace(/\s+/g, " ").slice(0, 120);
      void addBookmark(sessionId, { messageId: sel.messageId, excerpt, role: sel.role });
      setBookmarkFlyFrom({ top: sel.rect.top, left: (sel.rect.left + sel.rect.right) / 2 });
      window.getSelection()?.removeAllRanges();
      setSelectionToolbar(null);
      useToastStore.getState().push({
        kind: "info",
        title: t("chatStream.bookmark.addedToast"),
      });
    },
    [addBookmark, sessionId, t],
  );

  /** Selection-toolbar "发送到子会话": route the selected text to the side
   *  chat (opening/creating it), clear the selection, close the toolbar.
   *  The panel opening is itself the feedback — no toast. */
  const handleAskSideChat = useCallback(
    (sel: SelectionToolbarState) => {
      void askInSideChat(sel.text);
      window.getSelection()?.removeAllRanges();
      setSelectionToolbar(null);
    },
    [askInSideChat],
  );

  // Side-chat seed: text sent from a main-session selection. ChatPane mounts
  // for BOTH main and side sessions — only the side-chat instance finds a
  // seed under its own sessionId. Delivered as a CONTENT CARD above the
  // composer (same chip + popover + compose-at-send pipeline as a bulky
  // paste), not inline text — the quote can be long, and the card keeps the
  // input area free for the user's actual question.
  useEffect(() => {
    if (sideChatSeed === undefined) return;
    drainSideChatSeed(sessionId);
    setTags((prev) => [...prev, makeContentTag(sideChatSeed)]);
    editorRef.current?.focus();
  }, [sideChatSeed, sessionId, drainSideChatSeed]);

  // Timeline bookmark dashes: live (non-stale) bookmarks resolved to their
  // message + render index. Stale entries (message truncated away by an
  // edit-resend / compact) are skipped — they'd have nothing to jump to (the
  // popover renders them greyed out with a manual delete affordance).
  const bookmarkedTimelineItems = useMemo(() => {
    if (bookmarks.length === 0) return EMPTY_BOOKMARK_TIMELINE;
    const out: {
      bookmarkId: string;
      message: ChatMessage;
      index: number;
      excerpt: string;
      title: string | null;
    }[] = [];
    for (const b of bookmarks) {
      const index = msgToRenderIndex.get(b.messageId);
      if (index === undefined) continue;
      const msg = messages.find((m) => m.id === b.messageId);
      if (msg) out.push({ bookmarkId: b.id, message: msg, index, excerpt: b.excerpt, title: b.title });
    }
    return out;
  }, [bookmarks, messages, msgToRenderIndex]);
  // Current virtual-list scroll offset, updated on each scroll event.
  // Used by MessageTimeline to compute which user message is active.
  const [virtualScrollTop, setVirtualScrollTop] = useState(0);

  /** Detect an @ or / trigger token at the caret and drive the inline picker.
   *  - `@` (mention): must be at line start or preceded by whitespace.
   *  - `/` (slash): same boundary rule. Query = chars after the trigger up to
   *    the caret, stopping at whitespace.
   *  Closing the picker happens when the token is broken (space / delete /
   *  caret leaves).
   *
   *  IMPORTANT: skill/command pills serialize as `/name` in the plain-text
   *  representation, so their leading `/` would be mistaken for a freshly-typed
   *  slash trigger. We fetch the pill text ranges from the editor and skip over
   *  them while backtracking - a pill's `/` is never a trigger. */
  const recomputePicker = useCallback(
    (v: string, caret: number) => {
      // Locked only when a bottom prompt (approval / question) owns the input
      // area — matching textareaLocked. While a turn is merely RUNNING the
      // picker stays available: the composer accepts typed-ahead prompts, and
      // `/sidechat` in particular exists precisely to be reachable while the
      // main turn streams. Each command's pick handler carries its own
      // busy-guard where one applies (e.g. /compact refuses mid-turn).
      if (textareaLocked) {
        if (pickerKind !== null) setPickerKind(null);
        return;
      }
      // Ranges [start, end) in `v` occupied by skill/command pills. A trigger
      // char found inside one of these is part of a pill, not user input.
      const pillRanges = editorRef.current?.getPillRanges() ?? [];
      /** Is plain-text offset `pos` inside a pill? */
      const inPill = (pos: number) =>
        pillRanges.some(([s, e]) => pos >= s && pos < e);

      // Walk back from the caret to find a trigger char at a valid position.
      let i = caret;
      while (i > 0) {
        // If the char just before `i` sits inside a pill, skip the whole pill
        // and continue backtracking from its start. This prevents the pill's
        // leading `/` (from `/name`) from being treated as a slash trigger.
        if (inPill(i - 1)) {
          const range = pillRanges.find(([s, e]) => i - 1 >= s && i - 1 < e);
          if (range) {
            i = range[0]; // jump to the pill's start offset
            continue;
          }
        }
        const ch = v[i - 1];
        const triggerKind = TRIGGER_CHARS[ch];
        if (triggerKind) {
          const atLineStart = i - 1 === 0 || /\s/.test(v[i - 2]);
          if (!atLineStart) {
            if (pickerKind !== null) setPickerKind(null);
            return;
          }
          const token = v.slice(i, caret);
          // A space within the token means the user moved past it - close.
          if (/\s/.test(token)) {
            if (pickerKind !== null) setPickerKind(null);
            return;
          }
          const kind = triggerKind;
          if (pickerKind !== kind) {
            triggerStartRef.current = i - 1;
            const rect = editorRef.current?.getRect();
            if (rect) setPickerAnchor(rect);
            setPickerKind(kind);
          }
          setPickerQuery(token);
          return;
        }
        if (/\s/.test(ch)) break;
        i -= 1;
      }
      if (pickerKind !== null) setPickerKind(null);
    },
    [textareaLocked, pickerKind],
  );

  /** Content-change handler from the rich-text editor. The editor reports its
   *  plain-text-with-skills representation; we keep a mirror in `value` (for
   *  empty-state checks + enqueue) and re-run trigger detection. A change that
   *  is NOT our own history-recall fill means the user typed/edited — exit
   *  recall mode so Up/Down return to caret navigation, and re-run trigger
   *  detection. Recall fills (applyHistory) are not user edits: they stay in
   *  recall mode and skip trigger detection so a recalled `/command` or
   *  `@file` doesn't pop the picker open mid-recall. */
  const handleChange = (text: string) => {
    setValue(text);
    if (recallFillRef.current) {
      recallFillRef.current = false;
      setPickerKind(null);
      return;
    }
    setRecallActive(false);
    setHistoryIndex(-1);
    const caret = editorRef.current?.getCaretOffset() ?? -1;
    if (caret >= 0) recomputePicker(text, caret);
  };

  /** Fill the editor with the history message at `idx`, entering recall mode.
   *  The fill is marked via recallFillRef so handleChange (fired
   *  synchronously by setText → onUpdate) doesn't interpret it as a user edit
   *  and exit recall. */
  const applyHistory = useCallback(
    (idx: number) => {
      const text = historyTexts[idx];
      if (text === undefined) return;
      setHistoryIndex(idx);
      setRecallActive(true);
      recallFillRef.current = true;
      editorRef.current?.setText(text);
      setValue(text);
    },
    [historyTexts],
  );

  /** Up arrow: recalls the most recent sent message when idle, otherwise one
   *  step OLDER. No-op at the oldest entry. */
  const handleHistoryUp = useCallback(() => {
    if (historyTexts.length === 0) return;
    const nextIdx =
      recallActive && historyIndex >= 0 ? historyIndex - 1 : historyTexts.length - 1;
    if (nextIdx < 0) return; // already at the oldest
    applyHistory(nextIdx);
  }, [historyTexts, recallActive, historyIndex, applyHistory]);

  /** Down arrow: recalls one step NEWER; past the newest clears the editor
   *  and exits recall. No-op before any message has been recalled. */
  const handleHistoryDown = useCallback(() => {
    if (historyTexts.length === 0) return;
    if (!recallActive || historyIndex < 0) return; // nothing recalled yet
    const nextIdx = historyIndex + 1;
    if (nextIdx >= historyTexts.length) {
      // Newest + 1 → clear the editor and leave recall mode.
      setRecallActive(false);
      setHistoryIndex(-1);
      recallFillRef.current = true;
      editorRef.current?.setText("");
      setValue("");
      return;
    }
    applyHistory(nextIdx);
  }, [historyTexts, recallActive, historyIndex, applyHistory]);

  /** Whether the composer's bare Up/Down arrows should be intercepted for
   *  history recall: when the composer is empty (the recall trigger), or
   *  already mid-recall with the recalled text still unedited. Locked while a
   *  question/approval owns the input area. */
  const recallEnabled =
    !textareaLocked && historyTexts.length > 0 && (value.trim() === "" || recallActive);

  /** Whether the composer holds anything sendable (typed text, attachment
   *  chips, or staged images). Drives the send button's enablement AND the
   *  busy-state stop/send toggle: while a turn is running, an empty composer
   *  keeps the stop button (interrupt); the moment the user types, the button
   *  flips to send — which enqueues the prompt into the 排队 chips instead of
   *  starting a new turn. */
  const hasComposerContent = value.trim() !== "" || tags.length > 0 || pendingImages.length > 0;

  // ── Composer draft persistence ──
  // The store's composerDraftBySession holds each thread's unsent input so it
  // survives this pane unmounting (single-mode thread switch, tab close).
  // Restore runs BEFORE the write-through below (declaration order matters):
  // the write-through's first run sees the stale empty `value` and would
  // otherwise clear a pre-existing draft before restore reads it.
  useEffect(() => {
    const draft = useSessionStore.getState().composerDraftBySession[sessionId];
    // Guard: skip empty drafts so a never-typed thread isn't clobbered.
    if (!draft || (!draft.text && draft.tags.length === 0)) return;
    if (draft.html) editorRef.current?.setHTML(draft.html);
    setValue(draft.text);
    if (draft.tags.length > 0) setTags(draft.tags);
  }, [sessionId]);

  // Write the composer through to the per-session draft on every change, so
  // an unmount at any later point has the freshest state. An emptied composer
  // (after send) drops the stored draft.
  useEffect(() => {
    if (value.trim() === "" && tags.length === 0) {
      useSessionStore.getState().clearComposerDraft(sessionId);
      return;
    }
    useSessionStore.getState().saveComposerDraft(sessionId, {
      text: value,
      html: editorRef.current?.getHTML() ?? "",
      tags,
    });
  }, [value, tags, sessionId]);

  /** Remove the trigger token (`@query` or `/query`) from the editor. */
  const clearTriggerToken = useCallback(() => {
    const start = triggerStartRef.current;
    if (start === null || !editorRef.current) {
      setPickerKind(null);
      return;
    }
    const caret = editorRef.current.getCaretOffset();
    if (caret < 0) {
      setPickerKind(null);
      return;
    }
    editorRef.current.deleteTextRange(start, caret);
    setValue((v) => v.slice(0, start) + v.slice(caret));
    setPickerKind(null);
    triggerStartRef.current = null;
    requestAnimationFrame(() => editorRef.current?.setCaretOffset(start));
  }, []);

  /** Add files (from mention or attach picker) as file tags. */
  const addFileTags = useCallback(
    (files: FileSearchEntry[]) => {
      if (files.length > 0) {
        setTags((prev) => appendUniqueFileTags(prev, files.map((f) => f.path)));
      }
    },
    [],
  );

  /** Add a skill (from the `/` picker) as an atomic skill tag. Unlike
   *  text-insertion, a skill tag can be removed only as a whole (via its ×
   *  button) and survives as a standalone block in the message stream. */
  // Drain the per-session "add to chat" queue. Other surfaces (e.g. the
  // file-tree context menu) push absolute paths into the queue via
  // `enqueueChatFile`; this effect materializes them as file-reference tags
  // in the composer. Subscribe to this session's queue so the effect fires
  // whenever it becomes non-empty, then drain (read + clear) and convert.
  const chatFileQueue = useSessionStore((s) =>
    sessionId ? s.chatFileQueueBySession[sessionId] ?? EMPTY_CHAT_QUEUE : EMPTY_CHAT_QUEUE,
  );
  // Cached skill list for the `/` menu. Loaded per active project by the store
  // (initDeferred + selectProject); read here as a stable reference.
  const skills = useSessionStore((s) => s.skills);
  const drainChatFileQueue = useSessionStore((s) => s.drainChatFileQueue);
  useEffect(() => {
    if (chatFileQueue.length === 0) return;
    const paths = drainChatFileQueue(sessionId);
    if (paths.length === 0) return;
    setTags((prev) => appendUniqueFileTags(prev, paths));
  }, [chatFileQueue, drainChatFileQueue, sessionId]);

  // Element-pick drain: the embedded browser panel enqueues picked DOM
  // elements (selector + outerHTML + url) into chatElementQueueBySession;
  // materialize them as element tags here. Same one-shot hand-off pattern as
  // the file queue above. Each pick becomes its own chip (multi-select).
  const chatElementQueue = useSessionStore((s) =>
    sessionId ? s.chatElementQueueBySession[sessionId] ?? EMPTY_ELEMENT_QUEUE : EMPTY_ELEMENT_QUEUE,
  );
  const drainChatElementQueue = useSessionStore((s) => s.drainChatElementQueue);
  useEffect(() => {
    if (chatElementQueue.length === 0) return;
    const els = drainChatElementQueue(sessionId);
    if (els.length === 0) return;
    setTags((prev) => [...prev, ...els.map(makeElementTag)]);
  }, [chatElementQueue, drainChatElementQueue, sessionId]);

  /** Mention picker confirm: drop the @token, add a file tag, refocus. */
  const handleMentionPick = useCallback(
    (files: FileSearchEntry[]) => {
      addFileTags(files);
      clearTriggerToken();
    },
    [addFileTags, clearTriggerToken],
  );

  /** Slash picker confirm: replace the `/query` trigger token in the editor
   *  with an inline skill pill (an atomic, non-editable node), then continue
   *  typing after it. The pill is `/name` when serialized, sent in place. */
  const handleSlashPick = useCallback(
    (skill: SkillInfo) => {
      const start = triggerStartRef.current;
      if (start === null || !editorRef.current) {
        setPickerKind(null);
        return;
      }
      const caret = editorRef.current.getCaretOffset();
      if (caret < 0) {
        setPickerKind(null);
        return;
      }
      editorRef.current.insertSkill(skill, start, caret);
      setPickerKind(null);
      triggerStartRef.current = null;
      // Refresh the mirrored text so empty-state / enqueue stay in sync.
      setValue(editorRef.current.getTextWithSkills());
    },
    [],
  );

  /** Built-in command confirm (`/compact` / `/init` / `/browser` / `/sidechat`).
   *  Unlike skills (which become inline pills), built-in commands have bespoke
   *  behavior:
   *  - `compact`: immediately send `/compact` as a turn to the agent so it
   *    summarizes and releases context. No-op while a turn is running.
   *  - `init`: insert an atomic `/init` pill into the editor (same visual
   *    treatment as a skill pill) so the user can append extra instructions
   *    before sending. The agent recognizes `/init` and generates AGENTS.md.
   *  - `browser`: replace the trigger token with an editable prompt template
   *    that asks the agent to open a URL with the browser tools. The user fills
   *    in the URL (+ optional intent like "截图" / "移动端") and sends. This
   *    surfaces the browser feature — without it users don't know it exists.
   *  - `sidechat`: pure navigation — open the right-panel quick-ask tab. No
   *    prompt is inserted; deliberately NOT gated on sessionBusy, since asking
   *    beside a RUNNING turn is the feature's whole point. */
  const handleBuiltInPick = useCallback(
    (cmd: BuiltInCommand) => {
      if (cmd.kind === "compact") {
        // Refuse while a turn is in flight; the agent can't process a second
        // prompt concurrently and compact mid-turn is undefined.
        setPickerKind(null);
        if (sessionBusy) return;
        clearTriggerToken();
        void sendPrompt("/compact", undefined, undefined, undefined, undefined, undefined, sessionId);
        return;
      }
      if (cmd.kind === "sidechat") {
        // Drop the `/sidechat` trigger token and navigate away — the editor
        // stays empty (nothing was meant to be sent).
        setPickerKind(null);
        clearTriggerToken();
        triggerStartRef.current = null;
        openSideChatPanel();
        return;
      }
      if (cmd.kind === "browser") {
        // Fill the editor with a template the user edits before sending. Clear
        // the `/browser` trigger token first so it isn't left in the text.
        setPickerKind(null);
        clearTriggerToken();
        triggerStartRef.current = null;
        const template = t("chat.slash.browserTemplate");
        if (editorRef.current) {
          editorRef.current.setText(template);
          setValue(template);
          // Focus + place the caret on the URL line so the user types the
          // address immediately (the most common next action).
          requestAnimationFrame(() => editorRef.current?.focus());
        }
        return;
      }
      // `init`: replace the `/query` trigger token with an inline `/init` pill
      // (same atomic color block as a skill pill). The user can then type
      // additional constraints after it and press Enter to send. Order matters:
      // read the trigger range + caret and insert the pill BEFORE closing the
      // picker, mirroring handleSlashPick - closing first can blur the editor
      // and make getCaretOffset return -1.
      const start = triggerStartRef.current;
      if (start === null || !editorRef.current) {
        setPickerKind(null);
        return;
      }
      const caret = editorRef.current.getCaretOffset();
      if (caret < 0) {
        setPickerKind(null);
        return;
      }
      editorRef.current.insertCommandPill(cmd.name, start, caret);
      setPickerKind(null);
      triggerStartRef.current = null;
      // Refresh the mirrored text so empty-state / enqueue stay in sync.
      setValue(editorRef.current.getTextWithSkills());
    },
    [sessionBusy, clearTriggerToken, sendPrompt, t, sessionId, openSideChatPanel],
  );

  /** Open the attach picker from the bottom-left + button. */
  const openAttachPicker = useCallback(() => {
    if (inputBlocked) return;
    const rect = editorRef.current?.getRect();
    if (rect) setAttachAnchor(rect);
    setAttachPickerQuery("");
    setAttachPickerOpen(true);
  }, [inputBlocked]);

  /** 在光标处插入触发字符(`/` 或 `@`),交给 recomputePicker 打开对应的
   *  内联选择器 — 与手动输入走完全相同的链路,选中插入 / 关闭等行为全部
   *  复用。触发字符必须位于行首或空白之后才会被识别,光标前是普通字符时
   *  先补一个换行;编辑器失焦时(点菜单/提示的常态)getCaretOffset 返回
   *  -1,回退到文本末尾。供 "+" 菜单「斜杠命令」与空输入框的提示行共用。 */
  const insertTriggerChar = useCallback((ch: string) => {
    if (inputBlocked) return;
    const editor = editorRef.current;
    if (!editor) return;
    const text = editor.getTextWithSkills();
    const caret = editor.getCaretOffset();
    const pos = caret >= 0 ? caret : text.length;
    const needsNewline = pos > 0 && !/\s/.test(text[pos - 1] ?? "");
    editor.setCaretOffset(pos);
    editor.insertText(needsNewline ? `\n${ch}` : ch);
  }, [inputBlocked]);

  const handleAttachPick = useCallback(
    (files: FileSearchEntry[]) => {
      addFileTags(files);
      setAttachPickerOpen(false);
      requestAnimationFrame(() => editorRef.current?.focus());
    },
    [addFileTags],
  );

  // Paste-to-card threshold (user-configurable). When a paste exceeds this
  // many chars (or spans > 3 lines), it's promoted to a chip instead of
  // inserted inline. Driven by the "常规 → 粘贴卡片阈值" setting.
  const pasteTagThresholdChars = useSessionStore((s) => s.pasteTagThresholdChars);

  /** Promote a bulky paste to a content-tag chip. Forwarded to the editor,
   *  which calls this instead of inserting long/multi-line text inline. */
  const handlePromotePaste = useCallback((text: string) => {
    setTags((prev) => [...prev, makeContentTag(text)]);
  }, []);

  /** Expand a paste-tag's content back into the composer as inline text and
   *  remove the chip. Only called for paste tags (file/element tags carry an
   *  @path reference, not user text). The editor's insertText inserts at the
   *  caret without clearing existing content. */
  const handleExpandTag = useCallback(
    (tagId: string) => {
      const tag = tags.find((t) => t.id === tagId);
      if (tag) editorRef.current?.insertText(tag.content);
      setTags((prev) => prev.filter((t) => t.id !== tagId));
      setOpenTagId(null);
      setAnchorRect(null);
      requestAnimationFrame(() => editorRef.current?.focus());
    },
    [tags],
  );

  // Ceiling for clipboard-pasted external files (renderer-side guard; the
  // main-side schema caps the base64 payload too). Larger pastes are skipped
  // with a toast instead of failing the IPC.
  const PASTE_FILE_MAX_BYTES = 50 * 1024 * 1024;

  /** Stage an image (name + data URL) as a pending inline image — thumbnail
   *  chip now, base64 content block at send. Shared by OS paste and the OS
   *  image picker. */
  const stageImage = useCallback((name: string, dataUrl: string) => {
    setPendingImages((prev) => {
      if (prev.length >= MAX_PENDING_IMAGES) {
        useToastStore.getState().push({
          kind: "warning",
          title: t("chat.toast.tooManyImages"),
          body: t("chat.toast.tooManyImagesBody", { n: MAX_PENDING_IMAGES }),
        });
        return prev;
      }
      return [
        ...prev,
        {
          id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name,
          dataUrl,
        },
      ];
    });
  }, [t]);

  /** Read an image File into a data URL and stage it. Files without a MIME
   *  type (older clipboard copies) default to image/png — prepareImageForSend
   *  re-encodes via canvas anyway when the bytes aren't actually PNG. */
  const stageImageFile = useCallback(
    (file: File) => {
      if (file.size > PASTE_FILE_MAX_BYTES) {
        useToastStore.getState().push({
          kind: "warning",
          title: t("chat.toast.imageTooLarge"),
          body: t("chat.toast.tooLargeBody", { name: file.name }),
        });
        return;
      }
      // Some clipboard sources (older image copies) yield an empty File.name —
      // fall back to a name derived from the MIME type.
      const name =
        file.name || (file.type ? `pasted-${file.type.split("/").pop() || "image"}` : "pasted-image");
      const mime = file.type.startsWith("image/") ? file.type : "image/png";
      void file
        .arrayBuffer()
        .then((buf) => toBase64(new Uint8Array(buf)))
        .then((data) => stageImage(name, `data:${mime};base64,${data}`))
        .catch((err) => {
          console.warn("stage pasted image failed:", err);
        });
    },
    [stageImage, t],
  );

  /** OS image picker (file:pickImages — main reads the files itself). */
  const handlePickImages = useCallback(async () => {
    if (inputBlocked) return;
    try {
      const res = await api.file.pickImages({});
      for (const img of res.images) {
        stageImage(img.name, `data:${img.mimeType};base64,${img.data}`);
      }
      if (res.skipped.length > 0) {
        useToastStore.getState().push({
          kind: "warning",
          title: t("chat.toast.imagesSkipped"),
          body: t("chat.toast.imagesSkippedBody", {
            names: res.skipped.join(locale === "en" ? ", " : "、"),
          }),
        });
      }
    } catch (err) {
      console.warn("pickImages failed:", err);
    }
  }, [inputBlocked, stageImage, t, locale]);

  const removePendingImage = useCallback((id: string) => {
    setPendingImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  /** Paste of external files/images (copied from the OS — Finder, browser,
   *  screenshot). IMAGES are staged as inline content blocks (base64 sent
   *  straight to the model — the model never sees a temp path). Non-image
   *  files keep the old flow: the renderer can't write files
   *  (contextIsolation), so each file's bytes go to main which materializes
   *  them under the OS temp dir; the returned path becomes a normal FILE tag
   *  — the same top-left card as an internally dragged file, and the agent
   *  reads the content itself. The card shows the ORIGINAL file name, not
   *  the random temp path. */
  const handlePasteFiles = useCallback((files: File[]) => {
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        stageImageFile(file);
        continue;
      }
      if (file.size > PASTE_FILE_MAX_BYTES) {
        useToastStore.getState().push({
          kind: "warning",
          title: t("chat.toast.fileTooLarge"),
          body: t("chat.toast.tooLargeBody", { name: file.name }),
        });
        continue;
      }
      // Some clipboard sources (older image copies) yield an empty File.name —
      // fall back to a name derived from the MIME type so the temp path keeps
      // a meaningful extension (the agent's Read tool sniffs images from it).
      const name =
        file.name ||
        (file.type ? `pasted-${file.type.split("/").pop() || "file"}` : "pasted-file");
      void file
        .arrayBuffer()
        .then((buf) => toBase64(new Uint8Array(buf)))
        .then((bytes) => api.clipboardFile.save({ name, bytes }))
        .then((res) => {
          // Capture into a local const first: narrowing doesn't propagate
          // into the nested setTags updater closure.
          const path = res.ok && res.path ? res.path : null;
          if (path) {
            setTags((prev) => [...prev, makeFileTag(path, name)]);
          } else {
            console.warn("clipboardFile.save failed:", res.error);
          }
        })
        .catch((err) => {
          console.warn("paste external file failed:", err);
        });
    }
  }, [stageImageFile, t]);

  // Scroll callback from LegendList: update scroll position for MessageTimeline
  // and jump-to-bottom button state.
  const handleVirtualScroll = useCallback(() => {
    const state = virtualListRef.current?.getState();
    if (!state) return;
    setVirtualScrollTop(state.scroll);
    const distanceFromEnd = state.contentLength - state.scroll - state.scrollLength;
    setShowJumpBottom(distanceFromEnd >= NEAR_BOTTOM_THRESHOLD);
    // Near-top: load one page of older history. Cheap to call repeatedly —
    // the store dedupes concurrent fetches and short-circuits on hasMore=false.
    if (state.scroll < NEAR_TOP_THRESHOLD) {
      void loadOlderMessages(sessionId);
    }
  }, [loadOlderMessages, sessionId]);

  // First-page history fetch in flight for this session (bucket still
  // undefined). Drives a skeleton in place of the empty-thread welcome so
  // switching threads doesn't flash the centered empty composer before the
  // persisted messages land.
  const historyLoading = useSessionStore(
    (s) => !s.messagesBySession[sessionId] && !!s.loadingMessagesBySession[sessionId],
  );

  // Whether the session has any messages yet. Computed early (before the
  // scroll effects below) because they reference it. A loading thread is
  // treated as non-empty so the composer stays docked at the bottom and the
  // message area keeps its flex-1 slot for the skeleton.
  const empty = messages.length === 0 && !historyLoading;

  // Keep the jump-to-bottom button in sync when content changes (new messages
  // arrive / streaming grows the list) even if no scroll event fires. After the
  // initial jump-to-bottom lands we re-check: if the user is at the bottom the
  // button stays hidden; if they've scrolled up and new content pushed the
  // bottom further away, the button appears. Runs after paint so LegendList has
  // applied the new item sizes.
  useEffect(() => {
    if (empty) {
      setShowJumpBottom(false);
      return;
    }
    let raf = 0;
    raf = requestAnimationFrame(() => {
      setShowJumpBottom(!recomputeNearBottom());
    });
    return () => cancelAnimationFrame(raf);
  }, [renderItems, empty, recomputeNearBottom]);

  const jumpToBottom = () => {
    void virtualListRef.current?.scrollToEnd({ animated: true });
  };

  // "New content while scrolled away" count for the composer live bar's jump
  // badge: snapshot the render-item count the moment the user leaves the
  // bottom, diff against it while away, reset on return. Setting the baseline
  // in an effect (not during render) keeps the count stable as renderItems
  // rebuilds on every delta flush.
  const awayBaseRef = useRef<number | null>(null);
  useEffect(() => {
    if (!showJumpBottom) {
      awayBaseRef.current = null;
      return;
    }
    if (awayBaseRef.current === null) awayBaseRef.current = renderItems.length;
  }, [showJumpBottom, renderItems.length]);
  const newWhileAway =
    showJumpBottom && awayBaseRef.current !== null
      ? Math.max(0, renderItems.length - awayBaseRef.current)
      : 0;

  /** Normalize the staged images into the send allowlist (downscale / JPEG
   *  re-encode when oversized). Returns null (with a toast) when any image
   *  fails — the caller aborts the send and keeps the composer intact. */
  const preparePendingImages = useCallback(async (): Promise<PromptImage[] | undefined | null> => {
    if (pendingImages.length === 0) return undefined;
    const images: PromptImage[] = [];
    for (const img of pendingImages) {
      const res = await prepareImageForSend(img.dataUrl, img.name);
      if (!res.ok) {
        useToastStore.getState().push({
          kind: "warning",
          title: t("chat.toast.imageNotSent"),
          body: res.error,
        });
        return null;
      }
      images.push(res.image);
    }
    return images;
  }, [pendingImages, t]);

  const handleSend = async () => {
    // Serialize the editor: text has skill pills inlined as `/name` at their
    // positions; skillNames records which pills were embedded.
    const { text: editorText, skillNames } = editorRef.current?.serialize() ?? {
      text: value.trim(),
      skillNames: [],
    };
    const text = editorText.trim();
    // Nothing to send if the editor, tag list, and staged images are all empty.
    if (!text && tags.length === 0 && pendingImages.length === 0) return;
    // Don't allow sending while a turn (or a backgrounded subagent from a
    // prior turn) is still in flight — the stop button is the only valid
    // action in that state.
    if (sessionBusy) return;
    // Compose the final prompt: editor text (with `/name` inline) + each tag's
    // content as a delimited block (see composePromptWithTags). An image-only
    // send yields an empty prompt (the images ARE the prompt).
    const prompt = composePromptWithTags(text, tags);
    if (!prompt && pendingImages.length === 0) return;
    // Normalize the staged images into the send allowlist (downscale / JPEG
    // re-encode when oversized). A failed image aborts the send and keeps the
    // composer intact — the toast explains which one and why.
    const images = await preparePendingImages();
    if (images === null) return;
    // Forward the tags as attachments so the sent user message keeps the
    // same chip-card presentation in the stream as it had in the composer.
    const attachments = composeSendAttachments(tags);
    // Clear the composer only when the prompt was actually accepted into the
    // stream. A blocked send (e.g. the "尚未配置模型" dialog raised inside
    // sendPrompt) must leave the typed text + tags intact so nothing is lost
    // while the user goes to configure a model.
    const sent = await sendPrompt(
      prompt,
      attachments.length > 0 ? attachments : undefined,
      attachments.length > 0 ? text : undefined,
      skillNames.length > 0 ? skillNames : undefined,
      images,
      undefined,
      sessionId,
    );
    if (!sent) return;
    editorRef.current?.clear();
    setValue("");
    setTags([]);
    setPendingImages([]);
    setOpenTagId(null);
    setAnchorRect(null);
  };

  /** Queue the typed prompt while a turn is running, instead of sending it.
   *  Mirrors handleSend's payload assembly (prompt + attachments + displayText
   *  + images) so a drained queue item flows through the normal sendPrompt
   *  path and the user message looks identical to a live send. No-op when not
   *  busy. */
  const handleEnqueue = async () => {
    const { text: editorText, skillNames } = editorRef.current?.serialize() ?? {
      text: value.trim(),
      skillNames: [],
    };
    const text = editorText.trim();
    if (!text && tags.length === 0 && pendingImages.length === 0) return;
    // Only meaningful while busy — when idle, Enter/click routes to handleSend.
    if (!sessionBusy) return;
    const prompt = composePromptWithTags(text, tags);
    if (!prompt && pendingImages.length === 0) return;
    // Downsize the images NOW (not at drain time) so the queue holds only
    // sendable payloads.
    const images = await preparePendingImages();
    if (images === null) return;
    const attachments = composeSendAttachments(tags);
    enqueuePrompt(sessionId, {
      prompt,
      displayText: text,
      attachments: attachments.length > 0 ? attachments : undefined,
      skillNames: skillNames.length > 0 ? skillNames : undefined,
      images: images ?? undefined,
    });
    editorRef.current?.clear();
    setValue("");
    setTags([]);
    setPendingImages([]);
    setOpenTagId(null);
    setAnchorRect(null);
  };

  /** Restore a queued prompt back into the composer for editing: fill the
   *  editor with its displayText, rebuild attachment tags from its stored
   *  attachments and staged-image chips from its stored images, then remove
   *  it from the queue. Skill pills (/commands) can't be restored (only their
   *  plain text survives in displayText), so the user re-types those — same
   *  constraint as editAndResendMessage. */
  const handleEditQueuedPrompt = (item: QueuedPrompt) => {
    editorRef.current?.setText(item.displayText);
    if (item.attachments && item.attachments.length > 0) {
      const restored: ContentTag[] = item.attachments.map((a, i) => ({
        id: `reedit-${item.id}-${i}`,
        kind: a.attachmentKind === "file" ? "file" : "paste",
        preview: a.preview,
        content: a.content,
        filePath: a.filePath,
      }));
      setTags(restored);
    } else {
      setTags([]);
    }
    setPendingImages(
      item.images && item.images.length > 0
        ? item.images.map((img, i) => ({
            id: `reedit-img-${item.id}-${i}`,
            name: t("chat.imageN", { n: i + 1 }),
            dataUrl: `data:${img.mimeType};base64,${img.data}`,
          }))
        : [],
    );
    removeQueuedPrompt(sessionId, item.id);
    setExpandedQueueId(null);
    requestAnimationFrame(() => editorRef.current?.focus());
  };

  /** Drop the dragged queue item onto `targetId`: removes it from its old
   *  position and inserts it at the target's slot (target shifts down).
   *  No-op if the target is the item itself. */
  const handleQueueReorder = (targetId: string) => {
    const draggedId = draggedQueueId;
    setDraggedQueueId(null);
    setDragOverQueueId(null);
    if (!draggedId || draggedId === targetId) return;
    const next = queue.map((q) => q.id);
    const from = next.indexOf(draggedId);
    if (from < 0) return;
    next.splice(from, 1);
    const to = next.indexOf(targetId);
    if (to < 0) next.push(draggedId);
    else next.splice(to, 0, draggedId);
    reorderPromptQueue(sessionId, next);
  };

  /** Enter handler wired into the editor: sends when idle, enqueues when busy.
   *  Shift+Enter inserts a newline and never reaches here (handled by Tiptap). */
  const handleEnter = () => {
    if (sessionBusy) handleEnqueue();
    else handleSend();
  };

  /** Submit an inline-edited user message. Reconstructs the full prompt from
   *  the edited text + the original message's attachment blocks (preserved
   *  as-is) + the images the user kept in the editor, then calls
   *  editAndResendMessage which truncates the session history at the edited
   *  message and resends. */
  const handleEditSubmit = async (msg: ChatMessage, newText: string, images: PromptImage[]) => {
    const text = newText.trim();
    if (!text) return;
    setEditingMessageId(null);
    // Reconstruct attachment tags from the original message's attachment
    // blocks so composePromptWithTags can re-inline them into the prompt.
    const attachmentBlocks = msg.blocks.filter((b) => b.kind === "attachment");
    const tags: ContentTag[] = attachmentBlocks.map((b, i) => {
      const ab = b as Extract<Block, { kind: "attachment" }>;
      return {
        id: `edit-tag-${i}`,
        // "quote" (side-chat reference) re-inlines as a paste block — only
        // the composer's ContentTag has no quote kind; the persisted record
        // keeps it for display.
        kind: ab.attachmentKind === "file" ? "file" : "paste",
        preview: ab.preview,
        content: ab.content,
        filePath: ab.filePath,
      };
    });
    const prompt = composePromptWithTags(text, tags);
    const attachments = tags.map((t) => ({
      preview: t.preview,
      content: t.content,
      attachmentKind: t.kind === "file" ? ("file" as const) : ("paste" as const),
      filePath: t.filePath,
    }));
    // Preserve the original message's skill pills (if any) so the edited
    // message keeps rendering them as inline pills after resend. The text
    // editor only edits prose; skills survive as /name text + this list.
    const textBlock = msg.blocks.find((b) => b.kind === "text");
    const skillsUsed = textBlock?.skillNames;
    void editAndResendMessage(
      sessionId,
      msg.id,
      prompt,
      attachments.length > 0 ? attachments : undefined,
      attachments.length > 0 ? text : undefined,
      skillsUsed,
      images,
    );
  };

  // On opening a session, jump to the bottom so the latest exchange is in view
  // (the keyed remount above starts the list scrolled to the top). This fires
  // once per mount: it waits for messages to load, then scrolls and latches
  // `initialScrollDoneRef` so subsequent streaming appends don't yank the view
  // back down if the user has scrolled up to read history.
  //
  // In multi-mount (tabs) mode this pane may mount while hidden — defer the
  // scroll until it becomes the active (visible) pane, otherwise the rAF runs
  // against a display:none list and the scroll is lost (or wrong).
  useEffect(() => {
    if (empty || !isActive || initialScrollDoneRef.current) return;
    // LegendList measures item heights asynchronously on first layout, so a
    // single rAF may run before the list has real scroll length. Two rAFs give
    // it a layout pass + a settle pass; scrollToEnd is a no-op if the list
    // still isn't ready, so we retry within the second frame as a fallback.
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        virtualListRef.current?.scrollToEnd({ animated: false });
        initialScrollDoneRef.current = true;
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [empty, isActive]);

  // When this session's running turn completes (isRunning flips true → false),
  // bring the list back to the very bottom so the finished reply — and any
  // footer cards pinned to the turn's end (plan / turn-files) — are fully in
  // view. Streaming already auto-follows while the user sits at the bottom
  // (maintainScrollAtEnd), but that only tracks when the list is already near
  // the end: if the user scrolled up mid-stream, or the completion re-layout
  // (flat stream → collapsed TurnPanel + re-pinned cards) left the view a few
  // pixels short of the end, nothing snaps back. A double-rAF waits for
  // LegendList to measure the re-grouped turn's item heights before scrolling;
  // the transition guard (wasRunningRef) keeps this from firing on mount or
  // while the turn is still streaming. Hidden (backgrounded tab) panes defer.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (!isActive) return;
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = isRunning;
    if (!wasRunning || isRunning) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        virtualListRef.current?.scrollToEnd({ animated: true });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isRunning, isActive]);

  // The id of the last user message in this session. Only this message is
  // editable - editing an earlier user message would require forking the
  // conversation at a non-tail point, which the current truncation-based
  // resend doesn't support cleanly (the SDK's resume keeps server-side
  // history that we can't rewind to an arbitrary point).
  const lastUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].id;
    }
    return null;
  }, [messages]);

  // Render a single item for LegendList's renderItem.
  const renderListItem = useCallback(
    ({ item }: { item: RenderItem }) => {
      if (item.kind === "single") {
        const m = item.msg;
        const isUser = m.role === "user";
        return (
          <div className="px-[var(--chat-gutter)]">
            <div className="mx-auto max-w-5xl">
              <MessageRow
                msg={m}
                isStreamingTail={item.isStreamingTail}
                isTurnTail={item.isTurnTail}
                beforeMap={beforeMap}
                canEdit={isUser && !sessionBusy && m.id === lastUserMessageId}
                isEditing={editingMessageId === m.id}
                onStartEdit={(msg) => setEditingMessageId(msg.id)}
                onSubmitEdit={handleEditSubmit}
                onCancelEdit={() => setEditingMessageId(null)}
                onOpenPlan={(p) => openPlanDrawer(sessionId, p)}
                projectPath={projectPath}
              />
            </div>
          </div>
        );
      }
      if (item.kind === "pendingTurn") {
        // Synthesized pre-token running row: just the stat row (which carries
        // its own spinner via the `live` branch) plus a streaming-tail
        // spinner, mirroring a real streaming assistant message's tail so the
        // feedback reads as "the model is working". Disappears once a real
        // assistant turnMeta exists (groupMessagesForRender stops emitting it).
        return (
          <div className="px-[var(--chat-gutter)]">
            <div className="mx-auto max-w-5xl">
              <TurnStatRow meta={item.turnMeta} />
              <div className="mt-1.5 flex items-center gap-1.5">
                <IconLoader2 size={12} className="animate-spin text-accent" />
                {upstreamIssue && <UpstreamRetryHint issue={upstreamIssue} />}
              </div>
            </div>
          </div>
        );
      }
      // item.kind === "turnGroup"
      const hasProcess = item.panelBlocks.length > 0;
      // turnActive: the turn is still streaming AND the model hasn't started
      // its final reply yet (no post-tool text). While active the TurnPanel
      // auto-expands to show live progress — including any narration text the
      // model weaves between tool calls. The moment the final reply text
      // arrives (textMsgs becomes non-empty) the process recedes (panel
      // auto-collapses) so the user's focus moves to the reply.
      const turnActive = item.isStreamingTail && item.textMsgs.length === 0;
      const onOpenPlan = (p: string) => openPlanDrawer(sessionId, p);
      return (
        <div
          key={item.textMsgs[0]?.id ?? `turn-${item.turnMeta?.startedAt ?? ""}`}
          className="px-[var(--chat-gutter)]"
        >
          <div className="mx-auto max-w-5xl">
            {hasProcess && (
              <TurnPanel
                blocks={item.panelBlocks}
                beforeMap={beforeMap}
                turnActive={turnActive}
                turnMeta={item.turnMeta}
                onOpenPlan={onOpenPlan}
                onToggleCollapse={pauseBottomAnchor}
                projectPath={projectPath}
              />
            )}
            {/* Text replies (and plan / turn-files / error blocks) stay
                visible below the panel. hideTurnStat suppresses the
                per-message stat row ONLY when a TurnPanel is rendered
                (hasProcess) - its header already shows the turn's 开始/用时,
                so a second timing line above the reply would be redundant.
                For pure-text turns (no tools) there's no panel, so we let the
                first reply message show its own TurnStatRow - otherwise the
                "开始 · 用时" stat would vanish once the turn ends. */}
            {/*
                isTurnTail is given to the LAST textMsg that has non-empty text,
                not the array-last item: the turn-files extraction above re-
                emits the "本轮修改了 N 个文件" card as a standalone trailing
                textMsg (no text block), so the array-last index would hand
                tail status to the card and strip it from the real text reply -
                hiding that reply's copy button (showCopy gates on isTurnTail).
                Falling back to the last text-bearing message restores the copy
                affordance; the card itself never had one (hasTextContent=false).
            */}
            {(() => {
              let lastTextIdx = -1;
              for (let i = item.textMsgs.length - 1; i >= 0; i--) {
                if (
                  item.textMsgs[i].blocks.some(
                    (b) => b.kind === "text" && b.text.trim().length > 0,
                  )
                ) {
                  lastTextIdx = i;
                  break;
                }
              }
              if (lastTextIdx < 0) lastTextIdx = item.textMsgs.length - 1;
              return item.textMsgs.map((msg, idx) => (
                <MessageRow
                  key={msg.id}
                  msg={msg}
                  isStreamingTail={item.isStreamingTail && idx === item.textMsgs.length - 1}
                  isTurnTail={item.isTurnTail && idx === lastTextIdx}
                  beforeMap={beforeMap}
                  hideTurnStat={hasProcess}
                  onOpenPlan={onOpenPlan}
                  projectPath={projectPath}
                />
              ));
            })()}
            {turnActive && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <IconLoader2 size={12} className="animate-spin text-accent" />
                {upstreamIssue && <UpstreamRetryHint issue={upstreamIssue} />}
              </div>
            )}
          </div>
        </div>
      );
    },
    [beforeMap, sessionBusy, editingMessageId, lastUserMessageId, handleEditSubmit, sessionId, projectPath, upstreamIssue],
  );

  // Footer rendered after all message items. The plan card and per-turn
  // modified-files card used to live here as session-global singletons; both
  // now render INLINE in the stream as per-turn blocks (kind: "plan" and
  // kind: "turn-files"). The footer's sole remaining job: show a loading
  // spinner when the main agent's turn has ended (turn.done cleared
  // isRunning) but backgrounded subagents are still running. While the main
  // turn is in flight the stream carries its own spinner (pendingTurn /
  // turnActive), so we stay out of the way then. Memoized so LegendList sees
  // a stable element reference across renders that don't change the busy
  // state (avoids needless list re-renders).
  const listFooter = useMemo(() => {
    if (isRunning || !hasRunningSubagents) return null;
    return (
      <div className="px-[var(--chat-gutter)]">
        <div className="mx-auto max-w-5xl">
          <div className="mt-1.5 flex items-center gap-1.5">
            <IconLoader2 size={12} className="animate-spin text-accent" />
          </div>
        </div>
      </div>
    );
  }, [isRunning, hasRunningSubagents]);

  // Older-messages loading indicator. Shown only when a paginated fetch is in
  // flight for this session. A thin row at the very top of the stream.
  const listHeader = useMemo(() => {
    if (!loadingOlder) return null;
    return (
      <div className="flex items-center justify-center py-2">
        <IconLoader2 size={12} className="animate-spin text-accent" />
      </div>
    );
  }, [loadingOlder]);

  return (
    <div className="relative flex h-full flex-col" data-chat-root>
      {/* Message stream area */}
      <div
        ref={streamAreaRef}
        onMouseUp={handleStreamMouseUp}
        className={cn("relative flex min-h-0", empty ? "h-0" : "flex-1")}
      >
      {/* Left-edge timeline of user messages */}
      {!empty && (
        <MessageTimeline
          messages={messages}
          scrollTop={virtualScrollTop}
          userItemIndices={userMsgToRenderIndex}
          bookmarkedItems={bookmarkedTimelineItems}
          onJumpItem={(messageId, _index, excerpt) => jumpToMessage(messageId, excerpt)}
        />
      )}
      {/* Virtual message list */}
      {!empty && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1" style={{ position: "relative" }}>
            <LegendList
              ref={virtualListRef}
              data={renderItems}
              renderItem={renderListItem}
              keyExtractor={(item) => {
                if (item.kind === "single") return item.msg.id;
                if (item.kind === "pendingTurn") return "pending-turn";
                // Use turnMeta.startedAt as stable key — it's set once when the turn
                // begins and never changes, so the TurnPanel (and expanded Edit cards
                // inside it) survive LegendList recycling during streaming.
                return `turn:${item.turnMeta?.startedAt ?? ""}`;
              }}
              maintainScrollAtEnd={
                anchorSuspension === "layout"
                  ? // Manual expand/collapse: drop the itemLayout/layout
                    // triggers so LegendList stops snapping scroll to hold
                    // the bottom pinned against our height transition.
                    // onDataChange stays on so streaming still follows new
                    // messages.
                    { on: { dataChange: true } }
                  : anchorSuspension === "full"
                    ? // Just-completed turn fold-away: also drop dataChange —
                      // the turn.done regroup itself is a data change and
                      // turn-files/plan cards keep landing right after it.
                      { on: {} }
                    : true
              }
              // extraData drives LegendList's "should re-render all visible
              // items" check. renderItems alone isn't enough: toggling the
              // inline editor (editingMessageId) doesn't change renderItems,
              // so without including it here the list won't swap a row into
              // its edit form until something else forces a re-render.
              extraData={editingMessageId ? `${editingMessageId}|${renderItems.length}` : renderItems}
              estimatedItemSize={80}
              onScroll={handleVirtualScroll}
              drawDistance={400}
              ListFooterComponent={listFooter}
              ListHeaderComponent={listHeader}
              contentContainerStyle={{ paddingTop: MESSAGE_LIST_TOP_PADDING }}
              // overscrollBehavior contain: a touch scroll starting at the
              // list's boundaries must not chain to the document (mobile
              // browsers would pan the whole shell — see the document scroll
              // lock in styles.css). The style spread lands after the
              // library's own overflow styles, on the same scroll div.
              style={{ height: "100%", width: "100%", overscrollBehavior: "contain" }}
            />
          </div>
        </div>
      )}

      {/* History-loading skeleton — shimmer rows standing in for the message
          stream while the first page of persisted messages is fetched.
          Pointer-events none: purely decorative, disappears the moment the
          real messages land in the bucket. */}
      {historyLoading && (
        <div className="pointer-events-none absolute inset-0 z-20 mx-auto w-full max-w-5xl space-y-8 overflow-hidden px-[var(--chat-gutter)] pt-12">
          <HistorySkeleton />
        </div>
      )}

      {/* StatusCapsule - floating overlay pinned to the top-right. Sits
          ABOVE the list (absolute) so it never takes layout space; only the
          pill itself is clickable, the rest of the overlay passes pointer
          events through to the scroll surface beneath. The popover drops
          down from the pill inside this non-clipping wrapper. Renders when
          there are todos, subagents, plan blocks, OR bookmarks in the
          session history. The wrapper ref is the fly-to-capsule bookmark
          animation's landing target. */}
      {!empty && (todos.length > 0 || subagents.length > 0 || planBlocks.length > 0 || bookmarks.length > 0) && (
        <div ref={capsuleWrapRef} className="pointer-events-none absolute right-8 top-2 z-30 flex justify-end">
          <StatusCapsule
            subagents={subagents}
            todos={todos}
            planCount={planBlocks.length}
            planBlocks={planBlocks}
            bookmarks={bookmarks}
            isBookmarkStale={(b) => !msgToRenderIndex.has(b.messageId)}
            onPickBookmark={(b) => jumpToMessage(b.messageId, b.excerpt)}
            onRemoveBookmark={(b) => void removeBookmark(sessionId, b.id)}
            onRenameBookmark={(b, title) => void renameBookmark(sessionId, b.id, title)}
            onPickPlan={(p) => openPlanDrawer(sessionId, p)}
          />
        </div>
      )}

      {/* Floating [copy | add bookmark] toolbar over the current text
          selection (portals to body — see SelectionToolbar). */}
      {selectionToolbar && (
        <SelectionToolbar
          state={selectionToolbar}
          onAddBookmark={handleAddBookmark}
          onAskSideChat={handleAskSideChat}
          onClose={() => setSelectionToolbar(null)}
        />
      )}

      {/* One-shot fly-to-capsule bookmark dot (portals to body). */}
      {bookmarkFlyFrom && (
        <BookmarkFly from={bookmarkFlyFrom} targetRef={capsuleWrapRef} onDone={() => setBookmarkFlyFrom(null)} />
      )}

      {/* Jump-to-bottom button. Shows a new-activity count while a turn is
          running (updates that landed since the user left the bottom). */}
      {showJumpBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center">
          <button
            onClick={jumpToBottom}
            className={cn(
              "pointer-events-auto flex items-center gap-1 rounded-full",
              "border border-content-subtle/40 bg-surface-hover px-2.5 py-1.5 shadow-md transition-all",
              "hover:brightness-95 dark:hover:brightness-110",
            )}
            title={t("chat.jumpToBottom")}
          >
            <IconArrowDown size={14} className="text-content" />
            {newWhileAway > 0 && (
              <span className="animate-[live-badge-in_220ms_ease-out] text-xs tabular-nums text-content-muted">
                {t("chat.live.newActivity", { n: newWhileAway })}
              </span>
            )}
          </button>
        </div>
      )}
      </div>

      {/* Input box — fixed at the bottom (outside the scroll container) so
          the user always has access to the composer. No border-t divider:
          the box sits flush against the message area. When the session is
          empty the wrapper takes flex-1 and centers the box vertically. */}
      <div className={cn(
        "relative px-[var(--chat-gutter)]",
        empty
          ? "flex flex-1 items-center justify-center overflow-hidden"
          : "shrink-0 pb-3",
      )}>
        {/* Ambient accent glow behind the empty-state welcome. A soft radial
            highlight anchored at the top center gives the home screen depth —
            in dark mode it reads as a halo behind the brand badge; in light
            mode the low alpha keeps it as a barely-there tint. Pointer-events
            none so it never intercepts clicks. */}
        {empty && (
          <div
            className="pointer-events-none absolute inset-0"
            aria-hidden
            style={{
              background:
                "radial-gradient(ellipse 80% 50% at 50% 0%, rgb(var(--accent)/0.07), transparent 70%)",
            }}
          />
        )}
        <div className={cn("relative w-full", empty ? "max-w-4xl" : "mx-auto max-w-5xl pt-5")}>
          {empty && (
            <EmptyThreadWelcome projectName={projectName} />
          )}
          {/* Plan-approval card (ExitPlanMode) - the model drafted a plan in
              plan mode and is awaiting the user's approve/reject decision.
              Rendered inside the composer column so it sits directly above the
              input box; yields to a pending tool approval (which blocks
              everything). */}
          {pendingPlanApproval && !headApproval && (
            <PlanApprovalPrompt
              sessionId={sessionId}
              plan={pendingPlanApproval.plan}
              onViewPlan={() => {
                // Open the plan tab in the editor column (PlanViewer read
                // view) - the same entry as the capsule / plan cards. Seed it
                // with the staged draft (if any prior edits exist) so
                // re-opening the viewer preserves in-progress edits.
                const draft = useSessionStore.getState().planApprovalDraftBySession[sessionId];
                openPlanDrawer(sessionId, draft ?? pendingPlanApproval.plan);
              }}
              onApprove={(editedPlan, feedback) => {
                void submitPlanApproval(pendingPlanApproval.requestId, true, editedPlan, undefined, feedback);
              }}
              onHandoff={(target, feedback) => {
                void handoffPlanApproval(sessionId, pendingPlanApproval.requestId, target, feedback);
              }}
              onReject={(reason) => {
                void submitPlanApproval(pendingPlanApproval.requestId, false, undefined, reason);
              }}
            />
          )}

          {/* Tool-approval card (canUseTool). Rendered in-flow above the input
              box so the message stream shrinks to make room instead of being
              overlaid - the user keeps seeing the streaming data while deciding.
              Highest precedence of the three prompts: plan approval and
              AskUserQuestion are suppressed while a tool approval is the head of
              the queue. */}
          {headApproval && (
            <ApprovalPrompt
              key={headApproval.requestId}
              toolName={headApproval.toolName}
              input={headApproval.input}
              description={headApproval.description}
              queuePosition={
                pendingApprovals.filter((p) => p.sessionId === sessionId).findIndex(
                  (p) => p.requestId === headApproval.requestId,
                ) + 1
              }
              queueTotal={
                pendingApprovals.filter((p) => p.sessionId === sessionId).length
              }
              onDecide={(granted, always) =>
                void decideApproval(headApproval.requestId, granted, always)
              }
            />
          )}

          {/* AskUserQuestion card. Rendered in-flow above the input box so the
              message stream shrinks to make room instead of being overlaid. The
              composer stays visible below but is locked (`textareaLocked`) while
              a question is pending. Renders only when no tool approval or plan
              approval is pending (those take precedence). */}
          {activeQuestion && !headApproval && !pendingPlanApproval && (
            <QuestionPrompt
              questions={activeQuestion}
              onSubmit={(answers) => {
                void submitQuestion(answers, sessionId);
              }}
              onDismiss={dismissQuestion}
            />
          )}
          <div
            className={cn(
              "relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-edge-input bg-surface transition-all duration-200",
              "focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgb(var(--accent)/0.12)]",
              // Highlight the composer while a file-tree drag hovers over it.
              dragOver && "border-accent ring-4 ring-accent/20",
              // Hide the composer card entirely while a bottom prompt (approval /
              // plan approval / question) is visible - the prompt takes its place
              // in the flow. `hidden` (display:none) keeps the component mounted
              // so state (draft, tags, Tiptap history) survives the hide/show.
              hasPendingPrompt && "hidden",
            )}
            onDragOver={(e) => {
              // Only react to OUR file drag (custom MIME). External drags
              // (text, images, files from outside the app) are ignored.
              if (e.dataTransfer.types.includes(FILE_DRAG_MIME)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                if (!dragOver) setDragOver(true);
              }
            }}
            onDragLeave={(e) => {
              // Only clear when leaving the container itself (not when
              // crossing into a child). relatedTarget is null when the
              // pointer leaves to outside the window.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDragOver(false);
              }
            }}
            onDrop={(e) => {
              const path = e.dataTransfer.getData(FILE_DRAG_MIME);
              if (!path) return;
              e.preventDefault();
              setDragOver(false);
              setTags((prev) => [...prev, makeFileTag(path)]);
            }}
          >
            {queue.length > 0 && (
              <div className="border-b border-edge px-2 pt-2 pb-1.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-content-subtle">
                    {t("chat.queue.header")}
                  </span>
                  <button
                    type="button"
                    onClick={() => clearPromptQueue(sessionId)}
                    title={t("chat.queue.clearTitle")}
                    className="shrink-0 rounded px-1 py-0.5 text-[10px] text-content-subtle transition-colors hover:bg-surface-muted hover:text-content"
                  >
                    {t("chat.queue.clear")}
                  </button>
                </div>
                <div className="space-y-1">
                  {queue.map((item, idx) => {
                    const expanded = expandedQueueId === item.id;
                    const isDragging = draggedQueueId === item.id;
                    const isDragOver =
                      dragOverQueueId === item.id && draggedQueueId !== item.id;
                    return (
                      <div
                        key={item.id}
                        draggable
                        onDragStart={(e) => {
                          setDraggedQueueId(item.id);
                          e.dataTransfer.effectAllowed = "move";
                          // Clear text content so Firefox fires dragstart at all.
                          try {
                            e.dataTransfer.setData("text/plain", item.id);
                          } catch {
                            /* noop */
                          }
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          if (draggedQueueId && draggedQueueId !== item.id) {
                            setDragOverQueueId(item.id);
                          }
                        }}
                        onDragLeave={(e) => {
                          // Only clear when leaving the card itself, not when
                          // crossing into a child (relatedTarget still inside).
                          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                            setDragOverQueueId((cur) => (cur === item.id ? null : cur));
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          handleQueueReorder(item.id);
                        }}
                        onDragEnd={() => {
                          setDraggedQueueId(null);
                          setDragOverQueueId(null);
                        }}
                        className={cn(
                          "rounded-md border px-1.5 py-1 text-[11px] text-content transition-colors",
                          expanded
                            ? "border-accent/40 bg-accent/5"
                            : "border-edge bg-surface/50",
                          isDragging && "opacity-40",
                          isDragOver && "border-accent ring-1 ring-accent/30",
                        )}
                      >
                        <div className="flex items-center gap-1">
                          <IconGripVertical
                            size={12}
                            className="shrink-0 cursor-grab text-content-subtle opacity-40"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedQueueId((cur) =>
                                cur === item.id ? null : item.id,
                              )
                            }
                            title={expanded ? t("chat.queue.collapse") : t("chat.queue.expand")}
                            aria-label={expanded ? t("chat.queue.collapse") : t("chat.queue.expand")}
                            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-muted hover:text-content"
                          >
                            {expanded ? (
                              <IconChevronDown size={11} />
                            ) : (
                              <IconChevronRight size={11} />
                            )}
                          </button>
                          <span className="shrink-0 text-[10px] text-content-subtle">
                            {idx + 1}.
                          </span>
                          <span className={cn("min-w-0 flex-1", !expanded && "truncate")}>
                            {item.displayText || t("chat.queue.attachmentsOnly")}
                          </span>
                          {item.attachments && item.attachments.length > 0 && (
                            <span className="flex shrink-0 items-center gap-0.5 text-content-subtle">
                              <IconPaperclip size={11} />
                              <span className="text-[10px]">{item.attachments.length}</span>
                            </span>
                          )}
                          {!expanded && (
                            <div className="flex shrink-0 items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => void sendQueuedPromptNow(sessionId, item.id)}
                                title={t("chat.queue.sendNowTitle")}
                                aria-label={t("chat.queue.sendNow")}
                                className="flex h-3.5 w-3.5 items-center justify-center rounded text-content-subtle transition-colors hover:bg-accent/20 hover:text-accent"
                              >
                                <IconBolt size={10} />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleEditQueuedPrompt(item)}
                                title={t("common.edit")}
                                aria-label={t("common.edit")}
                                className="flex h-3.5 w-3.5 items-center justify-center rounded text-content-subtle transition-colors hover:bg-accent/20 hover:text-content"
                              >
                                <IconPencil size={10} />
                              </button>
                              <button
                                type="button"
                                onClick={() => removeQueuedPrompt(sessionId, item.id)}
                                title={t("chat.queue.removeTitle")}
                                aria-label={t("chat.queue.removeTitle")}
                                className="flex h-3.5 w-3.5 items-center justify-center rounded text-content-subtle transition-colors hover:bg-danger/20 hover:text-danger"
                              >
                                <IconX size={10} />
                              </button>
                            </div>
                          )}
                        </div>
                        {expanded && (
                          <div className="pt-1">
                            <div className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-surface/70 px-1.5 py-1 text-[11px] leading-relaxed text-content">
                              {item.displayText || t("chat.queue.attachmentsOnly")}
                            </div>
                            <div className="mt-1 flex items-center justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => removeQueuedPrompt(sessionId, item.id)}
                                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-content-subtle transition-colors hover:bg-danger/10 hover:text-danger"
                              >
                                <IconX size={11} /> {t("common.remove")}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleEditQueuedPrompt(item)}
                                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-content-muted transition-colors hover:bg-surface-muted hover:text-content"
                              >
                                <IconPencil size={11} /> {t("common.edit")}
                              </button>
                              <button
                                type="button"
                                onClick={() => void sendQueuedPromptNow(sessionId, item.id)}
                                className="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/25"
                              >
                                <IconBolt size={11} /> {t("chat.queue.sendNow")}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 px-2 pt-2">
                {tags.map((tag) => (
                  <ContentTagChip
                    key={tag.id}
                    ref={(el) => {
                      if (el) chipRefs.current.set(tag.id, el);
                      else chipRefs.current.delete(tag.id);
                    }}
                    tag={tag}
                    open={openTagId === tag.id}
                    onToggle={() => {
                      setOpenTagId((cur) => {
                        if (cur === tag.id) return null; // closing
                        // Opening: capture this chip's box so the popover can
                        // anchor to its top-right corner.
                        const el = chipRefs.current.get(tag.id);
                        if (el) setAnchorRect(el.getBoundingClientRect());
                        return tag.id;
                      });
                    }}
                    onRemove={() => {
                      setTags((prev) => prev.filter((t) => t.id !== tag.id));
                      chipRefs.current.delete(tag.id);
                      setOpenTagId((cur) => (cur === tag.id ? null : cur));
                    }}
                  />
                ))}
              </div>
            )}
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                {pendingImages.map((img) => (
                  <div
                    key={img.id}
                    className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-edge bg-surface"
                    title={img.name}
                  >
                    <img
                      src={img.dataUrl}
                      alt={img.name}
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removePendingImage(img.id)}
                      aria-label={t("chat.removeImageName", { name: img.name })}
                      className="absolute right-0.5 top-0.5 hidden h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80 group-hover:flex"
                    >
                      <IconX size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <ComposerEditor
              ref={editorRef}
              editable={!textareaLocked}
              placeholder={
                textareaLocked
                  ? "Claude is working…"
                  : sessionBusy
                    ? t("chat.placeholderQueued")
                    : t("chat.placeholderIdle")
              }
              onChange={handleChange}
              onEnter={handleEnter}
              onHistoryUp={handleHistoryUp}
              onHistoryDown={handleHistoryDown}
              historyNavEnabled={recallEnabled}
              onPromotePaste={handlePromotePaste}
              shouldPromotePaste={(text) => shouldPromoteToTag(text, pasteTagThresholdChars)}
              onPasteFiles={handlePasteFiles}
              className={cn(
                "px-3 pt-2.5 text-sm leading-relaxed text-content",
                (tags.length > 0 || pendingImages.length > 0) && "pt-1.5",
              )}
            />
            <div
              ref={composerActionRowRef}
              className={cn(
                "composer-action-row flex flex-wrap items-center justify-between gap-2 px-2.5 pb-2 pt-1.5",
                composerChipsCollapsed && "composer-row-collapsed",
              )}
            >
              <div className="composer-chips flex min-w-0 flex-1 items-center gap-1">
                {/* Single "+" entry for attachments (files / images) — keeps
                    the action row calm; direct paste / drag-drop still works
                    without opening the menu. */}
                <AttachMenuButton
                  disabled={inputBlocked}
                  onPickFiles={openAttachPicker}
                  onPickImages={() => void handlePickImages()}
                  onSlashCommand={() => insertTriggerChar("/")}
                />
                <ComposerToolbar sessionId={sessionId} />
                {/* Narrow-mode entry: hidden by default (CSS), replaces the chip
                    row while `composer-row-collapsed` is set. Pops a panel
                    hosting the same chips. */}
                <ComposerToolbarToggle sessionId={sessionId} />
              </div>
              {/* Right cluster: mic + provider picker + send, always visible
                  (the chip row collapses in narrow mode; these don't). */}
              <div className="flex shrink-0 items-center gap-1">
                {/* Voice input: mic button with continuous / hold-to-talk modes
                    (mode switchable via the caret menu). `sessionId` wires the
                    voice.dictation keyboard shortcut to THIS pane's mic.
                    Gated on `hasPendingPrompt`, NOT `inputBlocked`: dictation
                    writes into the same textarea that stays editable while a
                    turn runs (type-ahead + enqueue), so the mic keeps working
                    mid-turn; it only locks when a bottom prompt (approval /
                    plan / question) hides the composer. */}
                <MicButton
                  sessionId={sessionId ?? ""}
                  editorRef={editorRef}
                  disabled={hasPendingPrompt}
                />
                {/* SDK picker pinned left of the send button — always visible
                    (unlike the chip row, which collapses in narrow mode); locked
                    to a read-only chip once the thread has messages. */}
                <ProviderDropdown />
                {sessionBusy && !hasComposerContent ? (
                  <button
                    onClick={() => void interrupt()}
                    title={t("chat.stopGenerating")}
                    aria-label={t("chat.stopGenerating")}
                    className={cn(
                      "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-danger text-surface transition-all duration-150 ease-out",
                      "hover:scale-105 hover:brightness-110 active:scale-95 active:brightness-95",
                    )}
                  >
                    <IconPlayerStop size={16} />
                  </button>
                ) : (
                  <button
                    onClick={sessionBusy ? handleEnqueue : handleSend}
                    disabled={!hasComposerContent}
                    title={sessionBusy ? t("chat.enqueue") : t("chat.send")}
                    aria-label={sessionBusy ? t("chat.enqueue") : t("chat.send")}
                    className={cn(
                      "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent text-surface shadow-sm transition-all duration-150 ease-out",
                      "hover:scale-110 hover:brightness-110 hover:shadow-md hover:shadow-accent/20",
                      "active:scale-95 active:brightness-95",
                      "disabled:scale-100 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-content-subtle disabled:shadow-none disabled:hover:scale-100",
                    )}
                  >
                    <IconSend2 size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
          {/* Content-tag preview popover. Fixed-positioned to the clicked
              chip's top-right; rendered outside the composer container so
              it isn't clipped by overflow/border-radius. Anchored only while
              open AND we have a captured chip rect. */}
          {openTagId &&
            anchorRect &&
            (() => {
              const t = tags.find((x) => x.id === openTagId);
              return t ? (
                <TagPopover
                  tag={t}
                  anchorRect={anchorRect}
                  onClose={() => {
                    setOpenTagId(null);
                    setAnchorRect(null);
                  }}
                  onExpand={
                    t.kind === "paste" ? () => handleExpandTag(t.id) : undefined
                  }
                />
              ) : null;
            })()}
          {/* Inline @-mention picker (project file fuzzy search). Anchored
              above the textarea; selecting adds a file tag and removes the
              `@query` token from the input. */}
          <FileMentionPicker
            open={pickerKind === "mention"}
            projectPath={projectPath}
            query={pickerQuery}
            anchorRect={pickerAnchor}
            mode="mention"
            excludePaths={tags
              .filter((t) => t.kind === "file" && t.filePath)
              .map((t) => t.filePath as string)}
            onPick={handleMentionPick}
            onClose={() => setPickerKind(null)}
          />
          {/* Inline /-slash skill picker. Anchored above the textarea;
              selecting inserts `/name ` so the user can add arguments. */}
          <SlashCommandPicker
            open={pickerKind === "slash"}
            query={pickerQuery}
            skills={skills}
            anchorRect={pickerAnchor}
            busy={sessionBusy}
            onPickSkill={handleSlashPick}
            onPickCommand={handleBuiltInPick}
            onClose={() => setPickerKind(null)}
          />
          {/* "Add context" picker opened from the bottom-left + button.
              Multi-select; same project file source as @-mention. */}
          <FileMentionPicker
            open={attachPickerOpen}
            projectPath={projectPath}
            query={attachPickerQuery}
            anchorRect={attachAnchor}
            mode="attach"
            excludePaths={tags
              .filter((t) => t.kind === "file" && t.filePath)
              .map((t) => t.filePath as string)}
            onPick={handleAttachPick}
            onClose={() => setAttachPickerOpen(false)}
          />
        </div>
      </div>

    </div>
  );
}

/** One row in the stream, with role styling. The "You"/"Claude" labels
 *  were removed per design - alignment (user right, assistant left) and
 *  bubble styling carry the role signal. A copy button sits BELOW the
 *  message content - outside the user bubble's border so it doesn't read
 *  as part of the copied text and stays visually separate from the
 *  content area.
 *
 *  For assistant messages: the FIRST message of a turn shows a per-turn
 *  "开始 HH:MM:SS · 用时 12.3s" stat row ABOVE the content. The streaming
 *  tail (the last assistant message while a turn is running) shows a
 *  spinning loader at the bottom of the content.
 *
 *  User messages also get an edit button (pencil icon) next to copy when
 *  the session is idle. Clicking it swaps the bubble for an inline editor
 *  (see UserMessageEditor); submitting the editor truncates the session's
 *  history at this message and resends the edited prompt. */
const MessageRow = memo(function MessageRow({
  msg,
  isStreamingTail,
  isTurnTail,
  beforeMap,
  canEdit,
  isEditing,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  onOpenPlan,
  hideTurnStat,
  projectPath,
}: {
  msg: ChatMessage;
  isStreamingTail?: boolean;
  isTurnTail?: boolean;
  beforeMap?: BeforeContentMap;
  /** Whether the edit affordance should be shown (user message + idle). */
  canEdit?: boolean;
  /** Whether THIS row is currently in inline-edit mode. */
  isEditing?: boolean;
  onStartEdit?: (msg: ChatMessage) => void;
  onSubmitEdit?: (msg: ChatMessage, newText: string, images: PromptImage[]) => void;
  onCancelEdit?: () => void;
  /** Called when the user clicks an inline plan block - opens the plan in
   *  the editor column via openPlanDrawer. */
  onOpenPlan?: (plan: string) => void;
  /** Suppress the per-turn "开始 · 用时" stat row. Set when this row is a
   *  textMsg inside a turnGroup AND a TurnPanel is rendered for that turn
   *  (i.e. the turn had tool calls) - the panel header already shows the
   *  turn's timing, so a second stat line above the reply would be
   *  redundant. Left false for pure-text turns (no panel) so the first reply
   *  message still shows its own stat row. Defaults to false (standalone
   *  single items keep their own). */
  hideTurnStat?: boolean;
  /** Project root for resolving file paths mentioned in the message text /
   *  shown on tool cards. Session-scoped so backgrounded tabs resolve to
   *  their own project. */
  projectPath?: string | null;
}) {
  const { t } = useI18n();
  const isUser = msg.role === "user";
  const copyText = useMemo(() => blocksToText(msg.blocks), [msg.blocks]);
  // User-typed text renders through Markdown, which collapses single "\n"
  // soft breaks into spaces. Map the blocks so user text keeps its typed
  // line breaks visually (see preserveUserLineBreaks); assistant/tool text
  // keeps normal markdown semantics. Identity-stable when nothing changes,
  // so MessageBlocks' memoization still works.
  const renderBlocks = useMemo(() => {
    if (!isUser) return msg.blocks;
    let changed = false;
    const next = msg.blocks.map((b) => {
      if (b.kind !== "text") return b;
      const text = preserveUserLineBreaks(b.text);
      if (text === b.text) return b;
      changed = true;
      return { ...b, text };
    });
    return changed ? next : msg.blocks;
  }, [msg.blocks, isUser]);
  // Only show the copy button on messages with real text content - i.e. the
  // model's substantive answer to the user. A single turn often produces
  // several assistant messages (pure thinking, pure tool_use, then the text
  // reply); copying is only meaningful for the text reply, so we gate on
  // the presence of a non-empty `text` block. Pure-tool / pure-thinking
  // messages have no copy button.
  const hasTextContent = msg.blocks.some((b) => b.kind === "text" && b.text.trim().length > 0);
  // User prompts always get a copy button (on hover). Assistant replies get one
  // ONLY on the turn's final assistant message (isTurnTail) - i.e. after the
  // turn has ended - so intermediate procedural messages stay clean and only
  // one copy affordance appears per completed turn. The button itself is
  // opacity-0 until the row is hovered (group-hover in CopyRow).
  const showCopy = isUser
    ? hasTextContent && !!copyText
    : hasTextContent && !!copyText && isTurnTail;
  // The edit button is only for user messages, only when idle, and only on
  // rows NOT currently being edited (the editor replaces the row).
  const showEdit = isUser && canEdit && !isEditing;

  // ── Inline edit mode ──
  // When editing, the normal bubble is replaced by an editor with a textarea
  // prefilled with the original typed text (attachment blocks are preserved
  // as-is; only the text portion is editable). Enter submits, Escape cancels.
  if (isUser && isEditing) {
    return (
      <div className="mt-5 mb-4 flex justify-end">
        <div className="max-w-[85%] w-full">
          <UserMessageEditor
            msg={msg}
            onSubmit={(newText, images) => onSubmitEdit?.(msg, newText, images)}
            onCancel={() => onCancelEdit?.()}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      // Bookmark anchor: the selection toolbar resolves the message a text
      // selection belongs to by walking up from the selection's anchor node
      // to this attribute; jump-to-bookmark uses it to flash the row after
      // scrolling. Static per row — no effect on the memo shallow-compare.
      data-message-id={msg.id}
      className={cn(
        "group",
        // Vertical rhythm is driven by the chat-density CSS vars (see
        // styles.css). User rows get a larger gap than assistant rows so a
        // new user prompt still reads as a distinct input even in compact
        // mode. mt-[...] preserves the old margin-top semantics.
        isUser
          ? "mt-[var(--chat-row-gap-user)] flex justify-end"
          : "mt-[var(--chat-row-gap-assistant)]",
      )}
    >
      <div className={isUser ? "max-w-[85%] min-w-0" : "w-full min-w-0"}>
        {/* Per-turn stat row - only on the first assistant message of a
            turn (the one carrying turnMeta), and not suppressed by a parent
            TurnPanel (hideTurnStat). Sits above the content. */}
        {!isUser && msg.turnMeta && !hideTurnStat && <TurnStatRow meta={msg.turnMeta} />}
        <div
          // User messages get a native tooltip showing the full send date-time
          // on hover (assistant messages have no createdAt tooltip - the
          // per-turn stat row already shows timing).
          title={isUser ? fmtFullDateTime(msg.createdAt) : undefined}
          className={
            isUser
              ? "overflow-hidden rounded-lg bg-userBubble/10 px-3 py-2 text-content [font-size:var(--chat-font-size)]"
              : "text-content [font-size:var(--chat-font-size)]"
          }
        >
          <MessageBlocks blocks={renderBlocks} beforeMap={beforeMap} isStreamingTail={isStreamingTail} onOpenPlan={onOpenPlan} projectPath={projectPath} />
          {/* Streaming loader at the bottom of the content while this
              message is still receiving deltas. */}
          {isStreamingTail && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <IconLoader2 size={12} className="animate-spin text-accent" />
            </div>
          )}
        </div>
        {/* Action row BELOW the content bubble - outside its border.
            Icon-only, revealed on row hover. User messages right-align the
            buttons (under the right-aligned bubble); assistant messages
            left-align. For user messages the copy + edit buttons sit
            side-by-side; for assistant messages only copy is shown. */}
        {(showCopy || showEdit) && (
          <div
            className={cn(
              "mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100",
              isUser ? "justify-end" : "justify-start",
            )}
          >
            {showCopy && <CopyButton text={copyText} />}
            {showEdit && (
              <button
                type="button"
                onClick={() => onStartEdit?.(msg)}
                title={t("common.edit")}
                aria-label={t("common.edit")}
                className="inline-flex items-center rounded px-1 py-0.5 text-[10px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted"
              >
                <IconPencil size={12} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
export { MessageRow };

/** Flatten a message's blocks into the plain-text payload that the copy
 *  button yields. text→text, thinking→quoted, tool_use→summary, errors
 *  skipped. Keeps copy output predictable for both user prompts and
 *  assistant replies. */
function blocksToText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      out.push(b.text);
    } else if (b.kind === "thinking") {
      const t = b.text.trim();
      if (t) out.push(`> ${t.replace(/\n/g, "\n> ")}`);
    } else if (b.kind === "attachment") {
      // Mirror the composer's delimited format so copied output matches
      // what was actually sent to the model.
      out.push(`--- pasted content (${b.content.length} chars) ---\n${b.content}\n--- end ---`);
    }
    // tool_use and error blocks are intentionally omitted — they're
    // procedural UI, not part of the conversational payload to copy.
  }
  return out.join("\n\n").trim();
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable (sandbox); silently no-op so the
      // message stream stays usable.
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={t("common.copy")}
      aria-label={t("common.copy")}
      className="inline-flex items-center rounded px-1 py-0.5 text-[10px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted"
    >
      {copied ? <IconCheck size={12} className="text-accent" /> : <IconCopy size={12} />}
    </button>
  );
}

/** Extract just the typed text from a user message's blocks (the `text`
 *  block content). Attachment blocks are skipped - they're edited as
 *  preserved attachments, not as editable text. Used to prefill the inline
 *  editor with the user's original wording. */
function userMessageText(blocks: Block[]): string {
  for (const b of blocks) {
    if (b.kind === "text") return b.text;
  }
  return "";
}

/** Narrow the inline editor's editable image list down to the shape the store
 *  re-sends (same mimeType cast the store applies when preserving blocks). */
function toPromptImages(
  images: { id: string; data: string; mimeType: string }[],
): PromptImage[] {
  return images.map(({ data, mimeType }) => ({
    data,
    mimeType: mimeType as PromptImage["mimeType"],
  }));
}

/** Inline editor that replaces a user message bubble when the user clicks
 *  the edit pencil. Renders a textarea prefilled with the original typed
 *  text (attachment blocks are shown as read-only chips above it, matching
 *  the composer's chip-above-textarea layout). The message's image blocks
 *  are shown as composer-style thumbnails with hover-remove buttons so the
 *  user can see and delete them before resending. Enter submits the edit
 *  (truncating the session history at this message and resending), Escape
 *  cancels back to the read-only view. */
function UserMessageEditor({
  msg,
  onSubmit,
  onCancel,
}: {
  msg: ChatMessage;
  onSubmit: (newText: string, images: PromptImage[]) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const initialText = useMemo(() => userMessageText(msg.blocks), [msg.blocks]);
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentBlocks = msg.blocks.filter((b) => b.kind === "attachment");
  // Local editable copy of the message's image blocks — the surviving list is
  // re-sent verbatim on submit (an emptied list drops the images from the
  // resent turn). Ids exist only to give the thumbnails stable React keys.
  const [images, setImages] = useState<{ id: string; data: string; mimeType: string }[]>(() =>
    msg.blocks
      .filter((b): b is Extract<Block, { kind: "image" }> => b.kind === "image")
      .map((b, i) => ({
        id: `edit-img-${msg.id}-${i}`,
        data: b.data,
        mimeType: b.mimeType,
      })),
  );

  // Focus + auto-resize on mount.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    // Place the cursor at the end so the user can immediately append/correct.
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const trimmed = text.trim();
      if (trimmed) onSubmit(trimmed, toPromptImages(images));
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const canSubmit = text.trim().length > 0;

  return (
    <div className="rounded-lg border border-accent/40 bg-userBubble/10 px-3 py-2 [font-size:var(--chat-font-size)]">
      {/* Attachment chips (read-only) - mirror the composer's chip-above-textarea
          layout. Only shown if the original message had attachments. These are
          non-interactive previews (the attachments are preserved as-is on
          resend); editing only touches the text portion. */}
      {attachmentBlocks.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachmentBlocks.map((b, i) =>
            b.kind === "attachment" ? (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent"
                title={b.filePath ?? b.preview}
              >
                {b.attachmentKind === "file" ? (
                  <IconPaperclip size={12} className="opacity-80" />
                ) : null}
                <span className="max-w-[12rem] truncate">{b.preview}</span>
              </span>
            ) : null,
          )}
        </div>
      )}
      {/* Image thumbnails - same visual treatment as the composer's pending
          image strip (h-14 squares, hover-revealed X to remove). */}
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {images.map((img, i) => (
            <div
              key={img.id}
              className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-edge bg-surface"
              title={t("chat.imageN", { n: i + 1 })}
            >
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={t("chat.imageN", { n: i + 1 })}
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                onClick={() => setImages((prev) => prev.filter((p) => p.id !== img.id))}
                aria-label={t("chat.removeImageN", { n: i + 1 })}
                className="absolute right-0.5 top-0.5 hidden h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80 group-hover:flex"
              >
                <IconX size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        rows={1}
        className="w-full resize-none border-0 bg-transparent text-content outline-none placeholder:text-content-subtle"
        style={{ minHeight: "1.5em" }}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-[11px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={() => canSubmit && onSubmit(text.trim(), toPromptImages(images))}
          disabled={!canSubmit}
          className={cn(
            "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors",
            canSubmit
              ? "bg-accent text-white hover:bg-accent/90"
              : "cursor-not-allowed bg-surface-hover text-content-subtle",
          )}
        >
          <IconSend2 size={12} />
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
}

export type { Block };
