/**
 * Headless smoke for the terminal-session feature (kind="terminal" PTY
 * sessions running the user's own Claude CLI).
 *
 * Covered modules run for real; electron-adjacent neighbors are aliased to
 * stubs (see run.sh): terminalHistory (path safety + round trip), claudeCli
 * (probe fallback chain; the version assertion spawns the REAL `claude
 * --version` when one is on PATH), TerminalManager (REAL node-pty + REAL
 * shell end-to-end: initCommand injection → shell executes → output
 * round-trips through TERMINAL_DATA; kill → exit event), sessionStart
 * (terminal branch: fresh row + pre-generated CLI UUID + broadcast; chat
 * reuse path untouched), terminalCliCatalog (management-side probe/cache/
 * semver extraction with a steerable `which`; npm actions never execute).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Session } from "@contracts/session";
import { IPC } from "@contracts/ipc";
import {
  terminalHistoryPath,
  saveTerminalHistory,
  loadTerminalHistory,
  deleteTerminalHistory,
} from "@main/lib/terminalHistory.js";
import { resolveClaudeCliPath, probeClaudeCli } from "@main/lib/claudeCli.js";
import { TerminalManager } from "@main/terminal/TerminalManager.js";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import {
  findClaudeProjectDir,
  reconcileTerminalClaudeSessionId,
} from "@main/lib/claudeCli.js";
// Renderer i18n dictionaries — the default-title gate is value-coupled to
// their layout.terminalSession entries; importing them here turns a reworded
// dictionary into a red assertion instead of silently dead auto-naming.
import { zh as zhLayout } from "@renderer/lib/i18n/zh/layout.js";
import { en as enLayout } from "@renderer/lib/i18n/en/layout.js";
import {
  terminalDropInsertText,
  extractDropPayload,
} from "@renderer/lib/terminalDrop.js";
import { FILE_DRAG_MIME } from "@renderer/lib/contentTag.js";
import { buildTerminalInitCommand, terminalCliCommand } from "@renderer/lib/terminalCli.js";
import { reconcileCodexTerminalSessionId } from "@main/lib/codexSession.js";
import { reconcileAgyTerminalSessionId } from "@main/lib/agySession.js";
import {
  resolvePrintedPath,
  resolvePrintedPathWithCandidates,
  resetPrintedPathResolveCache,
} from "@main/lib/terminalPathResolve.js";
import {
  createBusyDetector,
  footerIndicatesRunningTasks,
  screenIndicatesActivity,
  BUSY_PRE_ARM_MS,
  BUSY_QUIET_MS,
} from "@renderer/lib/terminalBusy.js";
import {
  TERMINAL_CLI_CATALOG,
  findTerminalCliEntry,
  probeTerminalCli,
  installTerminalCli,
  normalizeSemverToken,
} from "@main/lib/terminalCliCatalog.js";
import {
  isPathLikeText,
  parseCandidate,
  createFileLinkProvider,
  buildStringToCellMap,
  type PathResolver,
} from "@renderer/lib/terminalFileLinks.js";
import type { Terminal, IBufferLine } from "@xterm/xterm";
import {
  TERMINAL_TITLE_INPUT_CAP,
  TERMINAL_TITLE_MIN_CONTENT,
  buildTerminalTitlePrompt,
  extractTerminalTitleExcerpt,
  isDefaultTerminalTitle,
} from "@main/lib/terminalTitle.js";
// Chat prose linkify: split + hast transform + resolution mapping. The api/
// sessionStore imports inside fileLink.js are aliased to steerable stubs
// (see run.sh), so the terminal-resolve branch can be driven per assertion.
import { splitTextByPathTokens, resolveFilePathToken } from "@renderer/lib/fileLink.js";
import {
  FILE_PATH_LINK_CLASS,
  rehypePathInline,
  transformTextByPaths,
  type HastNode,
} from "@renderer/lib/markdownPathLinks.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const g = globalThis as {
  __TERM_PUSH?: Array<{ channel: string; msg: Record<string, unknown> }>;
  __SESSION_CREATE?: Array<Record<string, unknown> & { id: string }>;
  __BROADCASTS?: Array<Record<string, unknown>>;
  __SMOKE_WHICH__?: (n: string) => string | null;
  __FIND_FRESH?: () => unknown;
  __CLAUDE_ID_ADOPT?: Array<[string, string]>;
  __TERMINAL_CLAIMED?: string[];
};
const tape = () => (g.__TERM_PUSH ??= []);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Windows: right after disposeAll, ConPTY can still hold a handle on the
 * pty's working directory — rmSync EPERMs if we race it. Retry briefly and
 * swallow: leftover temp dirs are not a failed assertion. */
async function rmBestEffort(dir: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch {
      await sleep(300);
    }
  }
}

