/**
 * Upstream request-header policy for custom (third-party) endpoints.
 *
 * Two delivery paths must agree on the same header set:
 *
 *   - `anthropic` protocol — the claude binary talks to the gateway directly,
 *     so the headers ride the `ANTHROPIC_CUSTOM_HEADERS` env var (see
 *     `claude-sdk/customEnv.ts`).
 *   - `openai` protocol — Mcode's in-process bridge talks to the gateway, so
 *     they are merged into the bridge's upstream request (see
 *     `bridge/bridgeServer.ts`).
 *
 * Two sources feed that set:
 *
 *   1. The config's user-facing `customHeaders` field — for gateways that want
 *      a routing hint, an org/tenant id, or a non-standard auth scheme.
 *   2. A session id auto-supplied for gateways that REFUSE to route without
 *      one ({@link requiresSessionHeader}). Without it every request is
 *      answered `400 MissingSessionID` — the failure that motivated this
 *      module.
 *
 * Pure module (no electron, no SDK) so both paths — and the smoke tests — can
 * import it freely.
 */

import { isValidHeaderName, isValidHeaderValue } from "@contracts/customModel";

/** Header a gateway may require so concurrent conversations can be routed (and
 *  prompt-cached) independently. OpenCode Zen's "Go" plan rejects requests
 *  without it: `400 {"type":"MissingSessionID"}`. */
export const SESSION_HEADER = "x-opencode-session";

/** True when the endpoint is known to demand {@link SESSION_HEADER}. Matched on
 *  the host only (the gateway may be mounted at any path, e.g.
 *  `https://opencode.ai/zen/go/v1`). An unparseable baseUrl is treated as
 *  "not required" — the bridge/env paths surface the real error anyway. */
export function requiresSessionHeader(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "opencode.ai" || host.endsWith(".opencode.ai");
}

/** Case-insensitive presence check — HTTP header names are not case-sensitive,
 *  so a user-typed `X-Opencode-Session` must not get a second, differently
 *  cased copy auto-appended. */
export function hasHeader(headers: Record<string, string>, name: string): boolean {
  const want = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === want);
}

/** Drop entries a gateway (or Node's fetch) would reject, rather than letting
 *  one bad row break every request in the config. Hand-edited JSON is the
 *  reason this exists — the settings form validates before saving. */
export function sanitizeCustomHeaders(
  raw: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue;
    if (!isValidHeaderName(name) || !isValidHeaderValue(value)) continue;
    out[name.trim()] = value;
  }
  return out;
}

/** The header set to send upstream: the config's own headers, plus an
 *  auto session id when the gateway needs one and the user hasn't supplied it
 *  (a user-provided `x-opencode-session` always wins — they may be sharing a
 *  conversation id across clients on purpose).
 *
 *  `sessionId` semantics differ per path and that is deliberate: the direct
 *  path knows the Mcode session id (one conversation = one id), while the
 *  bridge is shared per config across sessions, so it hands out one stable id
 *  for its own lifetime (`RuntimeManager` rewrites the config's baseUrl to the
 *  local bridge before the env builder sees it, so the bridge is the only
 *  place that still knows the real gateway host). Both variants satisfy the
 *  gateway's requirement — stable, non-empty, cache-friendly — and neither is
 *  surfaced to the model or the user. */
export function resolveUpstreamHeaders(
  custom: Record<string, string> | undefined,
  baseUrl: string,
  sessionId: string,
): Record<string, string> {
  const headers = sanitizeCustomHeaders(custom);
  if (sessionId && requiresSessionHeader(baseUrl) && !hasHeader(headers, SESSION_HEADER)) {
    headers[SESSION_HEADER] = sessionId;
  }
  return headers;
}

/** Serialize to the `ANTHROPIC_CUSTOM_HEADERS` wire form: one `Name: Value`
 *  per line. The claude binary forwards these on every API request. */
export function formatCustomHeaderLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

/** Parse an `ANTHROPIC_CUSTOM_HEADERS` value (inherited from the OS env) so we
 *  can merge the user's config on top of it instead of clobbering it. Lines
 *  without a `Name:` prefix are ignored, matching the binary's own tolerance. */
export function parseCustomHeaderLines(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    if (!name) continue;
    out[name] = line.slice(idx + 1).trim();
  }
  return out;
}
