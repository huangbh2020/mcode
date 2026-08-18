/**
 * GameService - authoritative owner of the mini-game state (liars dice).
 *
 * Main process is the single source of truth; the renderer mirrors the state
 * returned by the `game.*` RPCs. State is persisted as JSON under
 * `ui.game.state` so a game survives overlay close / app restart.
 *
 * The model opponent runs inside `advance()`: after every user action we loop,
 * asking the model for its move until it's the user's turn again or the game
 * ends. Each model call is a one-shot `query()` (mirrors titleGen / commit-gen)
 * - independent of RuntimeManager / SessionManager, so it never interferes with
 * a running agent turn.
 *
 * Anti-deadlock: the model's JSON output is zod-parsed + rule-validated. An
 * illegal move gets one retry with an error message appended to the prompt; a
 * second failure falls back to a referee move (min legal bid, or challenge) so
 * the game can never hang.
 */
import type { GameState, PlayerId, Bid, Face } from "@contracts/game.js";
import {
  UI_GAME_STATE_SETTING_KEY,
  UI_GAME_TAUNT_SETTING_KEY,
  UI_GAME_MODEL_SETTING_KEY,
  UI_COMPOSER_MODEL_SETTING_KEY,
  parseGameState,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { resolveModelForGitOp } from "@main/ipc/git.js";
import { buildCustomEnv, resolveActiveModel } from "@main/providers/claude-sdk/customEnv.js";
import { resolveSdkBinaryPath } from "@main/providers/claude-sdk/sdkBinaryPath.js";
import { log } from "@main/lib/logger.js";
import {
  createNewGame,
  isLegalBid,
  isOutOfDice,
  lastBid,
  loseDie,
  minLegalBid,
  resolveChallenge,
  rollDice,
  startNewRound,
} from "./rules.js";

/** Result of a single model decision. */
interface ModelDecision {
  action: "bid" | "challenge";
  count?: number;
  face?: number;
  taunt?: string;
}

const DECISION_SCHEMA = {
  parse(raw: unknown): ModelDecision | null {
    if (typeof raw !== "object" || raw === null) return null;
    const o = raw as Record<string, unknown>;
    const action = o.action;
    if (action !== "bid" && action !== "challenge") return null;
    const dec: ModelDecision = { action };
    if (action === "bid") {
      if (typeof o.count !== "number" || typeof o.face !== "number") return null;
      dec.count = o.count;
      dec.face = o.face;
    }
    if (typeof o.taunt === "string") dec.taunt = o.taunt.trim().slice(0, 120);
    return dec;
  },
};

function safeTaunt(s: unknown): string | undefined {
  if (typeof s === "string" && s.trim()) return s.trim().slice(0, 120);
  return undefined;
}

const GAME_SYSTEM_PROMPT = [
  "你正在和一个人类对手玩「吹牛骰」(大话骰)游戏。你是敌方,由大模型驱动;对方是人类用户。",
  "",
  "规则:",
  "- 双方各有若干颗骰子(初始 5 颗),每回合重新摇骰,只有自己看得见自己的点数。",
  "- 点数 1 是「万能幺」:结算时可充当 2-6 任意点数。但 1 不可直接叫点(可叫点数仅为 2-6)。",
  "- 轮流「叫点」:断言「全场所有骰子里至少有 X 个 Y」(Y∈2-6)。后一手必须加码:数量更大,或数量相同且点数更大。",
  "- 随时可「开骰质疑」:翻开全部骰子计数(显示 Y 的骰数 + 显示 1 的骰数)。达到叫数则质疑者输 1 骰;不够则叫点者输 1 骰。",
  "- 输光骰子者整局败。",
  "",
  "策略提示:先数自己手里有多少颗能凑上当前点数(含 1),再估算对方手中可能的数量,据此决定加注或质疑。可以诈唬。",
  "",
  "严格输出约束:",
  '1. 只输出一个 JSON 对象,不要任何额外文字、解释、Markdown 代码块标记。',
  '2. 叫点:{"action":"bid","count":<整数>,"face":<2-6>,"taunt":"不超过20字的短嘴炮或空字符串"}',
  '3. 质疑:{"action":"challenge","taunt":"不超过20字的短嘴炮或空字符串"}',
  "4. taunt 是可选的嘴炮(可空),用于活跃气氛,不要粗鲁。",
].join("\n");

/** The model-opponent service. Singleton - one game at a time. */
class GameService {
  private current: GameState | null | undefined = undefined; // undefined = not loaded

  /** Lazily load the persisted state. Returns null when no game exists. */
  private load(): GameState | null {
    if (this.current !== undefined) return this.current;
    this.current = parseGameState(SettingRepo.get(UI_GAME_STATE_SETTING_KEY));
    return this.current;
  }

  /** Persist the current state (or clear it when null). */
  private save(): void {
    if (this.current === null) {
      SettingRepo.set(UI_GAME_STATE_SETTING_KEY, "");
    } else {
      SettingRepo.set(UI_GAME_STATE_SETTING_KEY, JSON.stringify(this.current));
    }
  }

  /** Read the current state (for the renderer). */
  getState(): GameState | null {
    return this.load();
  }

  /** Start a fresh game. Clears any in-progress game. */
  newGame(): GameState {
    this.current = createNewGame();
    this.save();
    return this.current;
  }

  /** The user resigns - the model wins. */
  resign(): GameState | null {
    const s = this.load();
    if (!s) return null;
    this.current = { ...s, phase: "gameOver", winner: "model" };
    this.save();
    return this.current;
  }

  /** Is the taunt feature enabled? Default on. */
  isTauntEnabled(): boolean {
    return SettingRepo.get(UI_GAME_TAUNT_SETTING_KEY) !== "off";
  }

  /** Apply the user's bid, then run the model to completion. Returns the final
   *  state (ready for the user's next move) or an error. */
  async userBid(count: number, face: number): Promise<{ ok: true; state: GameState | null } | { ok: false; error: string; state: GameState | null }> {
    const s = this.load();
    if (!s) return { ok: false, error: "no game in progress", state: null };
    if (s.phase !== "bidding") return { ok: false, error: "not in bidding phase", state: s };
    if (s.currentTurn !== "user") return { ok: false, error: "not your turn", state: s };
    const bid: Bid = { count, face: face as Bid["face"] };
    const lb = lastBid(s);
    if (!isLegalBid(bid, lb)) {
      return { ok: false, error: "illegal bid", state: s };
    }
    // Record the user's bid, switch to model.
    this.current = {
      ...s,
      bidHistory: [...s.bidHistory, { by: "user", bid }],
      currentTurn: "model",
    };
    this.save();
    await this.advance();
    return { ok: true, state: this.current ?? null };
  }

  /** The user challenges the model's last bid. Resolve + continue. */
  async userChallenge(): Promise<{ ok: true; state: GameState | null } | { ok: false; error: string; state: GameState | null }> {
    const s = this.load();
    if (!s) return { ok: false, error: "no game in progress", state: null };
    if (s.phase !== "bidding") return { ok: false, error: "not in bidding phase", state: s };
    if (s.currentTurn !== "user") return { ok: false, error: "not your turn", state: s };
    const lb = lastBid(s);
    if (!lb) return { ok: false, error: "nothing to challenge", state: s };
    this.resolveRound(lb, "user");
    await this.advance();
    return { ok: true, state: this.current ?? null };
  }

  /** After a roundOver reveal, start the next round (or end the game). */
  async continueGame(): Promise<{ ok: true; state: GameState | null } | { ok: false; error: string; state: GameState | null }> {
    const s = this.load();
    if (!s) return { ok: false, error: "no game in progress", state: null };
    if (s.phase !== "roundOver") return { ok: false, error: "not in roundOver phase", state: s };
    // The loser of the last round leads the next one (and may already be out).
    const leader: PlayerId = s.lastResult?.loser ?? "user";
    if (isOutOfDice(s, leader)) {
      // loser is out -> other player already won (shouldn't happen here, handled in resolveRound)
      const winner: PlayerId = leader === "user" ? "model" : "user";
      this.current = { ...s, phase: "gameOver", winner };
    } else {
      this.current = startNewRound(s, leader);
    }
    this.save();
    await this.advance();
    return { ok: true, state: this.current ?? null };
  }

  /** Resolve a challenge: settle the round, remove a die, check game over. */
  private resolveRound(finalBid: Bid, challenger: PlayerId): void {
    const s = this.load();
    if (!s) return;
    const allDice: Face[] = [...s.userDice, ...s.modelDice];
    const result = resolveChallenge(finalBid, challenger, allDice);
    let userDice = s.userDice;
    let modelDice = s.modelDice;
    if (result.loser === "user") userDice = loseDie(s, "user");
    else modelDice = loseDie(s, "model");

    let phase: GameState["phase"] = "roundOver";
    let winner: PlayerId | undefined;
    if (userDice.length === 0) {
      phase = "gameOver";
      winner = "model";
    } else if (modelDice.length === 0) {
      phase = "gameOver";
      winner = "user";
    }
    this.current = {
      ...s,
      userDice,
      modelDice,
      phase,
      winner,
      lastResult: result,
      roundsPlayed: s.roundsPlayed + 1,
      currentTurn: winner ? winner : result.loser,
    };
    this.save();
  }

  /**
   * Advance the game: while it's the model's turn and the game isn't over,
   * ask the model for a move and apply it. Runs to completion before returning
   * so the renderer only ever sees states where it's the user's turn (or the
   * game is over / awaiting continue).
   */
  private async advance(): Promise<void> {
    let guard = 0; // safety: never loop more than ~20 model turns
    while (guard++ < 20) {
      const s = this.load();
      if (!s) return;
      if (s.phase !== "bidding") return; // roundOver / gameOver -> stop
      if (s.currentTurn !== "model") return; // user's turn -> stop

      const lb = lastBid(s);
      const decision = await this.askModel(s, lb);
      if (!decision) {
        // Couldn't get a valid decision even with retry - referee fallback.
        this.refereeFallback(s, lb);
        continue;
      }

      if (decision.action === "challenge") {
        if (!lb) {
          // Can't challenge with no prior bid - referee must bid.
          this.applyModelBid(s, minLegalBid(lb), decision.taunt);
          continue;
        }
        // Resolve the round. If the game continues and the model leads the
        // next round, advance() keeps looping; otherwise it stops.
        this.current = { ...s, lastTaunt: decision.taunt };
        this.save();
        this.resolveRound(lb, "model");
        // After resolveRound, phase is roundOver/gameOver. If roundOver, the
        // loser leads the next round. We need to start that round and continue
        // only if the model leads. But we don't auto-continue here - the user
        // must call continueGame() to see the reveal and proceed. So stop.
        return;
      }

      // action === "bid"
      const bid: Bid = { count: decision.count!, face: decision.face! as Bid["face"] };
      if (!isLegalBid(bid, lb)) {
        // Illegal bid - shouldn't happen (askModel retries), but referee-fix.
        this.applyModelBid(s, minLegalBid(lb), decision.taunt);
        continue;
      }
      this.applyModelBid(s, bid, decision.taunt);
      // Now it's the user's turn -> the loop will stop on the next iteration.
    }
  }

  /** Apply the model's bid: record it, switch turn to user. */
  private applyModelBid(s: GameState, bid: Bid, taunt?: string): void {
    this.current = {
      ...s,
      bidHistory: [...s.bidHistory, { by: "model", bid }],
      currentTurn: "user",
      lastTaunt: this.isTauntEnabled() ? safeTaunt(taunt) : undefined,
    };
    this.save();
  }

  /** Referee fallback when the model fails to produce a legal move: bid the
   *  minimum legal bid (or challenge if the bid ceiling is absurdly high). */
  private refereeFallback(s: GameState, lb: Bid | undefined): void {
    // Simple heuristic: if there's no last bid, bid min. Otherwise, if the
    // last bid count already exceeds total dice on the table, challenge;
    // else bid the minimum legal raise.
    const totalDice = s.userDice.length + s.modelDice.length;
    if (lb && lb.count > totalDice) {
      this.current = { ...s, lastTaunt: undefined };
      this.save();
      this.resolveRound(lb, "model");
      return;
    }
    this.applyModelBid(s, minLegalBid(lb), undefined);
  }

  /**
   * Ask the model for its move. Returns a validated decision, or null if the
   * model couldn't produce one even after a retry with error feedback.
   *
   * Mirrors titleGen.ts: dynamic `import query`, `abortController`, `maxTurns:1`,
   * no permissionMode, 60s timeout. Model config from `ui.game.model` (custom
   * configId:roleKey), falling back to the composer's `ui.composerModel`.
   */
  private async askModel(s: GameState, lb: Bid | undefined): Promise<ModelDecision | null> {
    const tauntOn = this.isTauntEnabled();
    const prompt = this.buildPrompt(s, lb, tauntOn, undefined);

    const { model, env, releaseBridge } = await this.resolveModel();
    const binaryPath = resolveSdkBinaryPath();

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    try {
      let text = await this.runQuery(prompt, model, env, binaryPath, ac);
      let decision = this.parseDecision(text);

      if (decision && this.validateDecision(decision, lb)) return decision;

      // Retry once with error feedback.
      const reason = !decision
        ? "你的输出不是合法 JSON 或缺少必要字段。"
        : !this.validateDecision(decision, lb)
          ? this.invalidReason(decision, lb)
          : "未知错误。";
      const retryPrompt = this.buildPrompt(s, lb, tauntOn, reason);
      text = await this.runQuery(retryPrompt, model, env, binaryPath, ac);
      decision = this.parseDecision(text);
      if (decision && this.validateDecision(decision, lb)) return decision;

      log.warn(`GameService: model produced illegal move twice, using referee fallback`);
      return null;
    } catch (err) {
      log.warn(`GameService: model query failed: ${(err as Error).message || String(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
      releaseBridge?.();
    }
  }

  /** Build the user-turn prompt. `errorFeedback` (optional) is appended on retry. */
  private buildPrompt(s: GameState, lb: Bid | undefined, tauntOn: boolean, errorFeedback: string | undefined): string {
    const lines: string[] = [];
    lines.push("当前局面:");
    lines.push(`- 你的骰子(只有你能看见): [${s.modelDice.join(", ")}]`);
    lines.push(`- 你有 ${s.modelDice.length} 颗骰子,对方有 ${s.userDice.length} 颗,全场共 ${s.modelDice.length + s.userDice.length} 颗。`);
    if (lb) {
      lines.push(`- 当前叫点(对方最后所叫):至少 ${lb.count} 个 ${lb.face}。`);
    } else {
      lines.push("- 本回合还没有人叫点,由你开叫。");
    }
    if (s.bidHistory.length > 0) {
      lines.push("- 叫点历史(从早到晚):");
      for (const e of s.bidHistory) {
        const who = e.by === "model" ? "你" : "对方";
        lines.push(`  · ${who} 叫: ${e.bid.count} 个 ${e.bid.face}`);
      }
    }
    lines.push("");
    lines.push(tauntOn
      ? "请决定你的动作(叫点或质疑),并附一句简短嘴炮。"
      : "请决定你的动作(叫点或质疑)。taunt 留空字符串。");
    if (errorFeedback) {
      lines.push("");
      lines.push(`上一次输出有误:${errorFeedback}`);
      lines.push("请重新输出一个合法的 JSON。");
    }
    return lines.join("\n");
  }

  private invalidReason(dec: ModelDecision, lb: Bid | undefined): string {
    if (dec.action === "bid") {
      const bid: Bid = { count: dec.count!, face: dec.face! as Bid["face"] };
      if (bid.face < 2 || bid.face > 6) return `face 必须是 2-6,你给了 ${bid.face}。`;
      if (bid.count < 1) return `count 必须 >= 1。`;
      if (!isLegalBid(bid, lb)) {
        const req = lb
          ? `必须比 ${lb.count} 个 ${lb.face} 更高(数量更大,或数量相同且点数更大)。`
          : "开叫任意合法点数即可。";
        return `叫点不合法,${req}`;
      }
    } else {
      if (!lb) return "目前没有可质疑的叫点,你必须叫点。";
    }
    return "未知错误。";
  }

  private validateDecision(dec: ModelDecision, lb: Bid | undefined): boolean {
    if (dec.action === "challenge") return lb !== undefined;
    if (dec.action === "bid") {
      const bid: Bid = { count: dec.count!, face: dec.face! as Bid["face"] };
      return isLegalBid(bid, lb);
    }
    return false;
  }

  private parseDecision(text: string): ModelDecision | null {
    if (!text) return null;
    // Strip markdown code fences if present.
    let t = text.trim();
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    // Extract the first {...} block (model may add stray text).
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const jsonStr = t.slice(start, end + 1);
    try {
      return DECISION_SCHEMA.parse(JSON.parse(jsonStr));
    } catch {
      return null;
    }
  }

  /** Run a one-shot query and return the assistant's text. */
  private async runQuery(
    prompt: string,
    model: string | undefined,
    env: import("@anthropic-ai/claude-agent-sdk").Options["env"],
    binaryPath: string | null,
    ac: AbortController,
  ): Promise<string> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const q = query({
      prompt,
      options: {
        abortController: ac,
        maxTurns: 1,
        model,
        env,
        systemPrompt: GAME_SYSTEM_PROMPT,
        settingSources: ["project", "local"],
        includePartialMessages: false,
        ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
      },
    });
    let text = "";
    for await (const m of q) {
      if (m.type === "assistant") {
        const content = (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
        if (Array.isArray(content)) {
          text = content.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("\n");
        }
      }
      if (m.type === "result") break;
    }
    return text;
  }

  /**
   * Resolve the model config. Priority: `ui.game.model` (configId:roleKey),
   * falling back to the composer's `ui.composerModel` JSON blob (extract just
   * the customModelId if present, else the bare model string).
   *
   * Returns `{ model, env, releaseBridge }` - `model`/`env` are undefined when
   * using the built-in model (the SDK picks its default).
   */
  private async resolveModel(): Promise<{
    model: string | undefined;
    env: import("@anthropic-ai/claude-agent-sdk").Options["env"];
    releaseBridge: (() => void) | undefined;
  }> {
    // 1. Dedicated game model key (configId:roleKey form, like titleGen/git).
    const stored = SettingRepo.get(UI_GAME_MODEL_SETTING_KEY);
    let customModelId: string | undefined;
    let customModelRole: string | undefined;
    if (stored) {
      const idx = stored.indexOf(":");
      if (idx > 0) {
        customModelId = stored.slice(0, idx);
        customModelRole = stored.slice(idx + 1);
      } else {
        customModelId = stored;
      }
    }

    // 2. Fall back to the composer's persisted model choice.
    if (!customModelId) {
      const composerRaw = SettingRepo.get(UI_COMPOSER_MODEL_SETTING_KEY);
      if (composerRaw) {
        try {
          const composer = JSON.parse(composerRaw) as { customModelId?: string; model?: string };
          if (composer.customModelId) customModelId = composer.customModelId;
        } catch {
          // ignore malformed composer blob
        }
      }
    }

    if (!customModelId) {
      // Built-in model: let the SDK pick its default.
      return { model: undefined, env: undefined, releaseBridge: undefined };
    }

    const resolved = await resolveModelForGitOp(customModelId, customModelRole);
    if (!resolved.ok) {
      log.warn(`GameService: model resolve failed for ${customModelId}: ${resolved.error}`);
      return { model: undefined, env: undefined, releaseBridge: undefined };
    }
    return {
      model: resolveActiveModel(resolved.config),
      env: buildCustomEnv(resolved.config),
      releaseBridge: resolved.releaseBridge,
    };
  }
}

/** Singleton instance. */
export const gameService = new GameService();