/* ── A. terminalHistory: path safety + round trip ── */
console.log("[A] terminalHistory");
{
  const base = mkdtempSync(join(tmpdir(), "mcode-term-hist-smoke."));
  try {
    ok(terminalHistoryPath(base, "../evil") === null, "traversal id (../) refused");
    ok(terminalHistoryPath(base, "..\\evil") === null, "traversal id (..\\) refused");
    ok(terminalHistoryPath(base, "sess/evil") === null, "slash id refused");
    ok(terminalHistoryPath(base, "sess_abc123") === join(base, "sess_abc123.ser"), "valid id mapped in-dir");

    const withAnsi = "\x1b[31mhello\x1b[0m\r\nline2 中文";
    ok(saveTerminalHistory(base, "sess_abc123", withAnsi).ok, "save ok (no dims)");
    const r1 = loadTerminalHistory(base, "sess_abc123");
    ok(r1?.content === withAnsi, "load round-trips ANSI + CJK verbatim");
    ok(r1?.cols === undefined && r1?.rows === undefined, "no-dims save loads without geometry");

    ok(
      saveTerminalHistory(base, "sess_dim", withAnsi, { cols: 120, rows: 38 }).ok,
      "save with capture geometry ok",
    );
    const r2 = loadTerminalHistory(base, "sess_dim");
    ok(
      r2?.content === withAnsi && r2?.cols === 120 && r2?.rows === 38,
      "geometry round-trips with the content (size-faithful replay fuel)",
    );

    // Legacy raw-string file (pre-envelope format) decodes as plain content.
    writeFileSync(join(base, "sess_legacy.ser"), "RAW-LEGACY", "utf8");
    const r3 = loadTerminalHistory(base, "sess_legacy");
    ok(
      r3?.content === "RAW-LEGACY" && r3?.cols === undefined,
      "legacy raw-string snapshot decodes (no geometry, replay degrades gracefully)",
    );

    ok(loadTerminalHistory(base, "sess_never") === null, "missing snapshot → null");

    saveTerminalHistory(base, "sess_abc123", "v2");
    ok(loadTerminalHistory(base, "sess_abc123")?.content === "v2", "second save overwrites");

    ok(saveTerminalHistory(base, "bad/id", "x").ok === false, "invalid id save rejected");

    deleteTerminalHistory(base, "sess_abc123");
    ok(loadTerminalHistory(base, "sess_abc123") === null, "delete removes snapshot");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/* ── B. claudeCli: resolution + version probe ── */
console.log("[B] claudeCli probe");
{
  g.__SMOKE_WHICH__ = () => "C:\\fake\\claude.cmd";
  ok(resolveClaudeCliPath() === "C:\\fake\\claude.cmd", "which hit returned verbatim");

  // Real probe against the machine's actual claude (PATH covers npm shims).
  g.__SMOKE_WHICH__ = (n) => (n === "claude" ? "claude" : null);
  const probe = await probeClaudeCli(true);
  if (probe.found && probe.version) {
    ok(/^\d+\.\d+/.test(probe.version), `real probe: version looks sane (${probe.version})`);
  } else {
    // No claude on this machine — acceptable for CI-ish environments; the
    // not-found shape must still be clean.
    ok(probe.found === false, "no CLI on PATH → clean not-found");
  }

  g.__SMOKE_WHICH__ = () => null;
  const none = await probeClaudeCli(true);
  ok(
    none.found === false || (none.path ?? "").includes(".local"),
    "PATH miss → not found (or native-installer fallback)",
  );
}

/* ── C. TerminalManager: real pty, initCommand end-to-end ── */
console.log("[C] TerminalManager initCommand (real node-pty + real shell)");
{
  const work = mkdtempSync(join(tmpdir(), "mcode-term-pty-smoke."));
  try {
    const marker = `SMOKE_INIT_${randomUUID().slice(0, 8)}`;
    const created = await TerminalManager.create({
      projectPath: work,
      cwd: work,
      initCommand: `echo ${marker}`,
    });
    ok(created.ok === true, "create ok");
    if (!created.ok) process.exit(1);
    ok(created.pid > 0, `real pty pid (${created.pid})`);

    // First output chunk (shell booted) → settle delay → injection → shell
    // runs `echo <marker>` → marker comes back through TERMINAL_DATA.
    let sawMarker = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const hit = tape().find(
        (p) =>
          p.channel === IPC.TERMINAL_DATA &&
          typeof p.msg.data === "string" &&
          p.msg.data.includes(marker),
      );
      if (hit) {
        sawMarker = true;
        break;
      }
      await sleep(150);
    }
    ok(sawMarker, "initCommand injected after first output and executed (marker echoed back)");

    // A second terminal WITHOUT initCommand must not inject anything odd —
    // it just needs to boot and be killable.
    const plain = await TerminalManager.create({ projectPath: work, cwd: work });
    ok(plain.ok === true, "plain create (no initCommand) ok");

    const before = tape().length;
    ok(TerminalManager.kill((plain as { terminalId: string }).terminalId), "kill returns true");
    let exitSeen = false;
    for (let i = 0; i < 100 && !exitSeen; i++) {
      exitSeen = tape()
        .slice(before)
        .some((p) => p.channel === IPC.TERMINAL_EXIT);
      if (!exitSeen) await sleep(100);
    }
    ok(exitSeen, "kill pushes TERMINAL_EXIT");
    ok(TerminalManager.list().length === 1, "one terminal remains after kill");
    TerminalManager.disposeAll();
    ok(TerminalManager.list().length === 0, "disposeAll clears all");
  } finally {
    await rmBestEffort(work);
  }
}

/* ── D. sessionStart: terminal branch vs chat path ── */
console.log("[D] sessionStart branches");
{
  g.__SESSION_CREATE = [];
  g.__BROADCASTS = [];
  g.__FIND_FRESH = () => ({ id: "sess_fresh", kind: "chat", projectId: "p1" });

  const term = createOrReuseSession(
    { projectId: "p1", kind: "terminal", effort: "default", permissionMode: "default" },
    "desktop",
  );
  const row = term.session as unknown as Record<string, unknown>;
  ok(row.kind === "terminal", "terminal branch creates kind=terminal row");
  ok(
    typeof row.claudeSessionId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.claudeSessionId as string),
    "claudeSessionId pre-generated as UUID (--session-id/--resume handle)",
  );
  ok(term.reused === false, "terminal never reuses (fresh process by nature)");
  ok(
    (g.__BROADCASTS ?? []).length === 1 &&
      (g.__BROADCASTS![0] as { kind?: string }).kind === "terminal",
    "session.changed broadcast once (visible row)",
  );
  // The fresh-row reuse stub returns a chat row — the terminal branch must
  // NOT have consulted it (create called despite findFresh hit).
  ok((g.__SESSION_CREATE ?? []).length === 1, "findFresh not consulted by terminal branch");

  g.__SESSION_CREATE = [];
  g.__BROADCASTS = [];
  const chat = createOrReuseSession(
    { projectId: "p1", kind: "chat", effort: "default", permissionMode: "default" },
    "desktop",
  );
  ok(chat.reused === true, "chat path still reuses the fresh row (stub hit)");
  ok((g.__SESSION_CREATE ?? []).length === 0, "chat reuse creates no row");
}

/* ── E. terminalTitle: auto-naming pure helpers ── */
console.log("[E] terminalTitle helpers");
{
  ok(isDefaultTerminalTitle("Terminal") && isDefaultTerminalTitle("终端"), "both default titles recognized");
  // Drift guard: the creation-time defaults actually come from the i18n
  // dictionaries — if someone rewords layout.terminalSession without
  // updating the gate set, THIS goes red (the shipped bug: zh value
  // "终端会话" was missing and auto-naming never fired for zh users).
  ok(
    isDefaultTerminalTitle(zhLayout["layout.terminalSession"]) &&
      isDefaultTerminalTitle(enLayout["layout.terminalSession"]),
    "i18n default titles (zh/en layout.terminalSession) pass the gate",
  );
  ok(isDefaultTerminalTitle(" Terminal ") === true, "default gate trims whitespace");
  ok(isDefaultTerminalTitle("修复登录超时") === false, "named/manual title is not default (never overwritten)");

  const noisy = "\u001b[31m✽ Welcome to Claude Code\u001b[0m\r\n\u001b[2m╭──────────╮\u001b[22m\r\n> \u001b[32m帮我修复登录超时问题\u001b[39m";
  const excerpt = extractTerminalTitleExcerpt(noisy);
  ok(
    excerpt.includes("帮我修复登录超时问题") && !excerpt.includes("\u001b") && !excerpt.includes("\r"),
    "excerpt strips ANSI and normalizes CRLF, keeps the prompt",
  );
  ok(
    extractTerminalTitleExcerpt("x".repeat(TERMINAL_TITLE_INPUT_CAP + 500)).length === TERMINAL_TITLE_INPUT_CAP,
    `excerpt caps at ${TERMINAL_TITLE_INPUT_CAP}`,
  );
  ok(
    "banner".repeat(15).length < TERMINAL_TITLE_MIN_CONTENT &&
      "banner".repeat(25).length >= TERMINAL_TITLE_MIN_CONTENT,
    "min-content gate sits between banner-scale and real-prompt-scale text",
  );

  const fenced = buildTerminalTitlePrompt('恶意"/指令\n跨行');
  ok(fenced.startsWith("下面是一个 JSON 字符串"), "prompt starts with the fixed shell (never a leading slash)");
  ok(
    fenced.includes(JSON.stringify('恶意"/指令\n跨行')),
    "content rides in an unbreakable JSON fence (quotes/newlines escaped)",
  );
}

