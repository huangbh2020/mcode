/**
 * webApi — the HTTP/SSE transport shim that replaces `window.api` when the
 * shared renderer bundle runs in a plain browser (the phone).
 *
 * The desktop renderer gets `window.api` injected by the preload bridge; in a
 * phone browser there is no preload, so `main.tsx` detects the absence and
 * installs the object created here instead. Everything else — sessionStore,
 * components, all the PC-side optimizations — is the same code.
 *
 * Transport:
 *  - RPC: `POST /api/rpc { method, input }` with `Authorization: Bearer
 *    <deviceToken>`. Only the whitelisted method set (see main/mobile/mobileRpc)
 *    is served; anything else 404s.
 *  - Events: one SSE stream (`/api/events?token=…`) carrying the same
 *    `RuntimeEvent` union the desktop receives over `claude:event`. The bus
 *    deliberately keeps no buffer: a missed delta is recovered on the next
 *    message hydration (the store re-fetches the session snapshot), same as
 *    the desktop reconnect path.
 *
 * Auth: the device token is issued once at pairing (QR + 6-digit code, see
 * {@link pairWithCode}) and lives in localStorage. A 401 anywhere clears it so
 * the pairing gate re-appears instead of looping on dead credentials.
 *
 * Desktop-only surface (terminal / browser / lsp / shell / dialogs / app
 * updates / secrets management) is intentionally ABSENT: the proxy fallback
 * turns any such call into a clear "not available in web mode" error, and the
 * mobile shell hides the UI that would call it.
 */
import type { Api } from "../../preload/index.js";
import { IPC } from "@contracts/ipc";
import type { PickedImage } from "@contracts/ipc";
import type { RuntimeEvent } from "@contracts/runtime";
import type { ThemeState } from "./theme.js";
import type {
  MobileRpcResponse,
  PairingVerifyInput,
  PairingVerifyResult,
} from "@contracts/mobile";

const TOKEN_KEY = "mcode-web-token";
const ENDPOINT_KEY = "mcode-web-endpoint";
const THEME_KEY = "mcode-web-theme";

/** Cap for user-picked images (mirrors the desktop picker's main-side cap and
 *  the SendTurnImageSchema 6M-char ceiling). */
const PICK_IMAGE_MAX_CHARS = 6_000_000;

/* ────────────────────────── auth / pairing ────────────────────────── */

function readAuth(): { token: string | null; endpoint: string | null } {
  try {
    return {
      token: localStorage.getItem(TOKEN_KEY),
      endpoint: localStorage.getItem(ENDPOINT_KEY),
    };
  } catch {
    return { token: null, endpoint: null };
  }
}

function writeAuth(token: string, endpoint: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ENDPOINT_KEY, endpoint);
  } catch {
    // private mode etc. — the pairing gate will just re-appear on reload
  }
}

/** True when this browser holds a device token (pairing completed). */
export function isPaired(): boolean {
  return !!readAuth().token;
}

/** Drop the local device token — back to the pairing gate. */
export function clearAuth(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    // ignore
  }
}

/** The LAN endpoint the server reported at pairing time (diagnostics only —
 *  all API calls are same-origin relative paths). */
export function getPairEndpoint(): string | null {
  return readAuth().endpoint;
}

/** Complete pairing: exchange the nonce + 6-digit code for a device token.
 *  The nonce came from the QR URL (`?nonce=…`); the code is typed on the
 *  phone and displayed on the PC. */
export async function pairWithCode(input: PairingVerifyInput): Promise<PairingVerifyResult> {
  const res = await fetch("/api/pair/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `配对失败 (${res.status})`);
  }
  const result = (await res.json()) as PairingVerifyResult;
  writeAuth(result.deviceToken, result.endpoint);
  return result;
}

/** Lightweight connectivity probe — no auth required. */
export async function webHealth(): Promise<boolean> {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return !!body?.ok;
  } catch {
    return false;
  }
}

