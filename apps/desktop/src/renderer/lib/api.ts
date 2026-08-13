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

export type { StartSessionInput, SendTurnInput } from "@contracts/ipc";
