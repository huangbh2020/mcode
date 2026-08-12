/**
 * mobileApi — the HTTP/SSE transport shim that gives the mobile web bundle an
 * `api` surface shaped like the desktop's `window.api` (subset).
 *
 * Same-origin: the bundle is served by the desktop's mobile HTTP server, so
 * calls go to relative `/api/*` with no CORS concern. The device token (issued
 * at pairing) is attached to every request via the Authorization header, and
 * appended as `?token=` for the SSE stream (EventSource can't set headers).
 *
 * The device token + endpoint live in localStorage; `connect()` restores them
 * across reloads, `pair()` exchanges a verification code for a fresh token.
 */
import type { MobileRpcResponse, PairingVerifyInput, PairingVerifyResult } from "@contracts/mobile";
import type { Project, Session, MessageRecord } from "@contracts/session";

const TOKEN_KEY = "mcode-mobile-token";
const ENDPOINT_KEY = "mcode-mobile-endpoint";

/** Persisted auth state. Empty when not yet paired. */
interface AuthState {
  token: string | null;
  endpoint: string | null;
}

/** Read the saved token + endpoint from localStorage. */
function readAuth(): AuthState {
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
    // ignore — private mode etc.
  }
}

export function clearAuth(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    // ignore
  }
}

export function isPaired(): boolean {
  return !!readAuth().token;
}

/** Resolve the API base URL. In production (served same-origin by the desktop)
 *  this is empty (relative URLs). In the Vite dev server (different port) we
 *  fall back to the saved endpoint so the dev bundle can call the desktop. */
function apiBase(): string {
  const { endpoint } = readAuth();
  // Same-origin when served from the desktop; otherwise use the saved endpoint.
  if (location.protocol.startsWith("http") && location.port && endpoint) {
    // Dev: vite dev server port != desktop port → use saved endpoint.
    try {
      const saved = new URL(endpoint);
      if (saved.port && saved.port !== location.port) return endpoint;
    } catch {
      // fall through
    }
  }
  return "";
}

/** Internal: perform a whitelisted RPC. Throws on transport failure or when
 *  the server returns a non-ok envelope. */
async function rpc<T = unknown>(method: string, input: unknown): Promise<T> {
  const { token } = readAuth();
  if (!token) throw new Error("not paired — no device token");
  const res = await fetch(`${apiBase()}/api/rpc`, {
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
    throw new Error("device revoked — please pair again");
  }
  const envelope = (await res.json()) as MobileRpcResponse;
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result as T;
}

/** Complete pairing: exchange the nonce + 6-digit code for a device token. */
async function pair(input: PairingVerifyInput): Promise<PairingVerifyResult> {
  const res = await fetch(`${apiBase()}/api/pair/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `pairing failed (${res.status})`);
  }
  const result = (await res.json()) as PairingVerifyResult;
  // Endpoint comes back from the server (it knows its own LAN address).
  writeAuth(result.deviceToken, result.endpoint);
  return result;
}

/** Build the SSE URL for the event stream. Token goes in the query (EventSource
 *  can't set headers). */
function eventsUrl(): string {
  const { token } = readAuth();
  if (!token) throw new Error("not paired");
  return `${apiBase()}/api/events?token=${encodeURIComponent(token)}`;
}

/** Lightweight health probe — no auth required. */
async function health(): Promise<{ ok: boolean; endpoint: string }> {
  const res = await fetch(`${apiBase()}/api/health`);
  return res.json();
}

/** The typed, mobile-subset api surface. Mirrors the desktop `window.api`
 *  domains; each method maps to a whitelisted RPC on the server. */
export const mobileApi = {
  pair,
  health,
  clearAuth,
  isPaired,
  eventsUrl,

  project: {
    list: () => rpc<{ projects: Project[] }>("project:list", undefined),
    sessions: (input: unknown) => rpc<{ sessions: Session[]; hasMore: boolean; total: number }>("project:sessions", input),
  },
  session: {
    search: (input: unknown) => rpc<{ sessions: Session[] }>("session:search", input),
    messages: (input: unknown) => rpc<{ messages: MessageRecord[]; hasMore: boolean }>("session:messages", input),
  },
  provider: {
    list: () => rpc<{ providers: unknown[] }>("provider:list", undefined),
  },
  claude: {
    healthCheck: () => rpc("claude:healthCheck", undefined),
    startSession: (input: unknown) => rpc("claude:startSession", input),
    sendTurn: (input: unknown) => rpc("claude:sendTurn", input),
    interrupt: (input: unknown) => rpc("claude:interrupt", input),
    approve: (input: unknown) => rpc("claude:approve", input),
    respondQuestion: (input: unknown) => rpc("claude:respondQuestion", input),
    respondPlanApproval: (input: unknown) => rpc("claude:respondPlanApproval", input),
  },
  git: {
    discoverRepos: (input: unknown) => rpc<{ repos: Array<{ path: string; name: string; isRepo: boolean }> }>("git:discoverRepos", input),
    status: (input: unknown) => rpc<{ status: { branch: string; ahead: number; behind: number; files: unknown[] } }>("git:status", input),
    diff: (input: unknown) => rpc<{ patch: string }>("git:diff", input),
    stage: (input: unknown) => rpc<{ ok: boolean; error?: string }>("git:stage", input),
    unstage: (input: unknown) => rpc<{ ok: boolean; error?: string }>("git:unstage", input),
    commit: (input: unknown) => rpc<{ ok: boolean; error?: string }>("git:commit", input),
    push: (input: unknown) => rpc<{ ok: boolean; error?: string }>("git:push", input),
    pull: (input: unknown) => rpc<{ ok: boolean; error?: string; conflict?: boolean; conflictedFiles?: string[] }>("git:pull", input),
    generateCommitMessage: (input: unknown) => rpc<{ ok: boolean; message?: string; error?: string }>("git:generateCommitMessage", input),
  },
};

export type MobileApi = typeof mobileApi;
