/**
 * Local HTTP server that impersonates an Anthropic `/v1/messages` endpoint.
 *
 * The Claude binary is pointed at this server via `ANTHROPIC_BASE_URL`. It
 * receives Anthropic-formatted POST bodies, translates each to OpenAI's
 * `/v1/chat/completions` format, forwards to the real upstream, and streams
 * the OpenAI SSE response back re-translated into Anthropic SSE.
 *
 * ## Lifecycle
 *
 * Created lazily per upstream config and owned by {@link BridgeRegistry}
 * (which reference-counts so multiple sessions on the same config share one
 * server). `close()` stops listening and frees the port; outstanding requests
 * are left to finish or time out on their own (the registry only closes on
 * config release or app shutdown).
 *
 * ## Why a fresh port per server
 *
 * `listen(0)` lets the OS hand back a free ephemeral port, so we never clash
 * with anything the user is running, and never need a config knob.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { log } from "@main/lib/logger.js";
import { anthropicToOpenAI } from "./requestTranslator.js";
import { OpenAiToAnthropicSse } from "./responseTranslator.js";
import type {
  AnthropicRequest,
  AnthropicSseEvent,
  OpenAIChunk,
  OpenAIRequest,
  UpstreamConfig,
} from "./types.js";

/** Transient upstream-transport status, surfaced to subscribers via
 *  {@link BridgeHandle.onStatus} so the UI can show "上游连接异常,正在重试…"
 *  instead of an unexplained spinner. */
export interface BridgeStatus {
  kind: "retry" | "ok";
  /** Readable transport cause (see describeFetchError); empty for "ok". */
  cause: string;
  attempt: number;
  attempts: number;
}

/** A handle to a running bridge server. */
export interface BridgeHandle {
  /** The local URL the Claude binary should use as ANTHROPIC_BASE_URL. */
  readonly localUrl: string;
  /** An opaque token the binary sends back; the server accepts any value —
   *  this exists only so the env-var contract (`ANTHROPIC_AUTH_TOKEN`) is
   *  satisfied. The real upstream credential is held inside the server. */
  readonly routeToken: string;
  /** Subscribe to transient upstream-transport status (retry loop). The
   *  returned function unsubscribes. Statuses are informational only — the
   *  bridge proceeds identically with or without subscribers. */
  onStatus(cb: (s: BridgeStatus) => void): () => void;
  /** Stop listening. Idempotent. */
  close(): void;
}

/** Whether an upstream base URL looks like an Azure OpenAI deployment.
 *  Azure uses a different path shape and the `api-key` header (not Bearer). */
function looksLikeAzure(baseUrl: string): boolean {
  return /azure\.com/i.test(baseUrl);
}

/** Pull a readable cause out of a Node/undici fetch failure.
 *
 * `fetch()` rejects with a `TypeError` whose `.message` is always the opaque
 * string `"fetch failed"` — useless for diagnosis. The real reason lives on
 * `.cause` as `{ code, message }` (e.g. `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`,
 * `ECONNRESET`). This unwraps it so logs and the error sent back to the user
 * name the actual failure instead of "fetch failed".
 *
 * Also collapses AbortController aborts (client disconnect or our timeout) into
 * a clear "aborted" string rather than surfacing undici's "aborted" / "The user
 * aborted a request" verbatim. */
function describeFetchError(err: unknown): string {
  const e = err as {
    name?: string;
    message?: string;
    cause?: { code?: string; name?: string; message?: string };
  };
  // AbortError surfaces directly (not nested under .cause) when the signal fires.
  if (e?.name === "AbortError" || /abort/i.test(e?.message ?? "")) {
    return "aborted (client disconnect or request timeout)";
  }
  const cause = e?.cause;
  const code = cause?.code || cause?.name;
  if (code) return `${code}: ${cause?.message ?? e?.message ?? "unknown"}`;
  return e?.message || String(err);
}

/** Transport-layer error codes worth a single retry. These are transient by
 *  nature — the connection died mid-flight or a public-IP route flapped — so one
 *  short retry can self-heal without masking a real outage. HTTP status errors
 *  (4xx/5xx) are NOT retried: they carry endpoint semantics (auth, model, quota)
 *  and live on a different code path. */
const RETRYABLE_FETCH_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

