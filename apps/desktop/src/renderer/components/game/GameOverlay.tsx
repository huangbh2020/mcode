/**
 * GameOverlay - a floating, draggable mini-game card (liars dice).
 *
 * Mounted at the App root (like CommandPalette / BrowserPanel), gated by
 * `gameOverlayOpen`. The card is freely positioned via mouse-drag on its
 * header (adapted from Divider.tsx's handleMouseDown pattern). Position is
 * in-memory only (resets on app restart) - the game *state* is what persists.
 *
 * The overlay mirrors `gameState` from the store, which is itself a mirror of
 * the main-process GameService (the authoritative owner). User actions call
 * store actions that fire `game.*` RPCs; main runs the model opponent to
 * completion before returning the updated state.
 *
 * z-[45]: above the browser overlay (z-40) and settings (z-30), below the
 * dialogs / command palette (z-50) so a ConfirmDialog still sits on top.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  IconX,
  IconDeviceGamepad2,
  IconTrophy,
  IconDice,
} from "@renderer/lib/icons.js";
import { DiceView } from "./DiceView.js";
import type { GameState, Bid } from "@contracts/ipc";

/** Default position: right side of the workspace, below the titlebar. */
const DEFAULT_POS = { left: 720, top: 80 };
const CARD_WIDTH = 360;

