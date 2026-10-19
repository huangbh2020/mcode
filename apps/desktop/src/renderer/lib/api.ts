/** Typed access to the API surface exposed to the renderer. Re-exported so
 *  components don't touch window.api directly (keeps the boundary explicit).
 *
 *  Two transports provide the same `Api` shape:
 *  - Electron (desktop): the preload bridge injects `window.api` (IPC).
 *  - Web (phone): no preload exists — `createWebApi()` builds the HTTP/SSE
 *    shim (whitelisted RPC + one SSE event stream) instead.
 *
 *  The switch lives HERE (module evaluation time) rather than in main.tsx,
 *  because every other module imports `api` at its own module top — an
 *  injection later in the boot sequence would race those imports. On the
 *  desktop the `??` short-circuits on the preload-provided object and the
 *  shim is never constructed.
 */
import type { Api } from "../../preload/index.js";
import { createWebApi } from "./webApi.js";

export const api: Api = window.api ?? createWebApi();

/** True when the renderer runs on the phone (HTTP shim) rather than the
 *  desktop preload bridge. Transport-sensitive code paths key off this —
 *  e.g. list RPCs return slimmed session rows over HTTP, so the store
 *  re-fetches full rows on demand (session:get), and message pages shrink
 *  to keep first-open fast on an off-LAN network. Evaluated at module load,
 *  same as `api` — the transport never changes mid-session. */
export const isWebTransport: boolean = !window.api;

export type { StartSessionInput, SendTurnInput } from "@contracts/ipc";
