/**
 * Headless smoke for the pairing page's boot decision (`src/renderer/pair.ts`) —
 * the "a device that already paired must not be asked for a code again" rule.
 *
 * Regression anchor (2026-09-13): the verification code is displayed on the PC,
 * but the pairing URL is re-entered in everyday phone use — browser Back,
 * a restored tab, the bookmarked `?nonce=` link, the home-screen icon. When the
 * page demanded a fresh code in those moments, a user who had walked away from
 * the desk (same Wi-Fi, no screen in sight) was locked out with no way back.
 * pair.ts therefore probes the remembered device token
 * (`GET /api/auth/check`) before drawing anything and skips the form unless the
 * PC actively rejects the token.
 *
 * The scenarios drive the REAL pair.ts through its real DOM contract: the stub
 * document's element registry is built from the ids in `src/renderer/pair.html`
 * (so a renamed/removed id fails here), and the module is re-imported per
 * scenario with a cache-busting query so boot() runs from scratch each time.
 *
 * Run: scripts/mobile-pair-auth-smoke/run.sh
 */
import { readFileSync } from "node:fs";

const TOKEN_KEY = "mcode-web-token";

/** Transpiled copy of pair.ts, put here by run.sh (cache-bustable by query). */
const PAIR_MODULE_URL = process.env["PAIR_MODULE_URL"] ?? "";
/** cwd is apps/desktop (see run.sh) — the real markup the page ships. */
const PAIR_HTML = readFileSync("src/renderer/pair.html", "utf8");

/** Every id pair.ts looks up must exist in pair.html. */
const REQUIRED_IDS = [
  "card",
  "title",
  "desc",
  "form",
  "code",
  "name",
  "error",
  "submit",
  "submitText",
  "foot",
];

let checks = 0;
let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failures++;
    process.stdout.write(
      `  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`,
    );
  }
}

/* ────────────────────────── DOM stub ────────────────────────── */

class El {
  tag: string;
  id = "";
  className = "";
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  children: El[] = [];
  readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(tag: string) {
    this.tag = tag;
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  /** Ids are registered on append, mirroring what getElementById must find. */
  appendChild(child: El): El {
    this.children.push(child);
    if (child.id) registry.set(child.id, child);
    return child;
  }

  querySelector(): El | null {
    return null;
  }
}

let registry = new Map<string, El>();
let redirects: string[] = [];
let storage = new Map<string, string>();
let probes: Array<{ url: string; init: unknown }> = [];

interface CaseConfig {
  /** Remembered device token from an earlier pairing, if any. */
  token?: string;
  /** The `?nonce=` carried by the URL the phone landed on. */
  nonce?: string;
  /** Stands in for the server's answer to GET /api/auth/check. */
  answer: "ok" | "401" | "500" | "offline";
}

function fakeFetch(cfg: CaseConfig) {
  return (url: string, init?: unknown): Promise<unknown> => {
    probes.push({ url, init });
    if (cfg.answer === "offline") return Promise.reject(new Error("network down"));
    const status = cfg.answer === "ok" ? 200 : cfg.answer === "401" ? 401 : 500;
    return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve({ ok: status === 200 }) });
  };
}

function resetGlobals(cfg: CaseConfig): void {
  registry = new Map();
  redirects = [];
  probes = [];
  storage = new Map();
  if (cfg.token) storage.set(TOKEN_KEY, cfg.token);

  for (const m of PAIR_HTML.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) {
    const node = new El(m[1]);
    node.id = m[2];
    registry.set(m[2], node);
  }

  const location = {
    search: cfg.nonce ? `?nonce=${cfg.nonce}` : "",
    origin: "http://192.168.1.5:7331",
    pathname: "/",
    hash: "",
    replace: (url: string) => redirects.push(url),
  };

  const g = globalThis as unknown as Record<string, unknown>;
  g["document"] = {
    documentElement: { lang: "" },
    title: "",
    createElement: (tag: string) => new El(tag),
    getElementById: (id: string) => registry.get(id) ?? null,
  };
  g["location"] = location;
  g["window"] = { location, setTimeout, clearTimeout };
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "zh-CN", userAgent: "McodeSmoke" },
    configurable: true,
    writable: true,
  });
  g["localStorage"] = {
    getItem: (k: string) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };
  g["fetch"] = fakeFetch(cfg);
}