/* ── F. resume reconciliation: adopt the CLI's real session id ── */
console.log("[F] reconcileTerminalClaudeSessionId");
{
  const root = mkdtempSync(join(tmpdir(), "mcode-term-reconcile-smoke."));
  try {
    // Project-dir matching is normalization-based (drive-letter case varies
    // with how the CLI was invoked — `D--…` vs `d--…` both observed live).
    const dirName = "D--00-test-proj";
    const cwd = "D:\\00\\test-proj";
    mkdirSync(join(root, dirName));
    const projDir = join(root, dirName);
    ok(findClaudeProjectDir(root, cwd) === projDir, "project dir matched via normalization (case/seps)");
    ok(findClaudeProjectDir(root, "D:\\00\\nope") === null, "unknown cwd → null");

    // Minimal terminal-row fixture (cast: only the fields reconcile reads).
    const termSession = {
      id: "sess_term1",
      kind: "terminal",
      providerId: "claude-sdk",
      claudeSessionId: "deadbeef-0000",
      createdAt: Date.now() - 60_000,
    } as unknown as Session;
    const adoptTape = () => (g.__CLAUDE_ID_ADOPT ??= []);

    // Case 1 — pin honored: the pinned file exists → no-op.
    writeFileSync(join(projDir, "deadbeef-0000.jsonl"), "{}");
    ok(
      reconcileTerminalClaudeSessionId(termSession, cwd, root) === null,
      "pin honored (pinned jsonl exists) → no adoption",
    );
    ok(adoptTape().length === 0, "no row update when pin is honored");

    // Case 2 — pin dead (CLI auto-update relaunch): adopt the newest
    // unclaimed candidate, skipping pre-creation and claimed files. Fresh
    // session id: case 1's call consumed sess_term1's throttle window.
    rmSync(join(projDir, "deadbeef-0000.jsonl"));
    const old = join(projDir, "aaaa-old.jsonl");
    const fresh = join(projDir, "bbbb-new.jsonl");
    const claimedFile = join(projDir, "cccc-claimed.jsonl");
    writeFileSync(old, "{}");
    writeFileSync(fresh, "{}");
    writeFileSync(claimedFile, "{}");
    utimesSync(old, new Date(Date.now() - 30 * 60_000), new Date(Date.now() - 30 * 60_000));
    utimesSync(claimedFile, new Date(), new Date());
    g.__TERMINAL_CLAIMED = ["cccc-claimed"];
    g.__BROADCASTS = [];
    const victim = { ...termSession, id: "sess_term1b" } as unknown as Session;
    // The stub's SessionRepo.get reads the create tape — register the row
    // (production reads the real DB, where the row exists by construction).
    g.__SESSION_CREATE = [victim as unknown as Record<string, unknown> & { id: string }];
    const adopted = reconcileTerminalClaudeSessionId(victim, cwd, root);
    ok(adopted === "bbbb-new", "adopted the newest unclaimed post-creation jsonl");
    ok(
      adoptTape().length === 1 && adoptTape()[0][0] === "sess_term1b" && adoptTape()[0][1] === "bbbb-new",
      "adoption persisted via updateClaudeSessionId",
    );
    ok((g.__BROADCASTS ?? []).length === 1, "session.changed broadcast after adoption");

    // Case 3 — throttle: an immediate second pass is a no-op.
    ok(
      reconcileTerminalClaudeSessionId(victim, cwd, root) === null,
      "30s throttle blocks an immediate re-run",
    );

    // Case 4 — nothing adoptable: dead pin; the only fresh file is now
    // claimed (the case-2 adoption persisted) and the rest predate creation.
    const orphan = { ...termSession, id: "sess_term2", claudeSessionId: "orphan-0000" } as unknown as Session;
    g.__TERMINAL_CLAIMED = ["cccc-claimed", "bbbb-new"];
    ok(
      reconcileTerminalClaudeSessionId(orphan, cwd, root) === null,
      "no eligible candidate → null (no wrong adoption)",
    );
  } finally {
    await rmBestEffort(root);
  }
}

/* ── G. drag-and-drop insertion text (file tree → terminal) ── */
console.log("[G] terminalDrop");
{
  ok(
    terminalDropInsertText(["D:\\proj\\src\\a.ts"], true) === "@D:\\proj\\src\\a.ts ",
    "mention mode: @absolute-path + trailing space (matches the composer's file tag)",
  );
  ok(
    terminalDropInsertText(["D:\\proj\\src\\a.ts"], false) === "D:\\proj\\src\\a.ts ",
    "bare mode: plain path (bottom IDE terminal — @ would be a shell literal)",
  );
  ok(
    terminalDropInsertText(["D:\\proj\\p p\\a.ts"], true) === '"@D:\\proj\\p p\\a.ts" ',
    "whitespace paths are double-quoted",
  );
  ok(
    terminalDropInsertText(["D:\\a.ts", "D:\\b.ts"], true) === "@D:\\a.ts @D:\\b.ts ",
    "multiple payloads join on one line",
  );
  ok(terminalDropInsertText([""], true) === "", "empty payload yields nothing");

  // extractDropPayload only touches getData — a duck-typed stand-in works.
  const fakeDt = (file: string, text: string) =>
    ({ getData: (m: string) => (m === FILE_DRAG_MIME ? file : m === "text/plain" ? text : "") }) as unknown as DataTransfer;
  ok(
    extractDropPayload(fakeDt("D:\\x.ts", "junk"))?.kind === "file" &&
      extractDropPayload(fakeDt("D:\\x.ts", "junk"))?.value === "D:\\x.ts",
    "file-tree MIME wins over plain text",
  );
  ok(
    extractDropPayload(fakeDt("", "some text"))?.kind === "text",
    "plain text is the fallback payload",
  );
  ok(extractDropPayload(fakeDt("", "")) === null, "empty drop → null");
}

