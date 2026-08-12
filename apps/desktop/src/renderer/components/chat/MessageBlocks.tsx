import { memo, useState, useMemo, useEffect, useRef, useDeferredValue, type ReactNode, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { cn } from "@renderer/lib/cn.js";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconX,
  IconAlertTriangle,
  IconRobot,
  IconClipboard,
  IconFile,
  IconPhoto,
  // Tool-kind icons (left glyph of each action card).
  IconBulb,
  IconTerminal,
  IconFileSearch,
  IconFilePlus,
  IconReplace,
  IconNotebook,
  IconSearch,
  IconListCheck,
  PiRobot,
  IconWorldWww,
  IconWorldSearch,
  IconHelpCircle,
  IconStack2,
} from "@renderer/lib/icons.js";
import { useNow } from "@renderer/hooks/useNow.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { Block, TurnMeta } from "@renderer/stores/sessionStore.js";
import { Markdown } from "./Markdown.js";
import { DiffView } from "./DiffView.js";
import { PlanStreamBlock } from "./PlanStreamBlock.js";
import { TurnFilesCard } from "./TurnFilesCard.js";
import { CurrentOpTicker } from "./CurrentOpTicker.js";
import { lineDiff, diffSummary } from "@renderer/lib/lineDiff.js";
import { FileLink } from "./FileLink.js";
import { ImageWithPreview } from "@renderer/components/ui/index.js";
import { TagPopover } from "./TagPopover.js";
import { isImageFilePath, type ContentTag } from "@renderer/lib/contentTag.js";
import { BUILT_IN_COMMANDS } from "@renderer/lib/slashCommands.js";

/** Map of absolute file path → its pre-turn content. Built from the
 *  `turn.files` event payload so the Write tool card can diff the new
 *  `input.content` against what was on disk before the turn. Empty when
 *  the turn is still running (no turn.files yet) or after a rewind — in
 *  those cases Write falls back to a plain new-content preview. */

export type BeforeContentMap = Map<string, string>;

/** Stable empty array returned by {@link useKnownSkillNames} when no skills or
 *  commands are known yet (e.g. before the skill list finishes loading). Using
 *  a module-level constant avoids triggering Markdown's useMemo on every call. */
const EMPTY_SKILL_NAMES: ReadonlyArray<string> = [];

/** All skill names + built-in command names currently known to the app. Used
 *  by text-block rendering so that ANY `/<name>` occurrence in message text is
 *  highlighted — not just the ones explicitly inserted as pills in the composer
 *  (which are recorded in `block.skillNames`). This covers plain-typed
 *  references and DB-restored messages where `skillNames` was never set.
 *
 *  Memoized on the store's `skills` array reference (stable unless the skill
 *  list changes), so every caller gets the same array identity for free. */
function useKnownSkillNames(): ReadonlyArray<string> {
  const skills = useSessionStore((s) => s.skills);
  return useMemo(() => {
    if (skills.length === 0) {
      // Still include built-in commands even before skills load.
      const cmdOnly = BUILT_IN_COMMANDS.map((c) => c.name);
      return cmdOnly.length > 0 ? cmdOnly : EMPTY_SKILL_NAMES;
    }
    const names = new Set<string>();
    for (const s of skills) names.add(s.name);
    for (const c of BUILT_IN_COMMANDS) names.add(c.name);
    return Array.from(names);
  }, [skills]);
}

/** Toggle a collapsible card while keeping the clicked header at the same
 *  viewport position. Without this, expanding a card inserts content below
 *  the header and the virtual list's height recompute pushes everything
 *  down - the header the user just clicked scrolls out of view. We snapshot
 *  the header's `rect.top` before the state flip and, after the DOM updates
 *  (rAF), scroll the nearest scroll container by the delta so the header
 *  lands back where it was. Collapsing is a no-op scroll (content above the
 *  fold never moves; only content below shrinks). */
function toggleHoldPosition(
  e: React.MouseEvent<HTMLButtonElement>,
  setOpen: (updater: (v: boolean) => boolean) => void,
) {
  const btn = e.currentTarget;
  const beforeTop = btn.getBoundingClientRect().top;
  setOpen((v) => !v);
  requestAnimationFrame(() => {
    const afterTop = btn.getBoundingClientRect().top;
    const delta = afterTop - beforeTop;
    if (delta === 0) return;
    // Walk up to the nearest scroll container and adjust its scrollTop.
    let el: HTMLElement | null = btn.parentElement;
    while (el) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY)) {
        el.scrollTop += delta;
        return;
      }
      el = el.parentElement;
    }
  });
}

/** Render the content blocks of a message.
 *
 *  In the turn-level aggregation model (ChatPane's `groupMessagesForRender`),
 *  a turn is split into a `TurnPanel` (all thinking + tool calls) and one or
 *  more "text messages" carrying only display blocks (text / plan /
 *  turn-files / error / attachment). MessageBlocks renders those display
 *  messages; the procedural surface is owned by TurnPanel.
 *
 *  A residual `groupBlocks` defense is kept: if a stray thinking/tool_use
 *  block ever reaches this path (legacy data, future invariant drift), it
 *  still collapses into a TurnPanel instead of polluting the prose stream. */
const MessageBlocks = memo(function MessageBlocks({
  blocks,
  beforeMap,
  isStreamingTail,
  onOpenPlan,
  projectPath,
}: {
  blocks: Block[];
  /** Pre-turn file contents for Write-tool diffing. Forwarded down to any
   *  procedural group rendered inside this message (the single-message
   *  path - the cluster path in ChatPane passes beforeMap directly to
   *  TurnPanel). */
  beforeMap?: BeforeContentMap;
  /** When true, this message is the last one in the stream and is still
   *  receiving content deltas. Instructs text blocks to skip expensive
   *  Markdown parsing and render as raw text until streaming settles. */
  isStreamingTail?: boolean;
  /** Called when the user clicks an inline plan block - opens the right-side
   *  PlanDrawer with that plan's full markdown content. Forwarded to
   *  PlanStreamBlock via BlockView. */
  onOpenPlan?: (plan: string) => void;
  /** Project root for resolving file paths mentioned in text / shown on tool
   *  cards. Session-scoped (the owning project of this message's session), so
   *  backgrounded tabs resolve correctly. */
  projectPath?: string | null;
}) {
  if (blocks.length === 0) return null;
  const segments = groupBlocks(blocks);
  return (
    <div className="space-y-[var(--chat-block-gap)]">
      {segments.map((seg, i) =>
        seg.kind === "single" ? (
          <BlockView key={i} block={seg.block} defaultOpen={seg.defaultOpen} beforeMap={beforeMap} isStreamingTail={isStreamingTail} onOpenPlan={onOpenPlan} projectPath={projectPath} />
        ) : seg.kind === "gallery" ? (
          <ImageGallery key={i} blocks={seg.blocks} />
        ) : (
          <BatchToolGroup key={i} blocks={seg.blocks} beforeMap={beforeMap} turnActive={isStreamingTail} projectPath={projectPath} />
        ),
      )}
    </div>
  );
});
export { MessageBlocks };