/* ────────────────────────── RPC core ────────────────────────── */

async function rpc<T = unknown>(method: string, input?: unknown): Promise<T> {
  const { token } = readAuth();
  if (!token) throw new Error("未配对 — 请先在电脑端生成二维码完成配对");
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ method, input }),
  });
  if (res.status === 401) {
    // Token revoked on the PC side — clear local auth so the pairing screen
    // reappears instead of silently looping on bad credentials.
    clearAuth();
    throw new Error("设备已被电脑端移除 — 请重新配对");
  }
  const envelope = (await res.json().catch(() => null)) as MobileRpcResponse | null;
  if (!envelope || !envelope.ok) {
    throw new Error(envelope && !envelope.ok ? envelope.error : `RPC 失败 (${res.status})`);
  }
  return envelope.result as T;
}

/** Desktop-only stub: throws a clear error. Used for whitelisted-group
 *  members that exist on the desktop Api shape but have no web meaning. */
function webUnsupported(name: string): never {
  throw new Error(`api.${name} 在移动端不可用`);
}

/* ────────────────────────── SSE event bus ────────────────────────── */

type RuntimeSubscriber = (e: RuntimeEvent) => void;
const runtimeSubscribers = new Set<RuntimeSubscriber>();
let sse: EventSource | null = null;

function ensureSse(): void {
  if (sse) return;
  const { token } = readAuth();
  if (!token) return;
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  sse = es;
  es.onmessage = (ev) => {
    try {
      const parsed = JSON.parse(ev.data as string) as { sessionId: string; event: RuntimeEvent };
      for (const fn of runtimeSubscribers) fn(parsed.event);
    } catch {
      // malformed frame — ignore
    }
  };
  // onerror is intentionally empty: EventSource auto-reconnects (transient
  // Wi-Fi blips are common on phones). A hard 401 (revoked device) surfaces
  // on the next RPC, which clears the token and returns the user to pairing.
}

function subscribeRuntime(fn: RuntimeSubscriber): () => void {
  runtimeSubscribers.add(fn);
  ensureSse();
  return () => {
    runtimeSubscribers.delete(fn);
  };
}

/* ────────────────────────── local (no-server) impls ────────────────────────── */

function themeGet(): Promise<ThemeState> {
  const stored = localStorage.getItem(THEME_KEY);
  const theme: ThemeState["theme"] =
    stored === "dark" || stored === "light" || stored === "system" ? stored : "system";
  const effective: ThemeState["effective"] =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  return Promise.resolve({ theme, effective });
}

function themeSet(input: { theme: string }): Promise<ThemeState> {
  try {
    if (input.theme === "dark" || input.theme === "light" || input.theme === "system") {
      localStorage.setItem(THEME_KEY, input.theme);
    }
  } catch {
    // ignore
  }
  // Mirror the desktop handler: return the freshly-resolved state so callers
  // can apply it immediately without a second get.
  return themeGet();
}

/** Web stand-in for the OS image picker: a plain `<input type=file>`. Files
 *  are read locally (FileReader) into base64 — no server round-trip; the
 *  send-time normalization (imageResize.ts) applies downstream like desktop. */
function pickImagesWeb(): Promise<{ images: PickedImage[]; skipped: string[] }> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/gif,image/webp";
    input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      const images: PickedImage[] = [];
      const skipped: string[] = [];
      void Promise.all(
        files.map(async (f) => {
          const mime = f.type.toLowerCase();
          if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime)) {
            skipped.push(f.name);
            return;
          }
          try {
            const buf = new Uint8Array(await f.arrayBuffer());
            let binary = "";
            const chunk = 0x8000;
            for (let i = 0; i < buf.length; i += chunk) {
              binary += String.fromCharCode(...buf.subarray(i, i + chunk));
            }
            const data = btoa(binary);
            if (data.length > PICK_IMAGE_MAX_CHARS) {
              skipped.push(f.name);
              return;
            }
            images.push({
              name: f.name,
              data,
              mimeType: mime as PickedImage["mimeType"],
            });
          } catch {
            skipped.push(f.name);
          }
        }),
      ).then(() => resolve({ images, skipped }));
    };
    input.oncancel = () => resolve({ images: [], skipped: [] });
    input.onerror = () => reject(new Error("无法打开文件选择器"));
    input.click();
  });
}