/* ── H. per-CLI init commands + codex resume adoption ── */
console.log("[H] terminal CLI catalog");
{
  const uuid = "11111111-2222-3333-4444-555555555555";
  ok(
    buildTerminalInitCommand("claude-sdk", uuid, false) === `claude --session-id ${uuid}` &&
      buildTerminalInitCommand("claude-sdk", uuid, true) === `claude --resume ${uuid}`,
    "claude: --session-id first open, --resume on restart",
  );
  ok(
    buildTerminalInitCommand("pi-sdk", uuid, false) === `pi --session-id ${uuid}` &&
      buildTerminalInitCommand("pi-sdk", uuid, true) === `pi --session-id ${uuid}`,
    "pi: one --session-id command for both (creating it if missing)",
  );
  ok(
    buildTerminalInitCommand("codex-sdk", uuid, false) === "codex" &&
      buildTerminalInitCommand("codex-sdk", uuid, true) === `codex resume ${uuid}`,
    "codex: bare launch first (no pin), resume-by-id after adoption",
  );
  ok(
    buildTerminalInitCommand("antigravity", uuid, false) === "agy --dangerously-skip-permissions" &&
      buildTerminalInitCommand("antigravity", uuid, true) ===
        `agy --dangerously-skip-permissions --conversation ${uuid}`,
    "antigravity: bare launch (skip-permissions) first, --conversation <uuid> after adoption",
  );
  ok(
    buildTerminalInitCommand("claude-sdk", null, false) === null &&
      buildTerminalInitCommand("unknown-provider", uuid, false) === null,
    "degenerate inputs → plain shell (null)",
  );
  ok(
    terminalCliCommand("pi-sdk") === "pi" && terminalCliCommand("codex-sdk") === "codex",
    "providerId → shell command mapping",
  );

  // codex adoption: rollout tree, newest post-creation unclaimed file wins.
  const root = mkdtempSync(join(tmpdir(), "mcode-codex-reconcile-smoke."));
  try {
    const dayDir = join(root, "2026", "10", "19");
    mkdirSync(dayDir, { recursive: true });
    const uuidA = "aaaaaaaa-0000-4000-8000-00000000000a";
    const uuidB = "bbbbbbbb-0000-4000-8000-00000000000b";
    const stale = join(dayDir, `rollout-2026-10-19T01-00-00-${uuidA}.jsonl`);
    const fresh = join(dayDir, `rollout-2026-10-19T23-00-00-${uuidB}.jsonl`);
    writeFileSync(stale, "{}");
    writeFileSync(fresh, "{}");
    writeFileSync(join(dayDir, "not-a-rollout.jsonl"), "{}");
    utimesSync(stale, new Date(Date.now() - 30 * 60_000), new Date(Date.now() - 30 * 60_000));

    const codexSession = {
      id: "sess_codex1",
      kind: "terminal",
      providerId: "codex-sdk",
      claudeSessionId: "deadpin-0000",
      createdAt: Date.now() - 60_000,
    } as unknown as Session;
    g.__SESSION_CREATE = [codexSession as unknown as Record<string, unknown> & { id: string }];
    g.__TERMINAL_CLAIMED = [];
    g.__CLAUDE_ID_ADOPT = [];
    const adopted = reconcileCodexTerminalSessionId(codexSession, root);
    ok(adopted === uuidB, "codex: adopted newest post-creation rollout uuid (stale + non-rollout skipped)");
    ok(
      (g.__CLAUDE_ID_ADOPT ?? []).length === 1 && g.__CLAUDE_ID_ADOPT![0][1] === uuidB,
      "codex adoption persisted",
    );
    // Provider guard: a claude row must not run the codex reconciler (and
    // vice versa — the claude reconciler guards pi/codex rows in lib).
    const claudeRow = { ...codexSession, id: "sess_claude2", providerId: "claude-sdk" } as unknown as Session;
    ok(
      reconcileCodexTerminalSessionId(claudeRow, root) === null,
      "codex reconciler ignores non-codex rows",
    );

    // agy adoption: conversations/<uuid>.db, newest post-creation wins.
    const agyRoot = mkdtempSync(join(tmpdir(), "mcode-agy-reconcile-smoke."));
    try {
      const uuidC = "cccccccc-0000-4000-8000-00000000000c";
      const uuidD = "dddddddd-0000-4000-8000-00000000000d";
      writeFileSync(join(agyRoot, `${uuidC}.db`), "{}");
      writeFileSync(join(agyRoot, `${uuidD}.db`), "{}");
      const oldC = join(agyRoot, `${uuidC}.db`);
      utimesSync(oldC, new Date(Date.now() - 30 * 60_000), new Date(Date.now() - 30 * 60_000));
      const agySession = {
        id: "sess_agy1",
        kind: "terminal",
        providerId: "antigravity",
        claudeSessionId: "deadpin-0002",
        createdAt: Date.now() - 60_000,
      } as unknown as Session;
      g.__SESSION_CREATE = [agySession as unknown as Record<string, unknown> & { id: string }];
      g.__TERMINAL_CLAIMED = [];
      g.__CLAUDE_ID_ADOPT = [];
      const adoptedAgy = reconcileAgyTerminalSessionId(agySession, agyRoot);
      ok(adoptedAgy === uuidD, "agy: adopted newest post-creation conversation uuid (stale skipped)");
      ok(
        reconcileAgyTerminalSessionId(claudeRow, agyRoot) === null,
        "agy reconciler ignores non-antigravity rows",
      );
      ok(reconcileAgyTerminalSessionId(agySession, join(agyRoot, "nope")) === null, "agy: missing conversations dir → null");
    } finally {
      await rmBestEffort(agyRoot);
    }
    const piRow = {
      id: "sess_pi1",
      kind: "terminal",
      providerId: "pi-sdk",
      claudeSessionId: "deadpin-0001",
      createdAt: Date.now() - 60_000,
    } as unknown as Session;
    ok(
      reconcileTerminalClaudeSessionId(piRow, "D:\\anywhere", root) === null,
      "claude reconciler ignores pi rows (pi pin is deterministic)",
    );
  } finally {
    await rmBestEffort(root);
  }
}

/* ── I. click-to-open file path matching ── */
console.log("[I] terminalFileLinks matching");
{
  // Resolver stub: a fixed set of "existing" files (case-soft on win32-style
  // candidates is the host RPC's job; here exact-match suffices).
  const files = new Set([
    "src/main.ts",
    "D:\\proj\\src\\main.ts",
    "docs/产线规范.md",
    "README.md",
  ]);
  const resolve: PathResolver = (t) => files.has(t.path) || files.has(t.path.replace(/\\/g, "/"));

  ok(isPathLikeText("src/main.ts"), "relative nested path matches");
  ok(isPathLikeText("D:\\proj\\src\\main.ts"), "windows absolute matches");
  ok(!isPathLikeText("plainword"), "bare word does not match");
  ok(!isPathLikeText(""), "empty does not match");

  const t1 = parseCandidate("src/main.ts:42:7", resolve);
  ok(
    t1?.path === "src/main.ts" && t1?.line === 42 && t1?.column === 7,
    "path:line:column suffix split and resolved",
  );
  const t2 = parseCandidate("docs/产线规范.md", resolve);
  ok(t2?.path === "docs/产线规范.md", "CJK filenames survive matching");
  ok(parseCandidate("port: 5173", resolve) === null, "time/port-like strings never hijack (file part missing)");
  ok(parseCandidate("totally/missing.ts", resolve) === null, "non-existent paths drop");
  ok(
    parseCandidate("README.md)", resolve)?.path === "README.md",
    "trailing sentence punctuation stripped",
  );
}