export type ToolUseBlock = Extract<Block, { kind: "tool_use" }>;
export type ThinkingBlock = Extract<Block, { kind: "thinking" }>;
/** Procedural blocks are the "model action" surface — thinking and tool
 *  calls. Used by `groupBlocks` to classify which blocks can be grouped. */
export type ProceduralBlock = ThinkingBlock | ToolUseBlock;
type Segment =
  | { kind: "single"; block: Block; defaultOpen?: boolean }
  | { kind: "batch"; blocks: ToolUseBlock[] }
  | { kind: "gallery"; blocks: Extract<Block, { kind: "image" }>[] };

/** Tool calls that are HIGH-FREQUENCY, LOW-INFO operations - the model fires
 *  off Read/Bash/Grep/Glob in long bursts while exploring. Collapsing these
 *  into a single "操作集合" card keeps the stream scannable; each individual
 *  call's detail is rarely worth the vertical space. MultiEdit/TodoWrite are
 *  included too: they're mechanical (batch edits / task-list updates), not
 *  narrative. The ticker on the group header still shows what's running live.
 *
 *  Provider-neutral: Claude (claude-sdk) capitalizes tool names (Read/Grep/…)
 *  while Pi (pi-sdk) lowercases them (read/grep/…). The renderer sees raw
 *  toolName strings, so the set carries BOTH casings plus Pi-only tools
 *  (find = Pi's glob, ls = Pi-only) — this keeps grouping working without
 *  forcing every call site to normalize. See pi sdk core/tools/*.js. */
const BATCH_TOOL_NAMES = new Set([
  // Claude (capitalized)
  "Read", "Glob", "Grep",
  "Bash", "PowerShell",
  "MultiEdit", "NotebookEdit",
  "TodoWrite", "TaskCreate", "TaskUpdate",
  "WebSearch", "WebFetch",
  // Pi (lowercase) — find is Pi's glob, ls is Pi-only
  "read", "find", "grep", "bash", "ls",
]);
function isBatchTool(b: Block): b is ToolUseBlock {
  return b.kind === "tool_use" && BATCH_TOOL_NAMES.has(b.toolName);
}

/** Linear scan over a turn's blocks, producing render segments.
 *
 *  Grouping rule (by "is this worth independent vertical space?"):
 *   - BATCH tools (Read/Bash/Grep/...) -> accumulate into a `batch` run; the
 *     run survives across interleaved text (narration between commands) so a
 *     burst of N reads + commentary folds into ONE group card, not N cards.
 *   - thinking, Task (subagent), AskUserQuestion, Edit, Write -> always
 *     standalone: they break the batch run and emit as their own segment.
 *   - text / error -> standalone, but do NOT break the run (so a batch burst
 *     split by narration still merges back into one group).
 *
 *  This is the inverse of the old behavior which grouped thinking INTO the
 *  tool run; thinking is now pulled out as a peer, and only low-info batch
 *  tools collapse together. Edit/Write breaking the run is preserved. */
function groupBlocks(blocks: Block[]): Segment[] {
  const out: Segment[] = [];
  let run: ToolUseBlock[] = [];
  let images: Extract<Block, { kind: "image" }>[] = [];
  const flushTools = () => {
    if (run.length > 0) {
      out.push({ kind: "batch", blocks: run });
      run = [];
    }
  };
  const flushImages = () => {
    if (images.length > 0) {
      // A single image renders standalone (so BlockView's image case handles
      // it); 2+ consecutive images become a swipeable gallery.
      if (images.length === 1) {
        out.push({ kind: "single", block: images[0], defaultOpen: false });
      } else {
        out.push({ kind: "gallery", blocks: images });
      }
      images = [];
    }
  };
  for (const b of blocks) {
    if (b.kind === "image") {
      // Images don't break a tool batch, but a tool breaks an image run.
      flushTools();
      images.push(b);
    } else if (isBatchTool(b)) {
      flushImages();
      run.push(b);
    } else {
      // thinking / standalone tool / text / error / other blocks break both runs.
      flushTools();
      flushImages();
      out.push({ kind: "single", block: b, defaultOpen: false });
    }
  }
  flushTools();
  flushImages();
  return out;
}

/** A collapsible card for a run of consecutive BATCH tool calls (Read/Bash/
 *  Grep/...) INSIDE an expanded TurnPanel. One summary line when collapsed
 *  (tool tally + live ticker), each child tool card folded underneath when
 *  expanded. Only low-info batch tools land here; thinking, Task (subagent),
 *  AskUserQuestion, Edit and Write are pulled out by groupBlocks as their own
 *  standalone rows - so this group never hides a high-signal action. */
