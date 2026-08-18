/**
 * Liars Dice (大话骰 / 吹牛骰) rules engine - pure functions, no side effects.
 *
 * v1 simplification: the callable faces are 2-6 only. The 1 face is *wild* -
 * it counts as any face during settlement - but cannot be bid directly. This
 * removes the "opening with 1" edge case and keeps the model's output stable.
 *
 * Settlement rule: a bid "count × face" is MET when, across ALL dice on the
 * table, the number of dice showing `face` plus the number showing 1 (wild)
 * is >= `count`. If met, the challenger loses a die; otherwise the bidder
 * loses a die. Lose all dice => game over.
 */
import type { Bid, Face, GameState, PlayerId, RoundResult } from "@contracts/game.js";

/** Dice per player at the start of a game. */
export const STARTING_DICE = 5;

/** The minimum legal opening bid: one die showing 2. (1 is not callable.) */
export const MIN_FACE = 2;
export const MAX_FACE = 6;

/** Roll `n` dice, returning faces in 1-6. Uses Math.random - this is a casual
 *  game, no cryptographic fairness requirement. */
export function rollDice(n: number): Face[] {
  const out: Face[] = [];
  for (let i = 0; i < n; i++) {
    out.push((1 + Math.floor(Math.random() * 6)) as Face);
  }
  return out;
}

/** Is `b` a structurally valid bid (count >= 1, face in 2-6)? */
export function isValidBidShape(b: Bid): boolean {
  return b.count >= 1 && b.face >= MIN_FACE && b.face <= MAX_FACE;
}

/**
 * Is `b` a legal bid given the `lastBid` on the table? A legal bid must either
 * raise the count, or keep the count and raise the face. The opening bid (no
 * lastBid) is legal as long as its shape is valid.
 */
export function isLegalBid(b: Bid, lastBid: Bid | undefined): boolean {
  if (!isValidBidShape(b)) return false;
  if (!lastBid) return true;
  if (b.count > lastBid.count) return true;
  if (b.count === lastBid.count && b.face > lastBid.face) return true;
  return false;
}

/** The smallest legal bid given `lastBid` (used as a fallback when the model
 *  emits an illegal move). With no lastBid it's {1, 2}; otherwise raise the
 *  face if possible, else bump count to lastBid.count+1 at face 2. */
export function minLegalBid(lastBid: Bid | undefined): Bid {
  if (!lastBid) return { count: 1, face: MIN_FACE };
  if (lastBid.face < MAX_FACE) return { count: lastBid.count, face: (lastBid.face + 1) as Bid["face"] };
  return { count: lastBid.count + 1, face: MIN_FACE };
}

/**
 * Count how many dice across `allDice` satisfy a bid on `face`: dice showing
 * `face` plus dice showing 1 (wild). This is the settlement count.
 */
export function countFace(allDice: Face[], face: Bid["face"]): number {
  let n = 0;
  for (const d of allDice) {
    if (d === face || d === 1) n++;
  }
  return n;
}

/**
 * Resolve a challenge: compare the final bid against the actual dice.
 * Returns the RoundResult (who lost a die, whether the bid was met).
 */
export function resolveChallenge(
  finalBid: Bid,
  challenger: PlayerId,
  allDice: Face[],
): RoundResult {
  const actualCount = countFace(allDice, finalBid.face);
  const met = actualCount >= finalBid.count;
  // If met, the challenger was wrong -> challenger loses a die.
  // If not met, the bidder was bluffing -> bidder loses a die.
  const bidder: PlayerId = challenger === "user" ? "model" : "user";
  const loser = met ? challenger : bidder;
  return { challenger, finalBid, allDice, actualCount, met, loser };
}

/** Who leads the next round after `loser` lost a die? The loser leads (classic
 *  disadvantage rule). If the loser is out of dice, the other player leads. */
export function nextLeader(loser: PlayerId): PlayerId {
  return loser;
}

/** Create a fresh game state: both players roll their starting dice, user
 *  leads the first round. */
export function createNewGame(): GameState {
  return {
    gameId: "liars-dice",
    phase: "bidding",
    userDice: rollDice(STARTING_DICE),
    modelDice: rollDice(STARTING_DICE),
    bidHistory: [],
    currentTurn: "user",
    roundsPlayed: 0,
  };
}

/** Start a new round: re-roll surviving dice for both players, clear history,
 *  set the leader. Returns a new state (does not mutate). */
export function startNewRound(state: GameState, leader: PlayerId): GameState {
  return {
    ...state,
    phase: "bidding",
    userDice: rollDice(state.userDice.length),
    modelDice: rollDice(state.modelDice.length),
    bidHistory: [],
    currentTurn: leader,
    lastResult: undefined,
    lastTaunt: undefined,
  };
}

/** Remove one die from `player`'s hand. Returns the new dice array. */
export function loseDie(state: GameState, player: PlayerId): Face[] {
  const dice = player === "user" ? state.userDice : state.modelDice;
  return dice.slice(0, Math.max(0, dice.length - 1));
}

/** Has `player` run out of dice (game over condition)? */
export function isOutOfDice(state: GameState, player: PlayerId): boolean {
  const dice = player === "user" ? state.userDice : state.modelDice;
  return dice.length === 0;
}

/** The last bid in the current round, or undefined if no bids yet. */
export function lastBid(state: GameState): Bid | undefined {
  const h = state.bidHistory;
  return h.length > 0 ? h[h.length - 1].bid : undefined;
}