export function GameOverlay() {
  const { t } = useI18n();
  const open = useSessionStore((s) => s.gameOverlayOpen);
  const setOpen = useSessionStore((s) => s.setGameOverlayOpen);
  const gameState = useSessionStore((s) => s.gameState);
  const gameTaunt = useSessionStore((s) => s.gameTaunt);
  const setGameTaunt = useSessionStore((s) => s.setGameTaunt);
  const hydrateGameState = useSessionStore((s) => s.hydrateGameState);
  const gameNewGame = useSessionStore((s) => s.gameNewGame);
  const gameUserBid = useSessionStore((s) => s.gameUserBid);
  const gameUserChallenge = useSessionStore((s) => s.gameUserChallenge);
  const gameContinue = useSessionStore((s) => s.gameContinue);
  const gameResign = useSessionStore((s) => s.gameResign);

  const [pos, setPos] = useState(DEFAULT_POS);
  const [busy, setBusy] = useState(false);
  const [bidCount, setBidCount] = useState(1);
  const [bidFace, setBidFace] = useState(2);
  const [bidError, setBidError] = useState<string | null>(null);

  // Hydrate the game state when the overlay opens (so a re-open shows the
  // latest state even if main updated it while the overlay was closed).
  useEffect(() => {
    if (open) void hydrateGameState();
  }, [open, hydrateGameState]);

  // ── Drag logic (adapted from Divider.tsx handleMouseDown) ──
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, left: 0, top: 0 });

  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, left: pos.left, top: pos.top };

    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const dx = ev.clientX - dragStart.current.x;
      const dy = ev.clientY - dragStart.current.y;
      // Clamp so the card stays within the viewport (titlebar is 40px at top).
      const maxLeft = window.innerWidth - 120;
      const maxTop = window.innerHeight - 80;
      setPos({
        left: Math.max(-CARD_WIDTH + 120, Math.min(maxLeft, dragStart.current.left + dx)),
        top: Math.max(40, Math.min(maxTop, dragStart.current.top + dy)),
      });
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [pos.left, pos.top]);

  if (!open) return null;

  const s = gameState;
  const phase = s?.phase ?? "idle";
  const isModelTurn = s?.currentTurn === "model" && s?.phase === "bidding";
  const canAct = s?.phase === "bidding" && s?.currentTurn === "user" && !busy;

  const lastBidEntry = s?.bidHistory?.[s.bidHistory.length - 1];
  const lastBid: Bid | undefined = lastBidEntry?.bid;

  const handleStartGame = async () => {
    setBusy(true);
    setBidError(null);
    await gameNewGame();
    setBusy(false);
  };

  const handleBid = async () => {
    if (!canAct) return;
    // Validate locally first for instant feedback.
    if (lastBid) {
      const higher =
        bidCount > lastBid.count ||
        (bidCount === lastBid.count && bidFace > lastBid.face);
      if (!higher) {
        setBidError(t("game.invalidBid"));
        return;
      }
    }
    setBidError(null);
    setBusy(true);
    const ok = await gameUserBid(bidCount, bidFace);
    setBusy(false);
    if (!ok) setBidError(t("game.errorGeneric"));
  };

  const handleChallenge = async () => {
    if (!canAct || !lastBid) return;
    setBidError(null);
    setBusy(true);
    const ok = await gameUserChallenge();
    setBusy(false);
    if (!ok) setBidError(t("game.errorGeneric"));
  };

  const handleContinue = async () => {
    if (s?.phase !== "roundOver") return;
    setBusy(true);
    await gameContinue();
    setBusy(false);
  };

  const handleResign = async () => {
    setBusy(true);
    await gameResign();
    setBusy(false);
  };

  return (
    <div
      className={cn(
        "fixed z-[45] flex flex-col overflow-hidden rounded-xl border border-edge bg-surface shadow-2xl",
        "data-[starting-style]:opacity-0 transition-opacity duration-150",
      )}
      style={{ left: pos.left, top: pos.top, width: CARD_WIDTH }}
    >
      {/* Header - drag handle */}
      <div
        onMouseDown={handleHeaderMouseDown}
        className={cn(
          "flex items-center gap-2 border-b border-edge bg-surface-hover px-3 py-2",
          "cursor-grab active:cursor-grabbing select-none",
        )}
      >
        <IconDeviceGamepad2 size={16} className="shrink-0 text-accent" />
        <span className="text-sm font-medium text-content">{t("game.title")}</span>
        <span className="text-xs text-content-muted">{t("game.subtitle")}</span>
        <div className="flex-1" />
        {/* Taunt toggle */}
        <button
          onClick={() => setGameTaunt(!gameTaunt)}
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] transition-colors",
            gameTaunt
              ? "bg-accent/15 text-accent"
              : "text-content-muted hover:bg-surface-hover",
          )}
          title={t("game.taunt")}
        >
          {t("game.taunt")}: {gameTaunt ? t("game.tauntOn") : t("game.tauntOff")}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded p-1 text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          title={t("game.close")}
        >
          <IconX size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-3 p-3">
        {/* Empty state - no game in progress */}
        {!s && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <IconDice size={32} className="text-content-muted" />
            <div>
              <div className="text-sm font-medium text-content">{t("game.emptyTitle")}</div>
              <div className="mt-1 text-xs text-content-muted">{t("game.emptyHint")}</div>
            </div>
            <button
              onClick={handleStartGame}
              disabled={busy}
              className={cn(
                "rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white transition-colors",
                "hover:bg-accent/90 disabled:opacity-50",
              )}
            >
              {t("game.startGame")}
            </button>
          </div>
        )}

        {/* Game in progress */}
        {s && (
          <>
            {/* Dice area */}
            <div className="flex flex-col gap-2">
              {/* Model's dice (hidden unless roundOver) */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-content-muted">{t("game.modelDice")}</span>
                <span className="text-xs text-content-subtle">
                  {t("game.diceCount", { n: s.modelDice.length })}
                </span>
              </div>
              <div className="flex items-center justify-center rounded-lg border border-edge bg-surface-muted py-2">
                <DiceView
                  dice={s.modelDice}
                  revealed={s.phase === "roundOver" || s.phase === "gameOver"}
                  size={26}
                />
              </div>

              {/* User's dice (always visible) */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-content-muted">{t("game.yourDice")}</span>
                <span className="text-xs text-content-subtle">
                  {t("game.diceCount", { n: s.userDice.length })}
                </span>
              </div>
              <div className="flex items-center justify-center rounded-lg border border-edge bg-surface-muted py-2">
                <DiceView dice={s.userDice} revealed size={26} />
              </div>
            </div>

            {/* Taunt bubble (model's trash-talk) */}
            {gameTaunt && s.lastTaunt && (
              <div className="rounded-md bg-accent/10 px-2.5 py-1.5 text-xs italic text-content-muted">
                💬 {s.lastTaunt}
              </div>
            )}

            {/* Current bid / status */}
            <div className="rounded-md border border-edge bg-surface-muted px-2.5 py-1.5">
              {s.phase === "bidding" && (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-content-muted">{t("game.currentBid")}</span>
                    {isModelTurn ? (
                      <span className="text-xs text-accent">{t("game.modelThinking")}</span>
                    ) : s.currentTurn === "user" ? (
                      <span className="text-xs text-accent">{t("game.yourTurn")}</span>
                    ) : null}
                  </div>
                  {lastBid ? (
                    <div className="mt-0.5 text-sm font-medium text-content">
                      {lastBid.count} × {lastBid.face}
                    </div>
                  ) : (
                    <div className="mt-0.5 text-sm text-content-subtle">{t("game.noBidYet")}</div>
                  )}
                </>
              )}

              {s.phase === "roundOver" && s.lastResult && (
                <RoundResultView state={s} />
              )}

              {s.phase === "gameOver" && (
                <div className="flex items-center gap-2">
                  <IconTrophy size={16} className={s.winner === "user" ? "text-accent" : "text-content-muted"} />
                  <span className="text-sm font-medium text-content">
                    {s.winner === "user" ? t("game.gameOverWin") : t("game.gameOverLose")}
                  </span>
                </div>
              )}
            </div>

            {/* Bid history (compact) */}
            {s.bidHistory.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-content-muted hover:text-content">
                  {t("game.bidHistory")} ({s.bidHistory.length})
                </summary>
                <div className="mt-1 flex flex-col gap-0.5 pl-2">
                  {s.bidHistory.map((e, i) => (
                    <div key={i} className="text-content-subtle">
                      <span className={e.by === "user" ? "text-accent" : "text-content-muted"}>
                        {e.by === "user" ? t("game.you") : t("game.model")}
                      </span>
                      : {e.bid.count} × {e.bid.face}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* Wild rule hint */}
            <div className="text-[10px] text-content-subtle">{t("game.wildRule")}</div>

            {/* Action area */}
            {s.phase === "bidding" && (
              <div className="flex flex-col gap-2">
                {/* Bid inputs */}
                <div className="flex items-center gap-2">
                  <label className="text-xs text-content-muted">{t("game.count")}</label>
                  <BidNumberInput
                    value={bidCount}
                    min={1}
                    max={s.userDice.length + s.modelDice.length}
                    onChange={setBidCount}
                  />
                  <label className="text-xs text-content-muted">{t("game.face")}</label>
                  <BidFaceInput value={bidFace} onChange={setBidFace} />
                </div>

                {bidError && (
                  <div className="text-xs text-red-500">{bidError}</div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={handleBid}
                    disabled={!canAct}
                    className={cn(
                      "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      "bg-accent text-white hover:bg-accent/90 disabled:opacity-50",
                    )}
                  >
                    {t("game.bid")}
                  </button>
                  <button
                    onClick={handleChallenge}
                    disabled={!canAct || !lastBid}
                    className={cn(
                      "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      "border border-edge bg-surface text-content hover:bg-surface-hover",
                      "disabled:opacity-50",
                    )}
                  >
                    {t("game.challenge")}
                  </button>
                </div>
                {busy && <div className="text-xs text-content-muted">{t("game.busy")}</div>}
              </div>
            )}

            {/* Round over - continue button */}
            {s.phase === "roundOver" && (
              <button
                onClick={handleContinue}
                disabled={busy}
                className={cn(
                  "rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors",
                  "hover:bg-accent/90 disabled:opacity-50",
                )}
              >
                {t("game.continue")}
              </button>
            )}

            {/* Game over - new game / resign */}
            {s.phase === "gameOver" && (
              <button
                onClick={handleStartGame}
                disabled={busy}
                className={cn(
                  "rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors",
                  "hover:bg-accent/90 disabled:opacity-50",
                )}
              >
                {t("game.newGame")}
              </button>
            )}

            {/* Resign (always available when a game is in progress) */}
            {s.phase !== "gameOver" && (
              <button
                onClick={handleResign}
                disabled={busy}
                className={cn(
                  "self-start text-xs text-content-muted transition-colors hover:text-red-500",
                  "disabled:opacity-50",
                )}
              >
                {t("game.resign")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Round-result message based on who challenged and who lost. */
function RoundResultView({ state }: { state: GameState }) {
  const { t } = useI18n();
  const r = state.lastResult!;
  const userChallenged = r.challenger === "user";
  const userWon = r.loser === "model";

  let msg: string;
  if (userChallenged) {
    msg = userWon ? t("game.roundResultWin") : t("game.roundResultLose");
  } else {
    msg = userWon ? t("game.roundResultModelLose") : t("game.roundResultModelWin");
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="text-sm text-content">{msg}</div>
      <div className="text-xs text-content-muted">
        {t("game.actualCount", { actual: r.actualCount, bid: r.finalBid.count })}
        {" · "}
        {r.finalBid.face} ({r.met ? "✓" : "✗"})
      </div>
    </div>
  );
}

/** Compact number input for bid count (with +/- buttons). */
function BidNumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        className="rounded border border-edge px-1.5 text-sm text-content-muted hover:bg-surface-hover"
      >
        −
      </button>
      <span className="w-8 text-center text-sm font-medium text-content">{value}</span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        className="rounded border border-edge px-1.5 text-sm text-content-muted hover:bg-surface-hover"
      >
        +
      </button>
    </div>
  );
}

/** Face selector (2-6, since 1 is wild and not callable). */
function BidFaceInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      {[2, 3, 4, 5, 6].map((f) => (
        <button
          key={f}
          onClick={() => onChange(f)}
          className={cn(
            "h-6 w-6 rounded text-xs font-medium transition-colors",
            value === f
              ? "bg-accent text-white"
              : "border border-edge text-content-muted hover:bg-surface-hover",
          )}
        >
          {f}
        </button>
      ))}
    </div>
  );
}