function BatchToolGroup({
  blocks,
  beforeMap,
  turnActive = false,
  projectPath,
}: {
  blocks: ToolUseBlock[];
  beforeMap?: BeforeContentMap;
  /** Whether the owning turn is still streaming. Drives the current-operation
   *  ticker on the header so the user can see what this group is executing
   *  right now. Clears when the turn ends so historical cards never show a
   *  stale operation. */
  turnActive?: boolean;
  projectPath?: string | null;
}) {
  const [open, setOpen] = useState(false);

  const aggregateStatus: "running" | "done" | "error" = blocks.some((b) => b.status === "running")
    ? "running"
    : blocks.some((b) => b.status === "error")
      ? "error"
      : "done";

  // The newest tool currently executing inside this group (drives the header
  // ticker). Reverse scan picks the most recent running tool.
  const runningTool = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].status === "running") return blocks[i];
    }
    return null;
  }, [blocks]);

  // Tool-name tally in first-invocation order.
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(b.toolName, (counts.get(b.toolName) ?? 0) + 1);
  const breakdown = [...counts.entries()].map(([n, c]) => `${n} ×${c}`).join(" · ");

  const label = `${blocks.length} 个操作`;

  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        onClick={(e) => toggleHoldPosition(e, setOpen)}
        className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-surface-muted/40"
      >
        {/* 操作集合: a stack of layers reads as "a set of folded operations",
            clearer than the toolbox wrench for the N-ops batch header. */}
        <IconStack2 size={13} className="shrink-0 text-content-subtle" />
        <span className="font-medium text-content-muted">{label}</span>
        {breakdown && <span className="truncate text-content-subtle">{breakdown}</span>}
        {/* Live current-operation ticker - only while the turn is streaming.
            Sits right of the tool tally and rolls up like a slot machine as
            the agent moves between commands. Rendered inside the <button>
            (CurrentOpTicker emits only phrasing content). */}
        {turnActive && <CurrentOpTicker op={runningTool} turnActive={turnActive} />}
        {/* Error marker on the right - success needs no glyph, only failures
            surface so the user can spot the broken call without expanding. */}
        {aggregateStatus === "error" && <StatusIcon status="error" />}
        <Chevron open={open} className="ml-auto" />
      </button>
      {open && (
        // Cap height so a large batch (20 reads) doesn't stretch the stream;
        // the list scrolls internally instead. The left border marks this as
        // an expanded group body, visually nested under its header.
        <div className="max-h-80 space-y-1.5 overflow-y-auto border-l border-edge py-1 pl-2">
          {blocks.map((b, i) => (
            <BlockView key={i} block={b} beforeMap={beforeMap} projectPath={projectPath} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Render a collapsible chevron icon (▾ when open, ▸ when closed). An optional
 *  className is merged in (e.g. "ml-auto" to pin the arrow to the row's right
 *  edge when a ticker sits between the tally and the chevron). */
function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <IconChevronDown
      size={12}
      className={cn(
        "shrink-0 text-content-subtle transition-transform",
        !open && "-rotate-90",
        className,
      )}
    />
  );
}

/** A swipeable gallery for 2+ consecutive screenshot image blocks (e.g. the
 *  model captured several pages in one turn). Shows one thumbnail at a time
 *  with ◀ ▶ arrows + a position counter (2/5). Clicking the thumbnail opens
 *  the fullscreen ImageWithPreview lightbox for the current image.
 *
 *  Single images never reach here — `groupBlocks` renders a lone image via the
 *  normal BlockView image case. This component only assembles runs of 2+. */
function ImageGallery({ blocks }: { blocks: Extract<Block, { kind: "image" }>[] }) {
  const [idx, setIdx] = useState(0);
  const count = blocks.length;
  const cur = blocks[Math.min(idx, count - 1)];
  const go = (delta: number) => setIdx((i) => Math.max(0, Math.min(count - 1, i + delta)));
  // All images of this gallery as data URLs — passed to the lightbox so it can
  // navigate prev/next inside the fullscreen preview too.
  const allSrcs = blocks.map((b) => `data:${b.mimeType};base64,${b.data}`);
  return (
    <div className="my-1 flex flex-col items-start gap-1">
      <div className="relative">
        <ImageWithPreview
          src={`data:${cur.mimeType};base64,${cur.data}`}
          alt={`截图 ${Math.min(idx, count - 1) + 1}/${count}`}
          gallery={allSrcs}
          index={idx}
          onNavigate={setIdx}
        />
        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={idx <= 0}
              title="上一张"
              className="absolute left-1 top-1/2 -translate-y-1/2 rounded-full bg-black/55 p-1.5 text-white/90 backdrop-blur-sm transition-colors enabled:hover:bg-black/80 enabled:hover:text-white disabled:opacity-30"
            >
              <IconChevronLeft size={18} />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              disabled={idx >= count - 1}
              title="下一张"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-black/55 p-1.5 text-white/90 backdrop-blur-sm transition-colors enabled:hover:bg-black/80 enabled:hover:text-white disabled:opacity-30"
            >
              <IconChevronRight size={18} />
            </button>
          </>
        )}
      </div>
      {count > 1 && (
        <div className="flex items-center justify-center gap-1 text-[11px] text-content-subtle">
          <span>{Math.min(idx, count - 1) + 1} / {count}</span>
          {/* Dot indicators for quick jump. */}
          <span className="ml-1.5 flex items-center gap-1">
            {blocks.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIdx(i)}
                title={`第 ${i + 1} 张`}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === idx ? "w-3 bg-accent" : "w-1.5 bg-content-subtle/40 hover:bg-content-subtle/70",
                )}
              />
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

/** Status icon for tool calls: error→X, running/done→nothing. Running and
 *  done are the common states and don't need a glyph — when the status is
 *  empty the card's own tool icon occupies this slot, and the stream's
 *  single loading indicator already lives at the bottom (isStreamingTail
 *  spinner). Per-card spinners would only add noise, so only surface a glyph
 *  when something actually went wrong. */
function StatusIcon({ status }: { status: "running" | "done" | "error" }) {
  if (status === "error") {
    return <IconX size={12} className="text-danger" />;
  }
  return null;
}

/** Collapsible panel that hides a whole turn's process data (thinking +
 *  tool calls + any text the model emitted between tool calls, like "let me
 *  read this file first") behind a one-line "HH:MM:SS · NN.Ns" header. This is
 *  the boundary between "model process" and "model output for the user":
 *  everything up to and including the last tool call lives inside this panel,
 *  while only the final reply text (after the last tool) renders outside it
 *  and stays visible.
 *
 *  Inside the expanded panel, blocks are grouped by signal value (see
 *  `groupBlocks`): high-frequency/low-info BATCH tools (Read/Bash/Grep/...)
 *  collapse into a single "操作集合" card so a burst of 20 reads takes one
 *  line, not 20; while thinking, Task (subagent), AskUserQuestion, Edit and
 *  Write render as their own standalone rows - they're high-signal and
 *  shouldn't be buried inside a collapsed group.
 *
 *  - While the turn is still running (turnMeta.endedAt undefined) the panel
 *    stays OPEN by default so the user can watch the model work; the header
 *    shows a live-ticking duration plus a "current operation" ticker (what the
 *    model is doing right now, rolling like a slot machine as it moves between
 *    commands).
 *  - The panel collapses ONLY when the turn ends (turn.done sets endedAt) -
 *    not when the final reply text starts streaming. The user can still
 *    re-expand by clicking.
 *  - The header is a centered pill flanked by gradient rules: chevron +
 *    "HH:MM:SS · NN.Ns" + live ticker. An accent pulse dot (shown only
 *    while turnActive) signals the running state alongside the live
 *    duration. */
export function TurnPanel({
  blocks,
  beforeMap,
  turnActive = false,
  turnMeta,
  onOpenPlan,
  onToggleCollapse,
  projectPath,
}: {
  /** The turn's process blocks in order: thinking, tool calls, and any text
   *  the model produced between tools. Text blocks are rendered inline inside
   *  the expanded panel (as process narration), NOT as the user-facing reply. */
  blocks: Block[];
  /** Pre-turn file contents for Write-tool diffing. Forwarded down to
   *  WriteToolCard so diffs render inside the expanded panel. */
  beforeMap?: BeforeContentMap;
  /** Whether this turn is the live streaming tail. Drives the header's
   *  "current operation" ticker (shows what the model is doing right now) and
   *  clears it when the turn ends so completed cards never show a stale
   *  operation. Does NOT control collapse - that's tied to turnMeta.endedAt
   *  so the panel stays open for the whole run. */
  turnActive?: boolean;
  /** The turn's timing metadata. `startedAt` feeds the header clock and the
   *  duration baseline; `endedAt` undefined means the turn is still running
   *  (duration ticks live via useNow). */
  turnMeta?: TurnMeta;
  /** Forwarded to BlockView for plan blocks (opens the PlanDrawer). */
  onOpenPlan?: (plan: string) => void;
  /** Fired the instant the panel is toggled by the user OR auto-collapsed at
   *  the reply boundary. The parent (ChatPane) uses it to briefly suspend
   *  LegendList's maintainScrollAtEnd so the height transition doesn't fight
   *  a snap-to-bottom on every transition frame ("往上挤/闪一下"). */
  onToggleCollapse?: () => void;
  /** Project root for file-path resolution, forwarded to BlockView. */
  projectPath?: string | null;
}) {
  const completed = turnMeta?.endedAt !== undefined;
  // Defaults OPEN while the turn is still running AND the model hasn't moved
  // into its final reply yet (turnActive) — so the user can watch the model
  // work. The moment the final reply starts streaming (or the turn ends,
  // which also flips turnActive to false) the panel auto-collapses so the
  // user's focus moves to the reply text below; historical (ended) turns
  // start collapsed. LegendList recycles/remounts items during streaming, so
  // seeding from BOTH flags (not just `completed`) means a remount mid-reply
  // lands collapsed instead of re-expanding the already-finished process
  // surface.
  const [open, setOpen] = useState(!completed && turnActive);

  // Auto-collapse the runtime turnActive true→false edge: a remount isn't
  // guaranteed at the reply boundary (the panel often stays mounted across
  // the flip), so watch the prop directly. Collapse happens once, when the
  // model stops doing process work; a user manually re-expanding a finished
  // panel afterwards is never force-collapsed by this effect (no further
  // true→false edge occurs).
  const prevTurnActive = useRef(turnActive);
  useEffect(() => {
    if (prevTurnActive.current && !turnActive) {
      // Pause bottom-anchoring for the collapse transition too — otherwise the
      // auto-collapse at the reply boundary snaps scroll and re-flashes.
      onToggleCollapse?.();
      setOpen(false);
    }
    prevTurnActive.current = turnActive;
  }, [turnActive, onToggleCollapse]);

  const toolBlocks = blocks.filter((b): b is ToolUseBlock => b.kind === "tool_use");

  // The newest tool currently executing in this turn (drives the header
  // ticker). Reverse scan picks the most recent running tool so the ticker
  // always reflects the live operation, not a stale earlier one.
  const runningTool = useMemo(() => {
    for (let i = toolBlocks.length - 1; i >= 0; i--) {
      if (toolBlocks[i].status === "running") return toolBlocks[i];
    }
    return null;
  }, [toolBlocks]);

  // Live duration via the app-wide 1s clock. Frozen turns compute a static
  // value (endedAt - startedAt) and the useNow subscription is harmless
  // (returns the same value every tick). This mirrors TurnStatRow's approach.
  const now = useNow();
  const startedAt = turnMeta?.startedAt ?? now;
  const duration = Math.max(0, (turnMeta?.endedAt ?? now) - startedAt);

  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <div className="my-2 flex items-center gap-2.5">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent to-edge" />
        <button
          onClick={(e) => {
            // Pause maintainScrollAtEnd BEFORE toggling so LegendList doesn't
            // snap-scroll against the height transition mid-flight.
            onToggleCollapse?.();
            toggleHoldPosition(e, setOpen);
          }}
          className="flex items-center gap-1.5 rounded-full border border-edge bg-surface-muted px-3 py-1 text-xs shadow-sm transition-colors hover:bg-surface-hover/60"
        >
          {turnActive && (
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
          )}
          <Chevron open={open} />
          <span className="tabular-nums text-content-muted">{fmtClock(startedAt)}</span>
          <span className="text-content-subtle">·</span>
          <span className="tabular-nums text-content-muted">{fmtDuration(duration)}</span>
          {/* Live current-operation ticker - only while the turn is streaming.
              Sits right of the duration and rolls up like a slot machine as the
              agent moves between commands. Rendered inside the <button>
              (CurrentOpTicker emits only phrasing content). Clears when the turn
              ends so historical cards never show a stale operation. */}
          {turnActive && <CurrentOpTicker op={runningTool} turnActive={turnActive} />}
        </button>
        <div className="h-px flex-1 bg-gradient-to-l from-transparent to-edge" />
      </div>
      {/* Smooth height transition via the grid-template-rows 0fr→1fr trick.
          The outer grid animates its single track between 0 (collapsed) and
          1fr (expanded); the inner overflow-hidden wrapper is what lets the
          0fr track actually collapse to zero (grid items default to
          min-height:auto, which overflow:hidden zeroes out). Content stays
          mounted in both states — it's just clipped — so remounting mid-stream
          never re-flashes the blocks. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-1.5 py-2">
            {groupBlocks(blocks).map((seg, i) =>
              seg.kind === "single" ? (
                <BlockView
                  key={i}
                  block={seg.block}
                  defaultOpen={seg.defaultOpen}
                  beforeMap={beforeMap}
                  onOpenPlan={onOpenPlan}
                  projectPath={projectPath}
                />
              ) : seg.kind === "gallery" ? (
                <ImageGallery key={i} blocks={seg.blocks} />
              ) : (
                <BatchToolGroup
                  key={i}
                  blocks={seg.blocks}
                  beforeMap={beforeMap}
                  turnActive={turnActive}
                  projectPath={projectPath}
                />
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const BlockView = memo(function BlockView({
  block,
  defaultOpen = false,
  beforeMap,
  isStreamingTail,
  onOpenPlan,
  projectPath,
}: {
  block: Block;
  defaultOpen?: boolean;
  beforeMap?: BeforeContentMap;
  /** Formerly drove a raw-text short-circuit for the streaming tail; now
   *  unused by the text branch (markdown renders progressively via
   *  useDeferredValue instead). Kept on the signature for interface
   *  stability - MessageBlocks still forwards it down. */
  isStreamingTail?: boolean;
  /** Forwarded to PlanStreamBlock - opens the PlanDrawer on click. */
  onOpenPlan?: (plan: string) => void;
  /** Project root for resolving file paths in text blocks and tool cards. */
  projectPath?: string | null;
}) {
  // Known skill/command names — used to highlight /name references in text
  // blocks regardless of whether they were inserted as pills (block.skillNames)
  // or typed as plain text. See useKnownSkillNames.
  const knownSkillNames = useKnownSkillNames();

  switch (block.kind) {
    case "text": {
      // useDeferredValue throttles the markdown re-parse: `block.text` updates
      // every delta (~60 Hz) but `deferredText` only advances when React has
      // idle time, so <Markdown> (memoized) re-renders at a paced cadence
      // instead of every frame. Markdown thus appears PROGRESSIVELY during
      // streaming and converges naturally when the turn ends - no more
      // "raw text until done, then flip to markdown" delay.
      //
      // We deliberately no longer fall back to whitespace-pre-wrap while
      // streaming (the old `isStreamingTail || isStale` short-circuit): that
      // held the whole message as plain text for the entire turn, which is
      // what users perceived as "markdown rendering lag". Shiki highlighting
      // of code blocks is itself deferred inside <Markdown> (lazy highlighter
      // singleton + LRU cache + useMemo on rawCode), so the expensive path is
      // already guarded without sacrificing live markdown formatting.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const deferredText = useDeferredValue(block.text);
      // Merge pill-recorded names with the full known set so that plain-typed
      // /name references (and DB-restored messages without skillNames) also
      // highlight. When block.skillNames is empty this is just knownSkillNames
      // (stable reference) so Markdown's memo isn't broken.
      const skillNames =
        block.skillNames && block.skillNames.length > 0
          ? Array.from(new Set([...block.skillNames, ...knownSkillNames]))
          : knownSkillNames;
      return (
        <Markdown projectPath={projectPath} skillNames={skillNames}>
          {deferredText}
        </Markdown>
      );
    }

    case "thinking":
      return (
        <Collapsible label="Thinking" hint={summarize(block.text)} defaultOpen={defaultOpen}>
          {block.text}
        </Collapsible>
      );

    case "tool_use":
      return <ToolCard block={block} defaultOpen={defaultOpen} beforeMap={beforeMap} projectPath={projectPath} />;

    case "attachment":
      return (
        <AttachmentCard
          preview={block.preview}
          content={block.content}
          attachmentKind={block.attachmentKind}
          filePath={block.filePath}
        />
      );;

    case "error":
      return (
        <div className="flex items-start gap-1.5 rounded-md border border-danger bg-danger/30 px-3 py-2 text-danger [font-size:var(--chat-fs-sm)]">
          <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{block.message}</span>
        </div>
      );

    case "plan":
      // Inline read-only plan card that lives in the message stream as a
      // per-turn trailing block (drafting -> 待审阅 -> 已就绪). Clicking it
      // opens the right-side PlanDrawer to view the full plan content; the
      // actionable approve/reject sheet stays above the composer in
      // PlanApprovalPrompt.
      return (
        <PlanStreamBlock
          plan={block.plan}
          phase={block.phase}
          hasApproval={block.hasApproval}
          onOpenPlan={onOpenPlan}
          projectPath={projectPath}
        />
      );

    case "turn-files":
      // Inline "本轮修改" card that lives in the message stream as a per-turn
      // trailing block. Frozen at turn.done so each turn keeps its own card in
      // history. Every card is rewindable: the latest via the live snapshot,
      // historical ones via their persisted entries (works after session
      // reopen too). A rewound card (block.rewound) renders dimmed with no
      // button. TurnFilesCard pulls rewindTurn from the store itself.
      return (
        <TurnFilesCard
          files={block.files}
          isLatestTurn={block.isLatestTurn}
          rewound={block.rewound}
        />
      );

    case "compact-summary": {
      // Inline card shown after a context compaction (manual /compact or
      // auto). Tells the user the history was summarized and how many tokens
      // were freed, so the silence after /compact isn't confusing.
      const saved = block.postTokens != null
        ? Math.max(0, block.preTokens - block.postTokens)
        : null;
      const pct = block.postTokens != null && block.preTokens > 0
        ? Math.round((saved! / block.preTokens) * 100)
        : null;
      return (
        <div className="flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 [font-size:var(--chat-fs-sm)]">
          <IconStack2 size={14} className="shrink-0 text-accent" />
          <span className="text-content">
            {block.trigger === "manual" ? "已手动压缩对话历史" : "已自动压缩对话历史"}
            {saved != null && (
              <span className="text-content-muted">
                {" "}· 释放 {saved.toLocaleString()} tokens{pct != null ? ` (${pct}%)` : ""}
              </span>
            )}
            {block.postTokens != null && (
              <span className="text-content-subtle">
                {" "}· {block.preTokens.toLocaleString()} → {block.postTokens.toLocaleString()}
              </span>
            )}
          </span>
        </div>
      );
    }

    case "image":
      // An agent-captured screenshot (browser_screenshot), rendered inline next
      // to its tool_use card as a compact thumbnail. Click opens a fullscreen
      // lightbox (Dialog-based) for full-size inspection.
      return (
        <ImageWithPreview
          src={`data:${block.mimeType};base64,${block.data}`}
          alt="浏览器截图"
          className="my-1"
        />
      );
  }
});
export { BlockView };

/** A pasted-content or file-reference attachment shown as a chip-like card in
 *  the message stream. Mirrors the composer's ContentTagChip visual language
 *  (accent theme color) so an attachment reads the same before and after
 *  sending.
 *
 *  - Paste attachments (attachmentKind="paste" or undefined): clipboard icon,
 *    one-line preview. CLICKING opens a floating `TagPopover` anchored to the
 *    chip — exactly the same UX as the composer's ContentTagChip. No
 *    "拆开" (expand-into-editor) action: once sent, the text belongs to the
 *    user's message, not to the composer, so there's no editor to inline into.
 *  - File attachments (attachmentKind="file"): file icon + name; CLICKING opens
 *    the file in the center IDE editor (markdown renders, images preview, text
 *    edits — the editor picks the view from the extension). The full path lives
 *    in the hover title. Legacy file cards without a path fall back to the
 *    paste-style popover.
 *
 *  The popover uses `position: fixed` (viewport coordinates), so scrolling the
 *  message stream does NOT move it — the popover stays put while the chip
 *  scrolls out from under it. This matches the composer behavior and avoids
 *  the fragility of an inline expand inside the (potentially virtualized)
 *  message list. The popover is dismissed on outside-click / ESC / re-click
 *  (handled by TagPopover internally + this toggle). */
function AttachmentCard({
  preview,
  content,
  attachmentKind,
  filePath,
}: {
  preview: string;
  content: string;
  attachmentKind?: "paste" | "file";
  filePath?: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const isFile = attachmentKind === "file";
  const isImage = isFile && !!filePath && isImageFilePath(filePath);

  // Non-image file cards open the file in the IDE editor (per-type view
  // handled by the editor: markdown rendered, text edited). Paste cards AND
  // image file cards open the TagPopover — images render an in-popover
  // preview (loaded via api.file.readBinary), same UX as the composer chip;
  // legacy path-less file cards fall back to the popover too.
  const handleClick = () => {
    if (isFile && filePath && !isImage) {
      useSessionStore.getState().openFileInIde(filePath);
      return;
    }
    if (open) {
      setOpen(false);
      setAnchorRect(null);
      return;
    }
    const el = btnRef.current;
    setAnchorRect(el ? el.getBoundingClientRect() : null);
    setOpen(true);
  };

  const closePopover = () => {
    setOpen(false);
    setAnchorRect(null);
  };

  // TagPopover expects a ContentTag; build a minimal one from the attachment.
  const tag: ContentTag = {
    id: "attachment",
    kind: attachmentKind === "file" ? "file" : "paste",
    preview,
    content,
    filePath,
  };

  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        ref={btnRef}
        onClick={handleClick}
        title={
          isFile && !isImage
            ? (filePath ?? preview)
            : open
              ? isImage
                ? "收起图片"
                : "收起内容"
              : isImage
                ? "查看图片"
                : "查看内容"
        }
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
          open
            ? "border-accent bg-accent/20 text-accent"
            : "border-accent/40 bg-accent/10 text-accent hover:border-accent/70 hover:bg-accent/20",
        )}
      >
        {isFile ? (
          isImage ? (
            <IconPhoto size={12} className="opacity-80" />
          ) : (
            <IconFile size={12} className="opacity-80" />
          )
        ) : (
          <IconClipboard size={12} className="opacity-80" />
        )}
        <span className="max-w-[220px] truncate">{preview}</span>
        {(!isFile || isImage) && (
          <IconChevronDown
            size={11}
            className={cn("shrink-0 opacity-70 transition-transform", !open && "-rotate-90")}
          />
        )}
      </button>
      {open &&
        anchorRect &&
        // Render via a portal to document.body so the popover escapes the
        // virtualized list item's `contain: paint layout style` (applied by
        // @legendapp/list). That containment establishes a new containing block
        // for the popover's `position: fixed` and clips its paint, which would
        // otherwise mis-position and hide the popover. The composer achieves
        // the same effect by lifting its TagPopover out of its container.
        createPortal(
          <TagPopover tag={tag} anchorRect={anchorRect} onClose={closePopover} />,
          document.body,
        )}
    </div>
  );
}