/** Copy an image data URL onto the clipboard via navigator.clipboard (the
 *  desktop goes through main because contextIsolation blocks this). */
async function writeImageWeb(input: { dataUrl: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    const blob = await (await fetch(input.dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* ────────────────────────── group implementations ────────────────────────── */

const claude: Api["claude"] = {
  startSession: (input) => rpc("claude:startSession", input),
  sendTurn: (input) => rpc("claude:sendTurn", input),
  interrupt: (input) => rpc("claude:interrupt", input),
  approve: (input) => rpc("claude:approve", input),
  respondQuestion: (input) => rpc("claude:respondQuestion", input),
  respondPlanApproval: (input) => rpc("claude:respondPlanApproval", input),
  rewindTurn: (input) => rpc("claude:rewindTurn", input),
};

const project: Api["project"] = {
  create: () => webUnsupported("project.create"),
  list: () => rpc("project:list"),
  sessions: (input) => rpc("project:sessions", input),
  delete: (input) => rpc("project:delete", input),
  archive: (input) => rpc("project:archive", input),
  setGroup: (input) => rpc("project:setGroup", input),
  reorder: (input) => rpc("project:reorder", input),
};

const session: Api["session"] = {
  search: (input) => rpc("session:search", input),
  messages: (input) => rpc("session:messages", input),
  saveMessages: (input) => rpc("session:saveMessages", input),
  upsertMessages: (input) => rpc("session:upsertMessages", input),
  truncateAndInsertMessages: (input) => rpc("session:truncateAndInsertMessages", input),
  updateSettings: (input) => rpc("session:updateSettings", input),
  delete: (input) => rpc("session:delete", input),
  archive: (input) => rpc("session:archive", input),
  rename: (input) => rpc("session:rename", input),
  pin: (input) => rpc("session:pin", input),
};

const provider: Api["provider"] = {
  list: () => rpc("provider:list"),
};

const customModel: Api["customModel"] = {
  list: () => rpc("customModel:list"),
  save: () => webUnsupported("customModel.save"),
  delete: () => webUnsupported("customModel.delete"),
  test: () => webUnsupported("customModel.test"),
  getToken: () => webUnsupported("customModel.getToken"),
};

const piModels: Api["piModels"] = {
  list: () => webUnsupported("piModels.list"),
  save: () => webUnsupported("piModels.save"),
  delete: () => webUnsupported("piModels.delete"),
  listAvailable: () => rpc("piModels:listAvailable"),
  getApiKey: () => webUnsupported("piModels.getApiKey"),
};

const skills: Api["skills"] = {
  list: (input) => rpc("skills:list", input),
  read: (input) => rpc("skills:read", input),
  save: () => webUnsupported("skills.save"),
  delete: () => webUnsupported("skills.delete"),
  scanSources: () => webUnsupported("skills.scanSources"),
  import: () => webUnsupported("skills.import"),
};

const file: Api["file"] = {
  readFile: (input) => rpc("file:readFile", input),
  readBinary: (input) => rpc("file:readBinary", input),
  pickImages: () => pickImagesWeb(),
  listDir: (input) => rpc("file:listDir", input),
  search: () => webUnsupported("file.search"),
  grep: () => webUnsupported("file.grep"),
  writeFile: () => webUnsupported("file.writeFile"),
  mkdir: () => webUnsupported("file.mkdir"),
  delete: () => webUnsupported("file.delete"),
  rename: () => webUnsupported("file.rename"),
};

const git: Api["git"] = {
  discoverRepos: (input) => rpc("git:discoverRepos", input),
  status: (input) => rpc("git:status", input),
  stage: (input) => rpc("git:stage", input),
  unstage: (input) => rpc("git:unstage", input),
  commit: (input) => rpc("git:commit", input),
  push: (input) => rpc("git:push", input),
  pull: (input) => rpc("git:pull", input),
  diff: (input) => rpc("git:diff", input),
  discard: () => webUnsupported("git.discard"),
  generateCommitMessage: (input) => rpc("git:generateCommitMessage", input),
  resolveConflicts: () => webUnsupported("git.resolveConflicts"),
  log: () => webUnsupported("git.log"),
  showCommit: () => webUnsupported("git.showCommit"),
  showFile: () => webUnsupported("git.showFile"),
  listBranches: () => webUnsupported("git.listBranches"),
  checkout: () => webUnsupported("git.checkout"),
};

const setting: Api["setting"] = {
  get: (input) => rpc("setting:get", input),
  set: (input) => rpc("setting:set", input),
  getMany: (input) => rpc("setting:getMany", input),
};

const theme: Api["theme"] = {
  get: () => themeGet(),
  set: (input) => themeSet(input),
};

const shell: Api["shell"] = {
  // No OS shell surface in a phone browser — resolve as no-ops so any
  // "open folder"-style call from shared UI degrades silently.
  openPath: () => Promise.resolve(),
  showItemInFolder: () => Promise.resolve(),
  openFile: () => Promise.resolve(),
};

const clipboardFile: Api["clipboardFile"] = {
  save: async () => ({ ok: false as const, error: "移动端不支持粘贴外部文件,仅支持图片" }),
  writeImage: (input) => writeImageWeb(input),
};

/** Push-event surface. `claudeEvent` rides the SSE stream; every other
 *  channel is desktop-only and subscribes to nothing (the mobile shell hides
 *  the UI that would consume them — theme is localStorage-managed, window
 *  focus is covered by visibilitychange in the hook itself). */
const on: Api["on"] = {
  claudeEvent: (handler) =>
    subscribeRuntime((e) =>
      handler({ channel: IPC.CLAUDE_EVENT, sessionId: e.sessionId, event: e }),
    ),
  sessionTitleUpdated: () => () => {},
  terminalData: () => () => {},
  terminalExit: () => () => {},
  lspEvent: () => () => {},
  browserEvent: () => () => {},
  themeChanged: () => () => {},
  updateAvailable: () => () => {},
  updateDownloadProgress: () => () => {},
  updateDownloaded: () => () => {},
  windowFocusChanged: () => () => {},
  notificationFocusSession: () => () => {},
  // Relay events are desktop-only (the phone doesn't manage SSH).
  relayEvent: () => () => {},
};

/* ────────────────────────── assembly ────────────────────────── */

/** Build the web `window.api` replacement. Desktop-only groups are absent
 *  from the base object; the proxy turns any access to them (or to anything
 *  else missing) into a clear error instead of an opaque undefined-call. */
export function createWebApi(): Api {
  const base = {
    project,
    session,
    provider,
    customModel,
    piModels,
    skills,
    file,
    git,
    claude,
    setting,
    theme,
    shell,
    clipboardFile,
    claudeHealthCheck: (): Promise<{
      installed: boolean;
      source: string | null;
      command: string | null;
    }> => rpc("claude:healthCheck"),
    on,
  };

  return new Proxy(base as unknown as Api, {
    get(target, prop, receiver) {
      const existing = Reflect.get(target, prop, receiver);
      if (existing !== undefined) return existing;
      if (typeof prop !== "string") return existing;
      // Unknown surface (terminal/browser/lsp/dialog/app/... on web) — the
      // shared code calls api.*.<method>, so a throwing function keeps the
      // failure explicit and diagnosable.
      return () => webUnsupported(String(prop));
    },
  });
}
