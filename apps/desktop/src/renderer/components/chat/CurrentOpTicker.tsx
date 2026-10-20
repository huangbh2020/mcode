import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { toolDisplayName } from "@renderer/lib/toolNames.js";
import {
  IconCheck,
  IconX,
} from "@renderer/lib/icons.js";
import {
  ToolIcon,
  toolSummary,
  type ToolUseBlock,
} from "./MessageBlocks.js";

/**
 * Compact "current operation" ticker for the collapsed procedural card.
 *
 * The collapsed card header only shows an aggregate ("2 个操作 · Bash ×2") —
 * it hides which tool is executing right now. This ticker renders on the
 * right side of that header row and shows the operation the assistant is
 * currently running (Bash / Read / Edit / …). When the agent moves on to the
 * next command, the ticker ROWS UP like a slot machine: the old row slides
 * out the top and the new one rolls in from below.
 *
 * Row-flip implementation (same two-face pattern as the turn-flip elsewhere):
 *  - an overflow-hidden window of exactly one row height holds a stack of two
 *    rows; the wrapper translateY moves 0 → -ROW_HEIGHT (with a CSS
 *    transition) so the second row slides into view;
 *  - on transition end the incoming row is promoted to the front and the
 *    offset resets INSTANTLY (transition disabled for one frame) so the next
 *    roll starts clean. If a new tool arrives mid-roll, the incoming row is
 *    swapped to the newest so the roll lands on whatever is latest.
 *
 * Only the operation *currently being executed* is relevant, so:
 *  - `op` is the newest RUNNING tool block in the card (or null);
 *  - while the turn is still active but nothing runs (brief gap between two
 *    commands), the last executed operation stays visible, dimmed;
 *  - when the turn is no longer streaming the ticker clears entirely —
 *    completed cards in history never show a stale operation.
 */

/** Height of one ticker row in px — the window is exactly this tall and the
 *  roll moves by exactly this amount. */
const ROW_HEIGHT = 20;
const ROLL_MS = 240;
const ROLL_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

/** One ticker row: status glyph + tool icon + name + one-line summary.
 *  Rendered as spans because the ticker lives inside a <button> header row
 *  (phrasing content only). The running state carries no spinner — the
 *  stream's single loading indicator lives at the bottom (isStreamingTail),
 *  so the ticker only marks errors (✗) and completions (✓) per row. */
function TickerRow({ op, running }: { op: ToolUseBlock; running: boolean }) {
  const { t } = useI18n();
  const status = running ? "running" : op.status;
  return (
    <span
      className="flex h-5 items-center gap-1.5 whitespace-nowrap"
      title={typeof op.input === "object" ? JSON.stringify(op.input) : String(op.input)}
    >
      {status === "error" && <IconX size={12} className="shrink-0 text-danger" />}
      {status === "done" && <IconCheck size={12} className="shrink-0 text-content-subtle" />}
      <ToolIcon name={op.toolName} className="shrink-0 text-content-muted" />
      <span className={cn("font-medium", running ? "text-content" : "text-content-muted")}>
        {toolDisplayName(t, op.toolName)}
      </span>
      <span className="truncate font-mono text-content-subtle">{toolSummary(op.toolName, op.input)}</span>
    </span>
  );
}

export function CurrentOpTicker({
  op,
  turnActive,
}: {
  /** Newest RUNNING tool block in the card, or null when nothing is running. */
  op: ToolUseBlock | null;
  /** Whether the card's turn is still streaming. Clears the ticker when the
   *  turn ends so completed cards don't keep a stale operation. */
  turnActive: boolean;
}) {
  // toolCallId currently shown in the window.
  const [frontId, setFrontId] = useState<string | null>(null);
  // The row that will roll in (kept as a full block because `op` may have
  // moved on by the time the transition finishes).
  const [nextOp, setNextOp] = useState<ToolUseBlock | null>(null);
  // Wrapper offset: false = 0 (front row), true = -ROW_HEIGHT (next row).
  const [rolled, setRolled] = useState(false);
  // Toggled off for exactly one frame after a roll so promoting next→front and
  // resetting the offset doesn't animate backwards.
  const [transitionEnabled, setTransitionEnabled] = useState(true);
  // Snapshot of the front row's block; kept live while `op` refers to the same
  // tool (its status may flip running→done under us).
  const frontOpRef = useRef<ToolUseBlock | null>(null);

  const reducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // Keep the front row's snapshot live while the parent's `op` still refers to
  // the same tool.
  useEffect(() => {
    if (op && frontId && op.toolCallId === frontId) {
      frontOpRef.current = op;
    }
  }, [op, frontId]);

  // Turn ended → clear the ticker entirely.
  useEffect(() => {
    if (!turnActive) {
      frontOpRef.current = null;
      setFrontId(null);
      setNextOp(null);
      setRolled(false);
      setTransitionEnabled(true);
    }
  }, [turnActive]);

  // New operation arrived → show it, rolling if the content actually changed.
  useEffect(() => {
    if (!turnActive || !op) return;

    if (!frontId) {
      // First operation of the card: appear in place (no roll needed yet).
      frontOpRef.current = op;
      setFrontId(op.toolCallId);
      return;
    }
    if (op.toolCallId === frontId) return; // same tool, status update only

    if (reducedMotion) {
      // No transition → no transitionend event to promote the next row with.
      frontOpRef.current = op;
      setFrontId(op.toolCallId);
      setNextOp(null);
      setRolled(false);
      return;
    }

    if (rolled) {
      // Already mid-roll: point the incoming row at the newest operation.
      setNextOp(op);
      return;
    }
    // Start rolling to the next command.
    setNextOp(op);
    setTransitionEnabled(true);
    setRolled(true);
  }, [op, frontId, rolled, turnActive, reducedMotion]);

  if (!frontId && !nextOp) return null;

  const frontOp = op && frontId && op.toolCallId === frontId ? op : frontOpRef.current;
  const frontRunning = !!op && !!frontId && op.toolCallId === frontId;

  return (
    <span className="flex min-w-0 items-center border-l border-edge pl-2">
      <span className="block min-w-0 max-w-60" style={{ height: ROW_HEIGHT, overflow: "hidden" }}>
        <span
          className="block"
          onTransitionEnd={(e) => {
            if (e.propertyName !== "transform") return;
            if (!rolled || !nextOp) return;
            // Promote the incoming row and reset the offset instantly.
            setTransitionEnabled(false);
            frontOpRef.current = nextOp;
            setFrontId(nextOp.toolCallId);
            setRolled(false);
            setNextOp(null);
            requestAnimationFrame(() =>
              requestAnimationFrame(() => setTransitionEnabled(true)),
            );
          }}
          style={{
            transform: rolled ? `translateY(-${ROW_HEIGHT}px)` : "translateY(0px)",
            transition:
              transitionEnabled && !reducedMotion
                ? `transform ${ROLL_MS}ms ${ROLL_EASING}`
                : "none",
          }}
        >
          <span className="block" style={{ height: ROW_HEIGHT }}>
            {frontOp && <TickerRow op={frontOp} running={frontRunning} />}
          </span>
          {nextOp && (
            <span className="block" style={{ height: ROW_HEIGHT }}>
              <TickerRow op={nextOp} running />
            </span>
          )}
        </span>
      </span>
    </span>
  );
}