/** Dispatcher for tool_use blocks. Edit and Write get dedicated renderers
 *  (diff + content preview) because their input shape is rich enough to
 *  deserve more than a JSON dump. Everything else falls through to the
 *  generic ToolCard. `defaultOpen` lets the parent ToolGroup force all
 *  contained cards to render their body at once. */
function ToolCard({
  block,
  defaultOpen = false,
  beforeMap,
  projectPath,
}: {
  block: Extract<Block, { kind: "tool_use" }>;
  defaultOpen?: boolean;
  beforeMap?: BeforeContentMap;
  projectPath?: string | null;
}) {
  if (block.toolName === "Edit" && isEditInput(block.input)) {
    return (
      <EditToolCard
        filePath={block.input.file_path}
        oldString={block.input.old_string}
        newString={block.input.new_string}
        status={block.status}
        result={block.result}
        defaultOpen={defaultOpen}
        projectPath={projectPath}
      />
    );
  }
  if (block.toolName === "Write" && isWriteInput(block.input)) {
    return (
      <WriteToolCard
        filePath={block.input.file_path}
        content={block.input.content}
        status={block.status}
        result={block.result}
        defaultOpen={defaultOpen}
        beforeMap={beforeMap}
        projectPath={projectPath}
      />
    );
  }
  return <GenericToolCard block={block} defaultOpen={defaultOpen} projectPath={projectPath} />;
}