const el = (id: string): El | null => registry.get(id) ?? null;

/** Let the boot() probe promise chain settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function boot(cfg: CaseConfig, caseNo: number): Promise<void> {
  resetGlobals(cfg);
  await import(`${PAIR_MODULE_URL}?case=${caseNo}`);
}

/* ────────────────────────── scenarios ────────────────────────── */

async function main(): Promise<void> {
  if (!PAIR_MODULE_URL) throw new Error("PAIR_MODULE_URL is not set — run via run.sh");

  process.stdout.write("0. pair.html contract\n");
  {
    resetGlobals({ answer: "ok" });
    for (const id of REQUIRED_IDS) check(`#${id} exists in pair.html`, el(id) !== null);
    check(
      "the code form starts hidden in the markup (a paired device must never flash it)",
      /<form[^>]*\bhidden\b/.test(PAIR_HTML),
    );
    check(
      "[hidden] is forced to display:none (an author display:flex would beat the UA rule)",
      /\[hidden\]\s*\{[^}]*display:\s*none/.test(PAIR_HTML),
    );
  }

  process.stdout.write("1. no remembered token, ?nonce present (normal scan)\n");
  {
    await boot({ nonce: "abc123", answer: "ok" }, 1);
    check("form is visible", el("form")?.hidden === false);
    check("no status block", el("status") === null);
    check("no server probe", probes.length === 0, probes);
    check("no redirect", redirects.length === 0);
    await settle();
  }

  process.stdout.write("2. no token, no nonce (link opened without pairing info)\n");
  {
    await boot({ answer: "ok" }, 2);
    check("form hidden", el("form")?.hidden === true);
    check("desc explains the missing link", !!el("desc")?.textContent.includes("缺少配对信息"));
    await settle();
  }

  process.stdout.write("3. remembered token accepted → straight into the app\n");
  {
    await boot({ token: "tok-live", nonce: "abc123", answer: "ok" }, 3);
    check("form never shows", el("form")?.hidden === true);
    check("restoring state is shown", el("status") !== null && el("status")?.hidden === false);
    check(
      "restoring copy while probing",
      !!el("statusText")?.textContent.includes("已配对"),
      el("statusText")?.textContent,
    );
    await settle();
    check("redirected to the app", redirects.length === 1 && redirects[0] === "/", redirects);
    check("token kept", storage.get(TOKEN_KEY) === "tok-live");
    check("probed the right endpoint", probes[0]?.url === "/api/auth/check", probes[0]?.url);
    const headers = (probes[0]?.init as { headers?: Record<string, string> } | undefined)?.headers;
    check("probe carries the bearer token", headers?.["Authorization"] === "Bearer tok-live", headers);
  }

  process.stdout.write("4. token rejected by the PC (401) → form comes back\n");
  {
    await boot({ token: "tok-dead", nonce: "abc123", answer: "401" }, 4);
    await settle();
    check("form is back", el("form")?.hidden === false);
    check("status block hidden", el("status") === null || el("status")?.hidden === true);
    check("token dropped", storage.get(TOKEN_KEY) === undefined);
    check(
      "explained why (so the user knows to fetch a new code)",
      el("error")?.hidden === false && !!el("error")?.textContent.includes("授权已失效"),
      el("error")?.textContent,
    );
    check("no redirect", redirects.length === 0);
    check("code-form description restored", !!el("desc")?.textContent.includes("6 位验证码"));
  }

  process.stdout.write("5. probe fails (offline / 5xx) → keep the pairing, enter anyway\n");
  {
    await boot({ token: "tok-live", nonce: "abc123", answer: "offline" }, 5);
    await settle();
    check("entered the app", redirects.length === 1, redirects);
    check("token kept", storage.get(TOKEN_KEY) === "tok-live");

    await boot({ token: "tok-live", answer: "500" }, 6);
    await settle();
    check("5xx also enters", redirects.length === 1, redirects);
    check("5xx keeps the token", storage.get(TOKEN_KEY) === "tok-live");
  }

  process.stdout.write(failures === 0 ? `\nAll ${checks} checks passed.\n` : `\n${failures}/${checks} FAILED.\n`);
  if (failures > 0) process.exit(1);
}

void main();