/* ── J. link provider: async-resolution bridge (poisoned-cache regression) ── */
console.log("[J] file link provider async bridge");
{
  // Minimal terminal stand-in: one line of output, re-readable (xterm
  // re-queries a line on every pointer move). getLine mirrors the REAL
  // convention: 0-based index, while provideLinks passes 1-based numbers
  // (the off-by-one here once canceled against the same bug in the code
  // under test and hid it).
  const lineText = "edit src/main.ts to fix it";
  const fakeTerminal = {
    buffer: {
      active: {
        getLine: (n: number) =>
          n === 0 ? { translateToString: () => lineText } : null,
      },
    },
  } as unknown as Terminal;

  // Mirror of the TerminalView bridge's contract: sync answer may be false
  // while the async lookup is "in flight"; the flag flip simulates the
  // RPC resolving AFTER the first scan.
  let exists = false;
  const resolve: PathResolver = (t) => exists && t.path === "src/main.ts";

  const provider = createFileLinkProvider(fakeTerminal, resolve, () => {});
  let first: unknown;
  provider.provideLinks(1, (links) => {
    first = links;
  });
  ok(first === undefined, "first scan (existence unknown yet) → no links");
  exists = true;
  let second: Array<{ text: string; range: { start: { x: number } } }> | undefined;
  provider.provideLinks(1, (links) => {
    second = links as typeof second;
  });
  ok(
    Array.isArray(second) && second.length === 1 && second[0].text === "src/main.ts",
    "second scan after async resolve lands → link appears (miss was NOT cached)",
  );
  // Actuation path: opening uses the warmed cache.
  let opened: string | null = null;
  const provider2 = createFileLinkProvider(fakeTerminal, resolve, (t) => {
    opened = t.path;
  });
  provider2.provideLinks(1, (links) => {
    // xterm always passes (event, text); a dummy event keeps the Node-side
    // test free of DOM globals (MouseEvent doesn't exist in plain node).
    const dummyEvent = { type: "click" } as unknown as MouseEvent;
    (links?.[0] as unknown as { activate: (e: MouseEvent, text: string) => void })?.activate(
      dummyEvent,
      "src/main.ts",
    );
  });
  ok(opened === "src/main.ts", "click opens the resolved file");

  ok(
    parseCandidate("(docs/产线规范.md)", resolve) === null && exists === true,
    "paren-wrapped non-existent path stays unresolved",
  );
  const files = new Set(["docs/产线规范.md"]);
  const resolve2: PathResolver = (t) => files.has(t.path);
  ok(
    parseCandidate("(docs/产线规范.md)", resolve2)?.path === "docs/产线规范.md",
    "leading paren stripped (paths inside parentheses resolve)",
  );
}