/** Edit tool card: line-level diff view. Inside an expanded TurnPanel it
 *  defaults to collapsed (`defaultOpen` false); the user clicks to inspect
 *  the diff. The header stays clickable so an individual edit can still be
 *  folded away. */
function EditToolCard({
  filePath,
  oldString,
  newString,
  status,
  result,
  defaultOpen = false,
  projectPath,
}: {
  filePath: string;
  oldString: string;
  newString: string;
  status: "running" | "done" | "error";
  result?: unknown;
  defaultOpen?: boolean;
  projectPath?: string | null;
}) {
  // Seed the open state from defaultOpen so ToolGroup can force-open all
  // children on group expand. The card's own state still wins after
  // first render (user can collapse an individual card even inside an
  // open group).
  const [open, setOpen] = useState(defaultOpen);
  const diff = useMemo(() => lineDiff(oldString, newString), [oldString, newString]);
  const { adds, dels } = useMemo(() => diffSummary(diff), [diff]);

  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        onClick={(e) => toggleHoldPosition(e, setOpen)}
        className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-surface-muted/50"
      >
        <StatusIcon status={status} />
        <ToolIcon name="Edit" className="text-content-subtle" />
        <span className="font-medium text-content-muted">Edit</span>
        <span className="truncate font-mono text-content-subtle" title={filePath}>
          {filePath}
        </span>
        <span className="ml-auto flex items-center gap-1.5 [font-size:var(--chat-fs-xxs)]">
          {adds > 0 && <span className="text-accent">+{adds}</span>}
          {dels > 0 && <span className="text-danger">−{dels}</span>}
          <Chevron open={open} />
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-l border-edge py-2 pl-2">
          <DiffView diff={diff} />
          {result !== undefined && (
            <div>
              <div className="mb-0.5 uppercase text-content-subtle [font-size:var(--chat-fs-xxs)]">Result</div>
              <pre className="max-h-40 overflow-auto rounded bg-surface-muted/60 p-2 text-content-muted [font-size:var(--chat-fs-xs)]">
                {truncateResult(result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Write tool card: shows the new file content preview. No diff because
 *  Write is a full-file replace. Collapsed by default like the other cards —
 *  the user expands to see the content preview. */
function WriteToolCard({
  filePath,
  content,
  status,
  result,
  defaultOpen = false,
  beforeMap,
  projectPath,
}: {
  filePath: string;
  content: string;
  status: "running" | "done" | "error";
  result?: unknown;
  defaultOpen?: boolean;
  beforeMap?: BeforeContentMap;
  projectPath?: string | null;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const lineCount = content ? content.split("\n").length : 0;

  // Look up the pre-turn content for this file. The turn.files payload
  // carries absolute paths, but the Write tool's file_path may be relative
  // — try an exact match first, then a suffix match (absolute path ending
  // with the given path segments). Undefined → no before available (turn
  // still running, or file is brand-new), and we fall back to a plain
  // new-content preview instead of a diff.
  const before = useMemo(() => {
    if (!beforeMap || beforeMap.size === 0) return undefined;
    if (beforeMap.has(filePath)) return beforeMap.get(filePath);
    for (const [abs, b] of beforeMap) {
      if (abs === filePath || abs.endsWith(filePath)) return b;
    }
    return undefined;
  }, [beforeMap, filePath]);

  // Diff old (pre-turn on-disk) vs new (Write input). Recomputed only when
  // the inputs actually change. When `before` is undefined we render the
  // raw new content preview instead.
  const diff = useMemo(() => (before !== undefined ? lineDiff(before, content) : null), [before, content]);
  const { adds, dels } = useMemo(() => (diff ? diffSummary(diff) : { adds: 0, dels: 0 }), [diff]);

  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        onClick={(e) => toggleHoldPosition(e, setOpen)}
        className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-surface-muted/50"
      >
        <StatusIcon status={status} />
        <ToolIcon name="Write" className="text-content-subtle" />
        <span className="font-medium text-content-muted">Write</span>
        <span className="truncate font-mono text-content-subtle" title={filePath}>
          {filePath}
        </span>
        <span className="ml-auto flex items-center gap-1.5 [font-size:var(--chat-fs-xxs)]">
          {diff && adds > 0 && <span className="text-accent">+{adds}</span>}
          {diff && dels > 0 && <span className="text-danger">−{dels}</span>}
          {!diff && <span className="text-content-subtle">{lineCount} 行</span>}
          <Chevron open={open} />
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-l border-edge py-2 pl-2">
          {diff ? (
            <div>
              <div className="mb-0.5 uppercase text-content-subtle [font-size:var(--chat-fs-xxs)]">
                {before === "" ? "New file" : "Diff vs pre-turn"}
              </div>
              <DiffView diff={diff} />
            </div>
          ) : (
            <div>
              <div className="mb-0.5 uppercase text-content-subtle [font-size:var(--chat-fs-xxs)]">New file content</div>
              <pre className="max-h-80 overflow-auto rounded bg-surface-muted/60 p-2 text-content-muted [font-size:var(--chat-fs-xs)]">
                {content || "(empty)"}
              </pre>
            </div>
          )}
          {result !== undefined && (
            <div>
              <div className="mb-0.5 uppercase text-content-subtle [font-size:var(--chat-fs-xxs)]">Result</div>
              <pre className="max-h-40 overflow-auto rounded bg-surface-muted/60 p-2 text-content-muted [font-size:var(--chat-fs-xs)]">
                {truncateResult(result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Generic tool card for everything not Edit/Write (Bash, Read, Grep…). */
function GenericToolCard({
  block,
  defaultOpen = false,
  projectPath,
}: {
  block: Extract<Block, { kind: "tool_use" }>;
  defaultOpen?: boolean;
  projectPath?: string | null;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // The Read tool (and any file-bearing tool routed here) shows a file_path in
  // its summary line - linkify it. Bash/Grep/Glob summaries are commands or
  // patterns, not paths, so they stay plain text.
  const summaryToolPath = extractToolFilePath(block.toolName, block.input);

  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        onClick={(e) => toggleHoldPosition(e, setOpen)}
        className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-surface-muted/50"
      >
        <StatusIcon status={block.status} />
        <ToolIcon name={block.toolName} className="text-content-subtle" />
        <span className="font-medium text-content-muted">{block.toolName}</span>
        {summaryToolPath ? (
          <span className="truncate font-mono text-content-subtle">
            <FileLink token={summaryToolPath} projectPath={projectPath} />
          </span>
        ) : (
          <span className="truncate text-content-subtle">{toolSummary(block.toolName, block.input)}</span>
        )}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="space-y-2 border-l border-edge py-2 pl-2">
          <div>
            <div className="mb-0.5 uppercase text-content-subtle [font-size:var(--chat-fs-xxs)]">Input</div>
            <pre className="max-h-60 overflow-auto rounded bg-surface-muted/60 p-2 text-content-muted [font-size:var(--chat-fs-xs)]">
              {safeStringify(block.input)}
            </pre>
          </div>
          {block.result !== undefined && (
            <div>
              <div className="mb-0.5 uppercase text-content-subtle [font-size:var(--chat-fs-xxs)]">Result</div>
              <pre className="max-h-60 overflow-auto rounded bg-surface-muted/60 p-2 text-content-muted [font-size:var(--chat-fs-xs)]">
                {resultPreview(block.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A collapsible section (used for thinking blocks). */
function Collapsible({
  label,
  hint,
  defaultOpen = false,
  children,
}: {
  label: string;
  hint: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="[font-size:var(--chat-fs-sm)]">
      <button
        onClick={(e) => toggleHoldPosition(e, setOpen)}
        className="flex w-full items-center gap-2 py-1.5 text-left text-content-muted hover:bg-surface-muted/40"
      >
        <IconBulb size={13} className="shrink-0 text-content-subtle" />
        <span className="font-medium text-content-muted">{label}</span>
        <span className="ml-1 truncate text-content-subtle">{hint}</span>
        <Chevron open={open} className="ml-auto" />
      </button>
      {open && (
        // Cap height so a long thinking block doesn't stretch the stream;
        // it scrolls internally instead. The left border marks this as an
        // expanded body, visually nested under its header.
        <div className="max-h-80 overflow-y-auto border-l border-edge py-2 pl-2 text-content-muted">
          <p className="whitespace-pre-wrap break-words">{children as unknown as string}</p>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────── helpers ──────────────────────────── */

function summarize(text: string): string {
  const t = text.trim();
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}

/** Format a wall-clock ms timestamp as HH:MM:SS (local time). Mirrors the
 *  same-named helper in ChatPane — duplicated here so TurnPanel is
 *  self-contained (ChatPane will stop rendering TurnStatRow above the
 *  panel, so the formatting ownership moves into the panel header). */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format a duration (ms) compactly: <1s → "<1s", <60s → "12.3s",
 *  <60m → "1m 23s", else → "1h 05m". Mirrors ChatPane's helper. */
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

/** Resolve a left-glyph icon for a tool-use block by its name. Unknown names
 *  (incl. MCP `mcp__*` tools) fall back to the generic robot (`IconRobot`).
 *
 *  Mapping rationale:
 *   - Read / Glob   -> file-search (looking up files by path or pattern)
 *   - Write         -> file-plus  (creating / overwriting a file)
 *   - Edit          -> replace    (string-replace edit)
 *   - MultiEdit     -> replace    (batched string-replace edits)
 *   - NotebookEdit  -> notebook   (Jupyter notebook edit)
 *   - Bash / shell  -> terminal   (command shell)
 *   - Grep          -> search     (content search)
 *   - TodoWrite et al -> list-check (task list)
 *   - Task          -> robot      (subagent spawn)
 *   - WebSearch     -> world-search
 *   - WebFetch      -> world      (fetch a URL)
 *   - AskUserQuestion -> help-circle
 *   - Enter/ExitPlanMode -> clipboard (matches the plan card glyph)
 *   - default       -> robot      (generic agent) */
const TOOL_ICON_MAP: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  Read: IconFileSearch,
  Glob: IconFileSearch,
  Write: IconFilePlus,
  Edit: IconReplace,
  MultiEdit: IconReplace,
  NotebookEdit: IconNotebook,
  Bash: IconTerminal,
  PowerShell: IconTerminal,
  Grep: IconSearch,
  TodoWrite: IconListCheck,
  TaskCreate: IconListCheck,
  TaskUpdate: IconListCheck,
  Task: PiRobot,
  WebSearch: IconWorldSearch,
  WebFetch: IconWorldWww,
  AskUserQuestion: IconHelpCircle,
  EnterPlanMode: IconClipboard,
  ExitPlanMode: IconClipboard,
  // Pi (lowercase) aliases — Pi's tool names are lowercase (read/grep/bash/…);
  // map them to the same glyphs as their Claude equivalents so pi tool cards
  // get semantic icons instead of falling back to the generic tools glyph.
  read: IconFileSearch,
  find: IconFileSearch, // Pi's glob equivalent
  ls: IconFileSearch,
  bash: IconTerminal,
  grep: IconSearch,
  edit: IconReplace,
  write: IconFilePlus,
};

/** The left-side glyph of an action card. Sized 13 to sit between the 12px
 *  status icon and the label without dominating the row. Exported so the
 *  current-operation ticker (CurrentOpTicker) can reuse the same
 *  icon mapping instead of duplicating it. */
export function ToolIcon({ name, className }: { name: string; className?: string }) {
  const Icon = TOOL_ICON_MAP[name] ?? IconRobot;
  return <Icon size={13} className={cn("shrink-0", className)} />;
}

/** A one-line hint for common tools (Read/Edit/Bash etc.) shown on the card header.
 *  Exported for reuse by the floating "current operation" card. */
export function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return String(obj.file_path ?? "");
    case "Bash":
    case "PowerShell":
      return String(obj.command ?? obj.description ?? "");
    case "Glob":
      return String(obj.pattern ?? "");
    case "Grep":
      return String(obj.pattern ?? "");
    case "TodoWrite":
      return "todos";
    case "AskUserQuestion": {
      // input is { questions: [{ header, question, multiSelect, options }] }
      // (or a { item: [...] } wrapper). Show the first question's text so the
      // collapsed card reads as an actual question, not "[object Object]".
      const raw = (obj.questions ?? obj.item) as unknown;
      const first = Array.isArray(raw) ? raw[0] : null;
      if (first && typeof first === "object") {
        const q = (first as Record<string, unknown>).question;
        if (typeof q === "string") return q;
      }
      return "";
    }
    // Pi (lowercase) tool names. Pi's read/write/edit take a `path` field
    // (not Claude's `file_path`); accept either so summaries survive if a
    // future pi version renames the field. find = Pi's glob, ls = Pi-only.
    case "read":
    case "write":
    case "edit":
      return String(obj.file_path ?? obj.path ?? "");
    case "bash":
      return String(obj.command ?? obj.description ?? "");
    case "find":
      return String(obj.pattern ?? "");
    case "grep":
      return String(obj.pattern ?? "");
    case "ls":
      return String(obj.path ?? "");
    default:
      return Object.values(obj).slice(0, 1).map(String).join("").slice(0, 60);
  }
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function truncateResult(v: unknown): string {
  const s = safeStringify(v);
  return s.length > 2000 ? s.slice(0, 2000) + "\n…(truncated)" : s;
}

/**
 * Like truncateResult, but strips image content blocks (which carry raw base64
 * that would flood the card as thousands of chars of JSON). When a screenshot
 * was captured, the image itself renders as an inline `kind:"image"` block next
 * to the card; here we only need a short textual stand-in so the Result panel
 * stays readable. Handles both MCP (`{type:"image",data,mimeType}`) and
 * Anthropic (`{type:"image",source:{...}}`) image shapes.
 */
function isImageBlock(b: unknown): boolean {
  return !!b && typeof b === "object" && (b as { type?: string }).type === "image";
}
function resultPreview(v: unknown): string {
  // Normalize: Pi forwards the AgentToolResult wrapper { content: [...], details }
  // as the tool result; unwrap to the content array so the image-stripping below
  // works uniformly for both Pi and Claude.
  const blocks = Array.isArray(v)
    ? v
    : v && typeof v === "object" && Array.isArray((v as { content?: unknown }).content)
      ? (v as { content: unknown[] }).content
      : null;
  if (blocks) {
    const filtered = blocks.filter((b) => !isImageBlock(b));
    if (filtered.length !== blocks.length) {
      // Had at least one image — render the remaining text blocks, plus a
      // marker so the user knows a screenshot was elided (rendered above).
      const texts = filtered
        .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
        .map((b) => (b as { text?: string }).text ?? "");
      return texts.length > 0 ? truncateResult(texts.join("\n")) + "\n[image rendered above]" : "[image rendered above]";
    }
    // No image: stringify the (possibly unwrapped) content array for display.
    return truncateResult(blocks);
  }
  return truncateResult(v);
}

/* ─── type guards ───
 * Edit and Write have well-known input shapes from the Claude Agent SDK
 * (verified against docs/claude-stream-json.md). We narrow the generic
 * `unknown` Block input here so EditToolCard/WriteToolCard can render
 * structured content instead of falling back to the JSON dump. */

/** Edit tool input: { file_path, old_string, new_string }. */
function isEditInput(
  i: unknown,
): i is { file_path: string; old_string: string; new_string: string } {
  if (!i || typeof i !== "object") return false;
  const o = i as Record<string, unknown>;
  return (
    typeof o.file_path === "string" &&
    typeof o.old_string === "string" &&
    typeof o.new_string === "string"
  );
}

/** Write tool input: { file_path, content }. */
function isWriteInput(i: unknown): i is { file_path: string; content: string } {
  if (!i || typeof i !== "object") return false;
  const o = i as Record<string, unknown>;
  return typeof o.file_path === "string" && typeof o.content === "string";
}

/** Pull a single-file path out of a tool input, accepting either Claude's
 *  `file_path` or Pi's `path` field (Pi's read/write/edit use `path`). Used by
 *  extractToolFilePath to decide whether the card's summary line should
 *  render as a clickable file link. */
function pathField(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.file_path === "string") return o.file_path;
  if (typeof o.path === "string") return o.path;
  return null;
}

/** Extract a `file_path` from a tool's input when the tool is one that
 *  operates on a single file (Read / Write / Edit). Returns null for tools
 *  whose summary is not a path (Bash, Grep, Glob, etc.) so GenericToolCard
 *  renders their plain-text summary instead of a link. Reuses the Edit/Write
 *  type guards and adds a plain Read fallback. Accepts both Claude
 *  (capitalized) and Pi (lowercase) tool names. */
function extractToolFilePath(toolName: string, input: unknown): string | null {
  // Claude (Edit/Write are narrowed first so the structured cards get the
  // exact field; Read falls through to the lenient pathField).
  if (toolName === "Edit" && isEditInput(input)) return input.file_path;
  if (toolName === "Write" && isWriteInput(input)) return input.file_path;
  if (toolName === "Read") return pathField(input);
  // Pi (lowercase). Pi's edit input is { path, edits:[…] } and write is
  // { path, content } — both carry `path`, so the lenient pathField covers
  // them without needing pi-specific type guards.
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    return pathField(input);
  }
  return null;
}
