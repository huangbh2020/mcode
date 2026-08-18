/**
 * game area messages (mini-game overlay - liars dice). Keys follow the area's
 * prefix convention. zh is the source of truth for `MessageId`.
 */
export const zh = {
  /* ── title / header ── */
  "game.title": "吹牛骰",
  "game.subtitle": "你 vs 模型",
  "game.close": "关闭",
  "game.dragHint": "拖动移动",

  /* ── players ── */
  "game.you": "你",
  "game.model": "模型",
  "game.yourDice": "你的骰子",
  "game.modelDice": "模型的骰子",
  "game.diceCount": "{n} 颗骰子",

  /* ── turn / phase ── */
  "game.yourTurn": "轮到你了",
  "game.modelThinking": "模型思考中…",
  "game.roundOver": "本回合结束",
  "game.gameOver": "游戏结束",

  /* ── bidding ── */
  "game.bid": "叫点",
  "game.challenge": "开骰质疑",
  "game.count": "数量",
  "game.face": "点数",
  "game.currentBid": "当前叫点",
  "game.noBidYet": "本回合尚未叫点",
  "game.bidHistory": "叫点历史",
  "game.confirmBid": "确认叫点",
  "game.invalidBid": "叫点不合法:必须比上家更高(数量更大,或数量相同且点数更大)",
  "game.wildRule": "1 为万能幺,结算时充当任意点数;但不可直接叫 1",

  /* ── round result ── */
  "game.roundResultWin": "质疑成功!对方吹牛,损失 1 颗骰子。",
  "game.roundResultLose": "质疑失败!对方没吹牛,你损失 1 颗骰子。",
  "game.roundResultModelWin": "模型质疑成功!你吹牛了,损失 1 颗骰子。",
  "game.roundResultModelLose": "模型质疑失败!它吹牛了,损失 1 颗骰子。",
  "game.actualCount": "实际数量:{actual}/{bid}",
  "game.continue": "继续下一回合",

  /* ── game over ── */
  "game.gameOverWin": "🎉 你赢了!模型已无骰子。",
  "game.gameOverLose": "😔 你输了。你已无骰子。",
  "game.newGame": "再来一局",
  "game.resign": "认输",

  /* ── empty state ── */
  "game.emptyTitle": "还没有进行中的对局",
  "game.emptyHint": "点击「再来一局」开始一场吹牛骰对决。",
  "game.startGame": "开始游戏",

  /* ── settings ── */
  "game.taunt": "嘴炮",
  "game.tauntOn": "开",
  "game.tauntOff": "关",

  /* ── waiting hint ── */
  "game.waitingHint": "正在等待 agent 输出?趁机走一步。",

  /* ── errors ── */
  "game.errorGeneric": "操作失败,请重试。",
  "game.busy": "模型正在思考,请稍候…",
} as const;