/* ── K. bare-filename links + unique-basename fuzzy resolution ── */
console.log("[K] bare names + fuzzy resolve");
{
  // Regex: bare filenames are now candidates; pure numbers never are.
  ok(isPathLikeText(".gitignore"), "dotfile bare name matches");
  ok(isPathLikeText("audio_audit.py"), "bare name.ext matches");
  ok(!isPathLikeText("3.8"), "version-ish number does not match");
  ok(!isPathLikeText("v1.4.2"), "version string does not match (ext must start with a letter)");
  ok(!isPathLikeText("plainword"), "plain word still does not match");

  // Fuzzy resolution against a REAL temp tree (the walk runs for real).
  const root = mkdtempSync(join(tmpdir(), "mcode-path-resolve-smoke."));
  try {
    writeFileSync(join(root, ".gitignore"), "x");
    mkdirSync(join(root, "scratch"), { recursive: true });
    writeFileSync(join(root, "scratch", "audio_audit.py"), "x");
    writeFileSync(join(root, "scratch", "merge_all.py"), "x");
    // A node_modules tree that must be skipped: a decoy audio_audit.py in
    // there must not count (it would make the match ambiguous).
    mkdirSync(join(root, "node_modules", "decoy"), { recursive: true });
    writeFileSync(join(root, "node_modules", "decoy", "audio_audit.py"), "x");

    ok(resolvePrintedPath(root, ".gitignore") === join(root, ".gitignore"), "root dotfile resolves directly");
    ok(
      resolvePrintedPath(root, "audio_audit.py") === join(root, "scratch", "audio_audit.py"),
      "bare name unique in project → fuzzy-resolved into its real directory (node_modules decoy skipped)",
    );
    // Ambiguity: two real matches → null (never jump somewhere wrong). The
    // first fuzzy assertion memoized its result — reset so the walk re-runs
    // against the mutated tree.
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(join(root, "other", "audio_audit.py"), "x");
    resetPrintedPathResolveCache();
    ok(resolvePrintedPath(root, "audio_audit.py") === null, "ambiguous basename (2 real matches) → null");
    resetPrintedPathResolveCache();
    ok(resolvePrintedPath(root, "totally-missing.py") === null, "no match → null");
    ok(resolvePrintedPath(root, "scratch") === null, "directory names never resolve");

    // Ambiguity-tolerant variant (the pick-list flow): the ≥2-hit list comes
    // back as candidates so the renderer can ask "which one" instead of
    // dead-clicking. resolvePrintedPathWithCandidates shares the walk memo
    // with resolvePrintedPath — audio_audit.py is already memoized as 2 hits.
    const amb = resolvePrintedPathWithCandidates(root, "audio_audit.py");
    ok(amb.path === null && amb.candidates.length === 2, "ambiguous bare name → null path + 2 candidates");
    ok(
      amb.candidates.includes(join(root, "scratch", "audio_audit.py")) &&
        amb.candidates.includes(join(root, "other", "audio_audit.py")),
      "candidates carry the full disambiguating paths",
    );
    const uniq = resolvePrintedPathWithCandidates(root, "merge_all.py");
    ok(
      uniq.path === join(root, "scratch", "merge_all.py") && uniq.candidates.length === 0,
      "unique bare name → resolved path, no candidates",
    );
    const direct = resolvePrintedPathWithCandidates(root, ".gitignore");
    ok(
      direct.path === join(root, ".gitignore") && direct.candidates.length === 0,
      "direct hit → path, no candidates",
    );
    const miss = resolvePrintedPathWithCandidates(root, "totally-missing.py");
    ok(miss.path === null && miss.candidates.length === 0, "miss → null path, no candidates");
    ok(
      resolvePrintedPathWithCandidates(root, "scratch/nope.py").candidates.length === 0,
      "separator-path miss → no fuzzy candidates (fuzzy is bare-name only)",
    );
    // Candidate cap: the pick list stops at 8 — the 9th same-name copy never
    // materializes (the walk early-exits at the cap).
    for (let i = 0; i < 9; i++) {
      const dir = join(root, `cap${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "dup.dat"), "x");
    }
    const capped = resolvePrintedPathWithCandidates(root, "dup.dat");
    ok(
      capped.path === null && capped.candidates.length === 8,
      "candidate list caps at 8 (9 same-name files on disk)",
    );
    ok(
      resolvePrintedPath(root, "dup.dat") === null,
      "strict resolver still refuses capped-ambiguous names",
    );
  } finally {
    await rmBestEffort(root);
  }
}

/* ── L. wide-char (CJK) cell-coordinate alignment ── */
console.log("[L] CJK link underline alignment");
{
  // Line "改 src/main.ts 吧": 改/吧 are wide (2 cells each, continuation
  // cell translates to ""). Cells: x0=改, x1=cont, x2=' ', x3..x13=path,
  // x14=' ', x15=吧, x16=cont.
  const cells = ["改", "", " ", "s", "r", "c", "/", "m", "a", "i", "n", ".", "t", "s", " ", "吧", ""];
  const text = "改 src/main.ts 吧";
  const fakeLine = {
    length: cells.length,
    getCell: (x: number) => (x < cells.length ? { getChars: () => cells[x] } : undefined),
    translateToString: () => text,
  } as unknown as IBufferLine;

  const map = buildStringToCellMap(fakeLine, text.length);
  ok(map[2] === 3, "string idx of path start maps to cell 3 (wide char + continuation skipped)");
  ok(map[12] === 13, "string idx of path end maps to cell 13");

  // Integration: the provider's link range must use CELL columns, i.e.
  // start.x=4 / end.x=14 (1-based) — not the naive string indices 3/13
  // that drift left one cell per preceding CJK char.
  const resolve: PathResolver = (t) => t.path === "src/main.ts";
  const fakeTerminal = {
    buffer: { active: { getLine: (n: number) => (n === 0 ? fakeLine : null) } },
  } as unknown as Terminal;
  const provider = createFileLinkProvider(fakeTerminal, resolve, () => {});
  let range: { start: { x: number }; end: { x: number } } | undefined;
  provider.provideLinks(1, (links) => {
    range = (links?.[0] as unknown as { range: typeof range })?.range;
  });
  ok(range?.start.x === 4 && range?.end.x === 14, "link range aligned to cells under CJK prefix (was drifting left)");
}

/* ── M. "model processing" busy detector ── */
console.log("[M] terminal busy detector");
{
  const events: boolean[] = [];
  const d = createBusyDetector((b) => events.push(b));
  const T = 1_000_000;
  ok(BUSY_PRE_ARM_MS < BUSY_QUIET_MS, "pre-arm window shorter than quiet window");

  // Submit → busy immediately.
  d.userInput("hello\r", T);
  ok(events[events.length - 1] === true, "Enter arms busy immediately");
  // Spinner frames sustain; quiet ends it.
  d.output("frame", T + 300);
  d.output("frame", T + 900);
  d.tick(T + 900 + BUSY_QUIET_MS - 1);
  ok(events.length === 1, "still busy while output flows (quiet not reached)");
  d.tick(T + 900 + BUSY_QUIET_MS + 1);
  ok(events[events.length - 1] === false, "output quiet beyond window → busy ends");

  // Post-turn typing (echo) does NOT re-arm — only Enter does.
  d.output("echo-of-typing", T + 5_000);
  d.tick(T + 20_000);
  ok(events.length === 2, "output without a new Enter never re-arms");

  // No-op Enter (no output) self-cancels after the pre-arm window.
  d.userInput("\r", T + 30_000);
  ok(events[events.length - 1] === true, "empty Enter arms (model may start)");
  d.tick(T + 30_000 + BUSY_PRE_ARM_MS + 1);
  ok(events[events.length - 1] === false, "Enter with no output self-cancels (no-op enter)");

  // Plain keystrokes never arm.
  d.userInput("abc", T + 40_000);
  d.tick(T + 60_000);
  ok(events.length === 4, "typing without Enter never arms");

  // reset() force-clears (process exit / teardown).
  d.userInput("x\r", T + 70_000);
  d.reset();
  ok(events[events.length - 1] === false, "reset force-clears an armed phase");

  // ── External sustain (CLI footer task indicator) ──
  // Background task WITHOUT any Enter: the footer signal alone raises busy.
  const e2: boolean[] = [];
  const d2 = createBusyDetector((b) => e2.push(b));
  d2.sustain(true, T);
  d2.tick(T + 1);
  ok(e2[e2.length - 1] === true, "footer task signal alone raises busy (no Enter needed)");
  // ...and holds it far beyond the quiet window (the turn ended long ago).
  d2.tick(T + 600_000);
  ok(e2[e2.length - 1] === true, "sustain holds busy past the quiet window");

  // Sustained phase suppresses the no-op-Enter self-cancel too: an Enter
  // that produces no output must not kill the spinner while a task runs.
  const e3: boolean[] = [];
  const d3 = createBusyDetector((b) => e3.push(b));
  d3.sustain(true, T);
  d3.tick(T + 1);
  d3.userInput("\r", T + 100);
  d3.tick(T + 100 + BUSY_PRE_ARM_MS + 1);
  ok(e3[e3.length - 1] === true, "no-op Enter does not cancel while sustained");

  // Signal drop (task finished): busy ends after one quiet window from the
  // drop — the completion footer redraw must not be required to keep it.
  d3.sustain(false, T + 100_000);
  d3.tick(T + 100_000 + BUSY_QUIET_MS - 1);
  ok(e3[e3.length - 1] === true, "busy survives the grace window right after drop");
  d3.tick(T + 100_000 + BUSY_QUIET_MS + 1);
  ok(e3[e3.length - 1] === false, "busy ends one quiet window after the signal drops");

  // reset clears a sustained phase (process exited mid-task).
  d2.reset();
  ok(e2[e2.length - 1] === false, "reset clears a sustained phase");

  // ── Footer predicate ──
  ok(
    footerIndicatesRunningTasks([
      "[09:06:19] node scripts/run_flow_videos.js laoying C1 running",
      "? for shortcuts",
      "Gemini 3.8 Flash · high · 1 task(s) · /ta",
    ]) === true,
    "footer '1 task(s)' indicates running background work",
  );
  ok(
    footerIndicatesRunningTasks(["? for shortcuts", "claude · 0 task(s) · /ta"]) === false,
    "'0 task(s)' does not",
  );
  ok(
    footerIndicatesRunningTasks(["? for shortcuts", "no indicator here"]) === false,
    "no indicator → no sustain",
  );
  ok(footerIndicatesRunningTasks(["2 tasks queued"]) === true, "plural 'N tasks' form matches");
  ok(
    footerIndicatesRunningTasks([
      "The model said: 3 tasks remain in the transcript body",
      "? for shortcuts",
      "claude · high",
    ]) === true,
    "predicate itself scans what it is given — the HOST limits input to the last viewport rows",
  );

  // ── Live-work chrome scan (during-turn signals) ──
  ok(
    screenIndicatesActivity(["✽ Working…", "esc to interrupt"]) === true,
    "turn-active hint 'esc to interrupt' sustains busy",
  );
  ok(
    screenIndicatesActivity(["✔ Read 3 files", "⠸ Running command… 2.3s"]) === true,
    "'Running command…' caption sustains busy (long foreground command)",
  );
  ok(
    screenIndicatesActivity(["Ran (Bash … exit 0)", "Read 3 files"]) === false,
    "persistent transcript lines ('Ran…'/'Read…') are NOT markers — they survive the turn",
  );
  ok(
    screenIndicatesActivity(["? for shortcuts", "claude · high · 0 task(s)"]) === false,
    "idle chrome with 0 tasks → no sustain",
  );
  ok(
    screenIndicatesActivity(["✽ Mo", "deling… esc to interr", "upt"]) === true,
    "soft-wrapped marker split across rows still matches (rows scanned joined)",
  );
  ok(
    screenIndicatesActivity(["ESC to interrupt"]) === true,
    "case-insensitive — the TUI's exact casing must not be load-bearing",
  );
}

/* ── N. terminalCliCatalog: management-side catalog & probe ── */
console.log("[N] terminalCliCatalog (management)");
{
  // Catalog shape: 4 entries in menu order; npm trio + external antigravity.
  ok(
    TERMINAL_CLI_CATALOG.map((e) => e.providerId).join(",") ===
      "claude-sdk,pi-sdk,codex-sdk,antigravity",
    "catalog order mirrors the new-terminal menu",
  );
  ok(
    TERMINAL_CLI_CATALOG.filter((e) => e.packageName).length === 3 &&
      findTerminalCliEntry("antigravity")?.packageName === null &&
      !!findTerminalCliEntry("antigravity")?.downloadUrl,
    "three npm-managed + external antigravity (with download page)",
  );

  // Semver extraction: the "update available" comparison depends on getting
  // the same token out of every CLI's --version first line.
  ok(normalizeSemverToken("2.1.303 (Claude Code)") === "2.1.303", "claude version line → semver");
  ok(normalizeSemverToken("codex-cli 0.121.0") === "0.121.0", "codex version line → semver");
  ok(normalizeSemverToken("1.1.0") === "1.1.0", "bare semver passes through");
  ok(normalizeSemverToken("1.0.0-beta.1") === "1.0.0-beta.1", "prerelease suffix preserved");
  ok(normalizeSemverToken("no digits here") === null, "no semver → null");

  // Probes — `which` is steered via the smoke stub. Not-found cases first
  // (claude-sdk excluded: resolveClaudeCliPath also checks the native
  // installer drop, whose presence is machine-dependent).
  g.__SMOKE_WHICH__ = () => null;
  const savedLocalAppData = process.env["LOCALAPPDATA"];
  const emptyLocal = mkdtempSync(join(tmpdir(), "mcode-termcli-empty."));
  process.env["LOCALAPPDATA"] = emptyLocal;
  try {
    const piMissing = await probeTerminalCli("pi-sdk", true);
    const agyMissing = await probeTerminalCli("antigravity", true);
    ok(
      piMissing.installed === false && piMissing.manageMode === "npm" && piMissing.packageName !== null,
      "pi missing → not installed, npm-managed",
    );
    ok(
      agyMissing.installed === false && agyMissing.manageMode === "external",
      "agy missing (PATH + LOCALAPPDATA fallback) → not installed, external",
    );

    // Installed: steer `which` at the running node binary — `"<node>" --version`
    // succeeds through the same quoted-exec path the real CLIs use.
    g.__SMOKE_WHICH__ = (n) => (n === "pi" ? process.execPath : null);
    const piInstalled = await probeTerminalCli("pi-sdk", true);
    ok(
      piInstalled.installed === true &&
        !!piInstalled.path &&
        !!piInstalled.version &&
        !piInstalled.error,
      "pi found → installed with path + version (real --version exec)",
    );

    // Probe cache: a cached hit survives `which` changing underneath.
    g.__SMOKE_WHICH__ = () => null;
    const piCached = await probeTerminalCli("pi-sdk", false);
    ok(piCached.installed === true, "probe cache returns the cached installed state");
    const piForced = await probeTerminalCli("pi-sdk", true);
    ok(piForced.installed === false, "force re-probe bypasses the cache");

    // LOCALAPPDATA fallback resolution: a fake agy.exe resolves as installed
    // even off PATH; a broken binary still reports installed with an error
    // (never throws, never drops the installed flag).
    const agyDir = join(emptyLocal, "agy", "bin");
    mkdirSync(agyDir, { recursive: true });
    writeFileSync(join(agyDir, "agy.exe"), "definitely not a pe image");
    const agyFallback = await probeTerminalCli("antigravity", true);
    ok(
      agyFallback.installed === true && !!agyFallback.path && !!agyFallback.error,
      "agy LOCALAPPDATA fallback resolves; broken binary → installed + error",
    );

    // Install rejects external CLIs at the catalog layer (the IPC handler
    // opens the download page instead — Electron glue, out of module scope).
    const extInstall = await installTerminalCli("antigravity");
    ok(extInstall.ok === false, "install(antigravity) rejected — externally managed");
  } finally {
    g.__SMOKE_WHICH__ = undefined;
    if (savedLocalAppData) process.env["LOCALAPPDATA"] = savedLocalAppData;
    await rmBestEffort(emptyLocal);
  }
}

/* ── O. chat prose path linkify (prose → FileLink pipeline) ── */
console.log("[O] chat prose path linkify");
{
  const gs = globalThis as {
    __STUB_TERMINAL_RESOLVE__?: (
      input: { projectPath: string; path: string },
    ) => Promise<{ path: string | null; candidates: string[] }>;
    __STUB_FILE_SEARCH__?: (
      input: { projectPath: string; query: string; limit: number },
    ) => Promise<{ files: Array<{ name: string; path: string; relativePath: string }> }>;
  };

  // Split: prose paths and :line[:col] absorption.
  {
    const segs = splitTextByPathTokens("已写入 src/lib/a.ts，请查看。");
    const p = segs.find((s) => s.kind === "path");
    ok(p?.kind === "path" && p.token === "src/lib/a.ts", "prose relative path split out");
  }
  {
    const p = splitTextByPathTokens("见 src/a.ts:42 的说明").find((s) => s.kind === "path");
    ok(
      p?.kind === "path" && p.token === "src/a.ts" && p.line === 42 && p.column === undefined,
      "trailing :42 absorbed as line, token stays clean",
    );
  }
  {
    const p = splitTextByPathTokens("src/a.ts:42:7")[0];
    ok(
      p.kind === "path" && p.token === "src/a.ts" && p.line === 42 && p.column === 7,
      ":42:7 absorbed as line + column",
    );
  }
  {
    // The Windows-absolute branch's char class admits ':' so the suffix
    // lands inside the match — it must be stripped back out.
    const p = splitTextByPathTokens("error at D:\\x\\a.ts:42 done").find((s) => s.kind === "path");
    ok(
      p?.kind === "path" && p.token === "D:\\x\\a.ts" && p.line === 42,
      "windows token with swallowed :line stripped and absorbed",
    );
  }
  {
    ok(
      splitTextByPathTokens("see https://example.com/src/a.ts now").every((s) => s.kind === "text"),
      "URL-adjacent path not linkified",
    );
    ok(
      splitTextByPathTokens("mail foo@bar.com ok").every((s) => s.kind === "text"),
      "email-style token not linkified",
    );
    ok(
      splitTextByPathTokens("upgraded to v1.2.3 today").every((s) => s.kind === "text"),
      "version string not linkified",
    );
    ok(
      splitTextByPathTokens("listen on port 5173 please").every((s) => s.kind === "text"),
      "plain words not linkified",
    );
  }

  // Hast transform: placeholder spans with dispatch attributes.
  {
    const out = transformTextByPaths("open src/lib/a.ts to see");
    ok(
      out.length === 3 &&
        out[0].type === "text" &&
        out[1].type === "element" &&
        out[1].tagName === "span" &&
        out[2].type === "text",
      "prose split into text + span + text",
    );
    const cls = (out[1].properties?.className as string[] | undefined) ?? [];
    ok(cls.includes(FILE_PATH_LINK_CLASS), "placeholder span carries the dispatch class");
    ok(out[1].properties?.dataToken === "src/lib/a.ts", "data-token carries the raw token");

    const sp2 = transformTextByPaths("see src/a.ts:42 here").find((n) => n.tagName === "span");
    ok(
      sp2?.properties?.dataToken === "src/a.ts" && sp2?.properties?.dataLine === "42",
      "data-line rides along as string, token stays clean",
    );
    ok(transformTextByPaths("nothing path-like here").length === 0, "no-path text returns [] (node kept)");
  }
  {
    // Plugin walk: code/pre exempt, surrounding prose linkified.
    const tree: HastNode = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          children: [
            { type: "text", value: "run " },
            {
              type: "element",
              tagName: "code",
              properties: {},
              children: [{ type: "text", value: "src/a.ts" }],
            },
            { type: "text", value: " and see src/b.ts after" },
          ],
        },
        {
          type: "element",
          tagName: "pre",
          properties: {},
          children: [
            {
              type: "element",
              tagName: "code",
              properties: {},
              children: [{ type: "text", value: "src/c.ts" }],
            },
          ],
        },
      ],
    };
    rehypePathInline()()(tree);
    const p = tree.children![0]!;
    const codeChild = (p.children as HastNode[]).find((c) => c.tagName === "code");
    ok(
      codeChild?.children?.[0]?.type === "text" && codeChild.children[0].value === "src/a.ts",
      "inline-code text untouched by the plugin",
    );
    const pre = tree.children![1]!;
    ok(
      pre.children?.[0]?.children?.[0]?.type === "text",
      "pre text untouched by the plugin",
    );
    ok(
      (p.children as HastNode[]).some(
        (c) => c.type === "element" && c.tagName === "span" && c.properties?.dataToken === "src/b.ts",
      ),
      "prose around the code still linkified",
    );
  }

  // Resolution mapping through the steerable terminal.resolvePath stub.
  {
    let calls = 0;
    gs.__STUB_TERMINAL_RESOLVE__ = async (i) => {
      calls += 1;
      if (i.path === "unique.ts") return { path: "P:/proj/only/unique.ts", candidates: [] };
      if (i.path === "dup.ts") return { path: null, candidates: ["P:/proj/a/dup.ts", "P:/proj/b/dup.ts"] };
      return { path: null, candidates: [] };
    };
    gs.__STUB_FILE_SEARCH__ = async () => ({ files: [] });

    const one = await resolveFilePathToken("unique.ts", "P:/proj");
    ok(
      one.length === 1 && one[0].path === "P:/proj/only/unique.ts" && one[0].relativePath === "only/unique.ts",
      "terminal branch: unique hit → single candidate with relative display path",
    );

    const many = await resolveFilePathToken("dup.ts", "P:/proj");
    ok(
      many.length === 2 && many[1].path === "P:/proj/b/dup.ts" && many[1].relativePath === "b/dup.ts",
      "terminal branch: same-name ambiguity → candidate list for the picker",
    );

    const miss = await resolveFilePathToken("nope.ts", "P:/proj");
    ok(miss.length === 0, "terminal branch miss → search fallback finds nothing");

    // IPC failure degrades to the search-based strategies, not an error.
    gs.__STUB_TERMINAL_RESOLVE__ = async () => {
      throw new Error("ipc down");
    };
    gs.__STUB_FILE_SEARCH__ = async () => ({
      files: [{ name: "q.ts", path: "P:/proj/q.ts", relativePath: "q.ts" }],
    });
    const fell = await resolveFilePathToken("q.ts", "P:/proj");
    ok(fell.length === 1 && fell[0].path === "P:/proj/q.ts", "terminal branch failure → file.search fallback still resolves");

    // No project root → the terminal branch is never consulted.
    calls = 0;
    gs.__STUB_TERMINAL_RESOLVE__ = async () => {
      calls += 1;
      return { path: null, candidates: [] };
    };
    const relNone = await resolveFilePathToken("rel/x.ts", null);
    ok(relNone.length === 0 && calls === 0, "no project root → terminal resolve never called, no candidates");
    const absNone = await resolveFilePathToken("P:/elsewhere/x.ts", "P:/proj");
    ok(absNone.length === 0, "absolute token outside known roots → empty (containment guard)");
    gs.__STUB_TERMINAL_RESOLVE__ = undefined;
    gs.__STUB_FILE_SEARCH__ = undefined;
  }
}

console.log(`\nterminal-session-smoke: ${passed} assertions passed`);
// ConPTY handles keep the event loop alive after disposeAll — exit
// explicitly so the run terminates on its own assertions, not a timeout.
process.exit(0);