function isRetryableFetchError(err: unknown): boolean {
  const code = (err as { cause?: { code?: string; name?: string } })?.cause?.code;
  if (code && RETRYABLE_FETCH_CODES.has(code)) return true;
  // Fall back to a string match on the readable cause — covers variants that
  // only populate .name or surface the code in the message.
  return /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|CONNECT_TIMEOUT|SOCKET|UND_ERR_CLOSED/i.test(
    describeFetchError(err),
  );
}

/** Fetch the upstream with one bounded retry on transient transport failures.
 *
 * Waits {@link backoffMs} before the second attempt; honors `signal` so a client
 * disconnect or timeout aborts immediately rather than sleeping pointlessly.
 * Returns the first successful Response, or throws the last error. Transport
 * retries are reported through `onStatus` (informational — the loop runs the
 * same with or without a subscriber) so the UI can explain a mid-turn stall. */
async function fetchUpstreamWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  onStatus?: (s: BridgeStatus) => void,
  attempts = 2,
  backoffMs = 500,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal.aborted) throw new Error("aborted before fetch");
    try {
      const res = await fetch(url, { ...init, signal });
      // A request that needed retries finally went through — tell
      // subscribers the stall is over (they clear the retry hint).
      if (attempt > 1) onStatus?.({ kind: "ok", cause: "", attempt, attempts });
      return res;
    } catch (err) {
      lastErr = err;
      const cause = describeFetchError(err);
      if (attempt < attempts && isRetryableFetchError(err)) {
        log.warn(`bridge: upstream fetch attempt ${attempt}/${attempts} failed (${cause}); retrying in ${backoffMs}ms`);
        onStatus?.({ kind: "retry", cause, attempt, attempts });
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, backoffMs);
          // If the client disconnects mid-backoff, stop waiting immediately.
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Read and JSON-parse an incoming request body, with a size guard. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const LIMIT = 32 * 1024 * 1024; // 32 MB guard against runaway bodies
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > LIMIT) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Build the upstream request headers (auth differs between OpenAI & Azure).
 *
 * NOTE: we deliberately do NOT set `Content-Length`. When the body passed to
 * `fetch()` is a string (or Buffer/TypedArray), undici computes it itself.
 * Setting it manually triggers `UND_ERR_INVALID_ARG: invalid content-length
 * header` on the undici 6.x bundled with Electron 33 (Node 20) — undici
 * validates a user-supplied Content-Length against its own derivation and
 * rejects the mismatch. Omitting it lets undici own the value, which is both
 * correct and what every other caller does. The `jsonBody` param is kept only
 * so the signature stays stable (the probe path reuses this shape). */
function upstreamHeaders(upstream: UpstreamConfig, _jsonBody: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (looksLikeAzure(upstream.baseUrl)) {
    // Azure OpenAI: `api-key` header, and api-version comes as a query param
    // (added in buildUpstreamUrl).
    headers["api-key"] = upstream.authToken;
  } else {
    // Standard OpenAI / OpenAI-compatible: Bearer token. Both authMode values
    // (auth_token / api_key) map to Bearer here — the distinction only mattered
    // for the Anthropic env vars; on the OpenAI wire it's always Bearer.
    headers["Authorization"] = `Bearer ${upstream.authToken}`;
  }
  return headers;
}

/** Build the full upstream URL, normalizing the path and adding Azure's
 *  api-version query param when applicable. */
function buildUpstreamUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (looksLikeAzure(baseUrl)) {
    // Azure deployments are addressed as {base}/openai/deployments/{deployment}
    // and require `?api-version=`. We assume the user's baseUrl already points
    // at a chat completions path (or the deployment root); we just ensure the
    // version is present and the path ends in /chat/completions.
    const sep = trimmed.includes("?") ? "&" : "?";
    const withVersion = trimmed.includes("api-version=")
      ? trimmed
      : `${trimmed}${sep}api-version=2024-10-21`;
    return withVersion.replace(/\/?$/, "/chat/completions");
  }
  // OpenAI-compatible: ensure it ends at /v1/chat/completions. If the user
  // already included the full path, leave it; if they stopped at /v1, append
  // the rest; otherwise add the whole /v1/chat/completions suffix.
  if (/\/v1\/chat\/completions\/?$/i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  if (/\/v1\/?$/i.test(trimmed)) {
    return `${trimmed.replace(/\/+$/, "")}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

/** Write one Anthropic SSE event to the response, framed as
 *  `event: <type>\ndata: <json>\n\n`. */
function writeSseEvent(res: ServerResponse, ev: AnthropicSseEvent): void {
  res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

/** Send a minimal Anthropic-shaped error back to the binary. We use a 400 with
 *  an `error` JSON body so the SDK surfaces a readable message. */
function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    // Mid-stream — best we can do is a message_delta stop; just end.
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      type: "error",
      error: { type: "bridge_error", message },
    }),
  );
}

/** Handle a single `/v1/messages` POST: translate → forward → stream back. */
async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: UpstreamConfig,
  onStatus?: (s: BridgeStatus) => void,
): Promise<void> {
  let body: AnthropicRequest;
  try {
    const parsed = (await readJsonBody(req)) as AnthropicRequest;
    body = parsed;
  } catch (err) {
    sendError(res, 400, `invalid request body: ${(err as Error).message}`);
    return;
  }

  const openaiReq: OpenAIRequest = anthropicToOpenAI(body);
  // Observability for image turns: count the image_url parts we forward so a
  // gateway that silently drops them (non-vision model behind an OpenAI-
  // protocol endpoint) is diagnosable from main.log — the app-side chain is
  // proven complete when this line shows a non-zero count.
  const imageParts = openaiReq.messages.reduce(
    (n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").length : 0),
    0,
  );
  if (imageParts > 0) {
    log.info(`bridge: forwarding ${imageParts} image part(s) to upstream (${buildUpstreamUrl(upstream.baseUrl)})`);
  }
  // Always stream upstream and re-frame on our side — even non-streaming
  // Anthropic requests can be served from a streaming OpenAI response (we'd
  // just collect the deltas). For the POC we forward stream as-is.
  openaiReq.stream = true;
  // OpenAI only includes `usage` in the final streaming chunk when explicitly
  // asked; without it the bridge never sees token counts, so the context ring
  // in the composer stays empty. Most OpenAI-compatible endpoints honor this
  // flag; those that don't simply omit usage and the ring degrades to its
  // (empty) fallback — same as before.
  openaiReq.stream_options = { include_usage: true };

  const upstreamUrl = buildUpstreamUrl(upstream.baseUrl);
  const jsonBody = JSON.stringify(openaiReq);
  const ac = new AbortController();
  if (upstream.timeoutMs) {
    setTimeout(() => ac.abort(), upstream.timeoutMs).unref();
  }
  // If the client disconnects, abort the upstream fetch.
  req.on("close", () => ac.abort());

  let upstreamRes: Response;
  try {
    upstreamRes = await fetchUpstreamWithRetry(
      upstreamUrl,
      {
        method: "POST",
        headers: upstreamHeaders(upstream, jsonBody),
        body: jsonBody,
      },
      ac.signal,
      onStatus,
    );
  } catch (err) {
    // Use describeFetchError so the real cause (ECONNREFUSED / connect timeout
    // / etc.) surfaces in both the log and the message the user sees — the raw
    // `err.message` is always the opaque "fetch failed".
    const cause = describeFetchError(err);
    log.error(`bridge: upstream fetch failed: ${cause}`);
    sendError(res, 502, `upstream unreachable: ${cause}`);
    return;
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    // Surface the upstream error text so the user sees auth/model failures.
    const errText = await upstreamRes.text().catch(() => "");
    log.warn(`bridge: upstream ${upstreamRes.status}: ${errText.slice(0, 500)}`);
    sendError(res, upstreamRes.status || 502, errText.slice(0, 1000) || `upstream ${upstreamRes.status}`);
    return;
  }

  // Stream headers — Anthropic SSE.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const translator = new OpenAiToAnthropicSse();
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  /** Parse one SSE frame (the text between two blank-line separators) and
   *  feed its data chunk to the translator. Returns how many chunks were
   *  fed (0 for [DONE] / empty / malformed frames). Malformed frames are
   *  logged and skipped — dropping them silently made truncations
   *  unattributable after the fact. */
  const processFrame = (frame: string): number => {
    // Each frame is one or more `data: ...` lines. OpenAI sends a single
    // data line per frame; we parse anything that starts with "data:".
    const dataLines = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    const dataStr = dataLines.join("\n");
    if (!dataStr || dataStr === "[DONE]") {
      // [DONE] is the terminator — nothing to feed.
      return 0;
    }
    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(dataStr) as OpenAIChunk;
    } catch {
      log.warn(`bridge: malformed SSE frame skipped: ${dataStr.slice(0, 200)}`);
      return 0;
    }
    for (const ev of translator.feed(chunk)) {
      writeSseEvent(res, ev);
    }
    return 1;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      // OpenAI SSE frames are separated by blank lines. Process whole frames,
      // keeping any partial tail in the buffer for the next chunk.
      let sep: number;
      while ((sep = sseBuffer.indexOf("\n\n")) >= 0) {
        const frame = sseBuffer.slice(0, sep);
        sseBuffer = sseBuffer.slice(sep + 2);
        processFrame(frame);
      }
    }
    // Flush the decoder (a multi-byte char can straddle the last read), then
    // process whatever is left in the buffer as a final frame. Some upstreams
    // close the socket right after the last `data:` line without the trailing
    // blank line — and that frame typically carries the tool_call fragments
    // + finish_reason. Until 2026-09-02 the residue was dropped silently,
    // which produced exactly the "text streamed fine, the announced tool call
    // never arrived" truncation shape; recovering it (or at least logging it
    // as malformed) makes the next occurrence attributable.
    sseBuffer += decoder.decode();
    const tail = sseBuffer.trim();
    if (tail && processFrame(tail) > 0) {
      log.info(`bridge: recovered tail SSE frame after stream end (${tail.length} bytes) — upstream omitted the trailing blank line`);
    }
    // Stream ended. Close any open block + emit message_delta/message_stop.
    // The translator captured finish_reason off the final choice-bearing
    // chunk and maps it onto Anthropic's stop_reason (a bare stream end with
    // no finish_reason anywhere degrades to end_turn).
    for (const ev of translator.finish()) {
      writeSseEvent(res, ev);
    }
    // Upstream-blame diagnostic: the stream TERMINATED claiming tool_calls,
    // yet not a single tool_call fragment was translated. That combination
    // means the upstream generated the call but dropped its wire fragments —
    // the CLI then sees a text-only end_turn message and closes the turn as
    // success (surfaced downstream as a turn.incomplete "unfinished-text").
    if (translator.finishReason === "tool_calls" && translator.toolBlockCount === 0) {
      log.warn("bridge: upstream finished with finish_reason=tool_calls but no tool-call fragments arrived — upstream dropped them");
    }
  } catch (err) {
    log.error(`bridge: stream read failed: ${(err as Error).message}`);
  } finally {
    res.end();
  }
}

/** Start a bridge server bound to a random local port. Resolves once listening. */
export async function startBridge(upstream: UpstreamConfig): Promise<BridgeHandle> {
  // Status subscribers (RuntimeManager fans these out as `upstream.issue`
  // RuntimeEvents per session using this bridge). Listener errors are
  // swallowed — status is best-effort observability, never control flow.
  const statusListeners = new Set<(s: BridgeStatus) => void>();
  const notifyStatus = (s: BridgeStatus) => {
    for (const cb of statusListeners) {
      try {
        cb(s);
      } catch {
        // ignore — a broken subscriber must not break the bridge
      }
    }
  };
  const server: Server = createServer((req, res) => {
    // The Claude binary POSTs to {baseUrl}/v1/messages. Accept either
    // /v1/messages or a bare /messages for robustness.
    //
    // IMPORTANT: strip the query string before matching. The binary appends
    // `?beta=true` to the path when ANTHROPIC_MODEL is a non-first-party name
    // (it negotiates the anthropic-beta capability via query instead of a
    // header on third-party routes). A bare `endsWith("/v1/messages")` fails
    // to match `/v1/messages?beta=true`, so the request fell through to the
    // 404 branch and the binary interpreted that 404 as "selected model may
    // not exist" - which is exactly the failure users saw with OpenAI-format
    // gateways (e.g. MiniMax-M3). Matching on the path alone fixes it.
    const rawUrl = req.url ?? "";
    const path = rawUrl.split("?", 2)[0];
    if (req.method === "POST" && (path.endsWith("/v1/messages") || path.endsWith("/messages"))) {
      handleMessages(req, res, upstream, notifyStatus).catch((err) => {
        log.error(`bridge: handler threw: ${(err as Error).message}`);
        sendError(res, 500, "internal bridge error");
      });
      return;
    }
    // Anything else (health probes, GET) → 404. The binary only POSTs messages.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { message: "not found" } }));
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("failed to bind bridge server"));
    });
  });

  const routeToken = randomBytes(12).toString("hex");
  log.info(`bridge: listening on 127.0.0.1:${port} → ${upstream.baseUrl}`);

  return {
    localUrl: `http://127.0.0.1:${port}`,
    routeToken,
    onStatus: (cb: (s: BridgeStatus) => void) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    close: () => {
      server.close(() => log.info(`bridge: closed 127.0.0.1:${port}`));
    },
  };
}
