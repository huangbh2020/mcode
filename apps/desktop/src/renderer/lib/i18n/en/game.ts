/** English mirror of `zh/game.ts`. */
export const en = {
  /* ── title / header ── */
  "game.title": "Liar's Dice",
  "game.subtitle": "You vs Model",
  "game.close": "Close",
  "game.dragHint": "Drag to move",

  /* ── players ── */
  "game.you": "You",
  "game.model": "Model",
  "game.yourDice": "Your dice",
  "game.modelDice": "Model's dice",
  "game.diceCount": "{n} dice",

  /* ── turn / phase ── */
  "game.yourTurn": "Your turn",
  "game.modelThinking": "Model is thinking…",
  "game.roundOver": "Round over",
  "game.gameOver": "Game over",

  /* ── bidding ── */
  "game.bid": "Bid",
  "game.challenge": "Challenge",
  "game.count": "Count",
  "game.face": "Face",
  "game.currentBid": "Current bid",
  "game.noBidYet": "No bid yet this round",
  "game.bidHistory": "Bid history",
  "game.confirmBid": "Confirm bid",
  "game.invalidBid": "Illegal bid: must be higher than the last (more dice, or same count with a higher face)",
  "game.wildRule": "1 is wild - counts as any face at settlement, but cannot be bid directly",

  /* ── round result ── */
  "game.roundResultWin": "Challenge successful! The opponent bluffed and loses a die.",
  "game.roundResultLose": "Challenge failed! The opponent didn't bluff - you lose a die.",
  "game.roundResultModelWin": "The model challenged successfully! You bluffed and lose a die.",
  "game.roundResultModelLose": "The model's challenge failed! It bluffed and loses a die.",
  "game.actualCount": "Actual count: {actual}/{bid}",
  "game.continue": "Continue to next round",

  /* ── game over ── */
  "game.gameOverWin": "🎉 You win! The model has no dice left.",
  "game.gameOverLose": "😔 You lose. You have no dice left.",
  "game.newGame": "New game",
  "game.resign": "Resign",

  /* ── empty state ── */
  "game.emptyTitle": "No game in progress",
  "game.emptyHint": "Click \"New game\" to start a round of Liar's Dice.",
  "game.startGame": "Start game",

  /* ── settings ── */
  "game.taunt": "Taunt",
  "game.tauntOn": "On",
  "game.tauntOff": "Off",

  /* ── waiting hint ── */
  "game.waitingHint": "Waiting for agent output? Sneak in a move.",

  /* ── errors ── */
  "game.errorGeneric": "Action failed, please retry.",
  "game.busy": "The model is thinking, please wait…",
} as const;
