/**
 * Mini-game domain types - provider-neutral, shared across the IPC boundary.
 *
 * The first (and currently only) game is Liars Dice (大话骰 / 吹牛骰). The
 * `gameId` discriminant leaves room for additional games to slot into the same
 * overlay + persistence plumbing without altering the contract surface.
 */

/** A single die face: 1 (wild) through 6. */
export type Face = 1 | 2 | 3 | 4 | 5 | 6;

/** Which player an action belongs to. */
export type PlayerId = "user" | "model";

/** Life-cycle phases of a single game. */
export type GamePhase =
  | "bidding" // an active round - currentTurn says whose move
  | "roundOver" // a challenge was resolved; dice revealed; awaiting "continue"
  | "gameOver"; // someone reached 0 dice

/**
 * A bid asserts "there are at least `count` dice showing `face` across ALL
 * dice on the table (both players)". In v1 the callable faces are 2-6 only;
 * 1 is wild (counts as any face during settlement) but cannot be bid directly,
 * which removes the "opening with 1" edge case and keeps the model stable.
 */
export interface Bid {
  count: number;
  face: Exclude<Face, 1>;
}

/** A single entry in the bid history of the current round. */
export interface BidEntry {
  by: PlayerId;
  bid: Bid;
}

/** Result of resolving a challenge - persisted so the renderer can render the
 *  reveal even after a rehydrate. */
export interface RoundResult {
  /** Who called the challenge. */
  challenger: PlayerId;
  /** The bid being challenged. */
  finalBid: Bid;
  /** All dice on the table at settlement time (user's then model's), revealed. */
  allDice: Face[];
  /** How many dice actually matched `finalBid.face` (wild 1s included). */
  actualCount: number;
  /** Whether the bid was met (actualCount >= finalBid.count). */
  met: boolean;
  /** Who lost a die this round. */
  loser: PlayerId;
}

/** Authoritative game state. Main process is the single source of truth; the
 *  renderer mirrors this via the `game.*` RPCs. Persisted as JSON under the
 *  `ui.game.state` settings key so a game survives overlay close / app restart.
 *
 *  Note: `modelDice` is persisted in full (including face values) to support
 *  rehydrate-and-continue. Anti-cheating is NOT a goal for this casual overlay;
 *  fairness is enforced at the prompt level (the model never sees the user's
 *  dice) and the UI hides the model's dice except during `roundOver` reveal. */
export interface GameState {
  gameId: "liars-dice";
  phase: GamePhase;
  /** User's dice (1-5 entries). Faces are visible to the user. */
  userDice: Face[];
  /** Model's dice (1-5 entries). Faces are hidden in the UI except during
   *  `roundOver`. Persisted so rehydration works. */
  modelDice: Face[];
  /** Bids made in the current round, oldest first. Cleared at each new round. */
  bidHistory: BidEntry[];
  /** Whose turn it is to bid/challenge. Always "user" in a returned state
   *  (advance() runs the model to completion before returning), except in
   *  `roundOver` / `gameOver` where it carries no meaning. */
  currentTurn: PlayerId;
  /** Set when phase is "roundOver" - the reveal details. */
  lastResult?: RoundResult;
  /** Set when phase is "gameOver". */
  winner?: PlayerId;
  /** Total completed rounds across the game. */
  roundsPlayed: number;
  /** Free-text trash-talk from the model's last action (not i18n'd - dynamic
   *  model-generated content, like a chat message). Cleared each round. */
  lastTaunt?: string;
}
