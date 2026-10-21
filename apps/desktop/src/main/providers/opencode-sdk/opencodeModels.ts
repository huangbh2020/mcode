/**
 * OpenCode (v2) model list + integration auth — the "official login"
 * surface. Unlike pi/codex there is no third-party endpoint store: the
 * server itself knows which integrations have credentials (SQLite, shared
 * with the user's terminal CLI), and /api/model reports what the current
 * auth state can use — including Zen's PUBLIC free models that work with no
 * login at all (settings.apiKey "public", verified live on 2.1.1).
 */
import type { Model } from "@opencode-ai/sdk/v2/types";
import type {
  OpenCodeIntegrationStatus,
  OpenCodeModelOption,
} from "@contracts/ipc";
import { ensureOpenCodeServer } from "./opencodeServerManager.js";
import { resolveOpenCodeCliPath } from "./opencodeBinaryResolve.js";
import { log } from "@main/lib/logger.js";

/**
 * v2 endpoints wrap their payloads in `{location?, data}` envelopes and
 * hey-api's RequestResult `.data` is the parsed BODY — i.e. the ENVELOPE, not
 * the inner payload (verified live on 2.1.1: model.list →
 * `{location, data: Model[]}`, session.create → `{data: Session}`). Unwrap
 * defensively; a bare payload (future SDK change) passes through untouched.
 */
export function unwrapV2Envelope<T>(body: unknown): T | undefined {
  if (body == null || typeof body !== "object") return undefined;
  const record = body as { data?: unknown };
  if ("data" in record) {
    return (record.data ?? undefined) as T | undefined;
  }
  return body as T;
}

const modelContextCache = new Map<string, number>();

/** Format a context-window token count as the picker's hint ("1M"/"400K"). */
export function formatContextHint(context: number | undefined): string | undefined {
  if (!context || context <= 0) return undefined;
  if (context >= 1_000_000 && context % 1_000_000 === 0) return `${context / 1_000_000}M`;
  if (context >= 1_000_000) return `${(context / 1_000_000).toFixed(1)}M`;
  return `${Math.round(context / 1000)}K`;
}

/** Project one server model row into the picker's option shape. Zen
 *  (providerID "opencode") sorts first, then everything else by provider
 *  and name. `free` marks public models so the UI can badge them. */
export function projectOpenCodeModel(m: Model): OpenCodeModelOption {
  const free =
    (m as unknown as { settings?: { apiKey?: unknown } }).settings?.apiKey === "public";
  const variants = Array.isArray(m.variants)
    ? m.variants.map((v) => v.id).filter((v): v is string => typeof v === "string")
    : undefined;
  const context = (m as unknown as { limit?: { context?: number } }).limit?.context;
  if (context && context > 0) {
    modelContextCache.set(m.id, context);
    modelContextCache.set(`${m.providerID}/${m.id}`, context);
  }
  return {
    id: `${m.providerID}/${m.id}`,
    label: m.name || m.id,
    hint: formatContextHint(context),
    supplier: m.providerID,
    ...(variants && variants.length > 0 ? { variants } : {}),
    ...(free ? { free: true } : {}),
  };
}

/** Resolve the context window limit for a model.
 *  Checks in-memory cache, queries models if empty, then falls back to heuristics
 *  and finally the default 200,000. */
export async function resolveOpenCodeModelContext(
  modelId?: string,
  directory?: string,
): Promise<number> {
  if (!modelId || modelId === "default") return 200_000;

  if (modelContextCache.has(modelId)) {
    return modelContextCache.get(modelId)!;
  }

  // Try querying server models if not cached yet
  try {
    const { models } = await listOpenCodeModels(directory);
    const found = models.find((m) => m.id === modelId || m.id.endsWith(`/${modelId}`));
    if (found && modelContextCache.has(found.id)) {
      return modelContextCache.get(found.id)!;
    }
  } catch {
    // Ignore server error, fall through to heuristics
  }

  // Heuristic fallbacks from model name/id
  const lower = modelId.toLowerCase();
  if (lower.includes("2m")) return 2_000_000;
  if (lower.includes("1m") || lower.includes("1000k")) return 1_000_000;
  if (lower.includes("128k")) return 128_000;
  if (lower.includes("64k")) return 64_000;
  if (lower.includes("32k")) return 32_000;
  if (lower.includes("16k")) return 16_000;
  if (lower.includes("8k")) return 8_000;

  return 200_000;
}

/** All models the server reports for the auth state, Zen first. */
export function sortOpenCodeModels(models: OpenCodeModelOption[]): OpenCodeModelOption[] {
  return [...models].sort((a, b) => {
    const za = a.supplier === "opencode" ? 0 : 1;
    const zb = b.supplier === "opencode" ? 0 : 1;
    if (za !== zb) return za - zb;
    return a.label.localeCompare(b.label);
  });
}

/** Which integrations currently have stored credentials. */
export function projectIntegrations(
  raw: Array<{ id: string; name: string; methods?: Array<{ type?: string }>; connections?: Array<{ id?: string }> }>,
): OpenCodeIntegrationStatus[] {
  return raw.map((i) => ({
    id: i.id,
    name: i.name || i.id,
    connected: (i.connections?.length ?? 0) > 0,
    credentialIds: (i.connections ?? [])
      .map((c) => c.id)
      .filter((id): id is string => typeof id === "string"),
    methods: (i.methods ?? []).map((m) => ({ type: m.type ?? "key" })),
  }));
}

/** List models for a directory. Also reports login status so the picker can
 *  show the "not logged in" empty state — though Zen free models keep the
 *  list non-empty even without any login. */
export async function listOpenCodeModels(
  directory?: string,
): Promise<{ models: OpenCodeModelOption[]; loggedIn: boolean }> {
  const { client } = await ensureOpenCodeServer();
  const [modelsRes, integrations] = await Promise.all([
    client.v2.model.list({
      ...(directory ? { location: { directory } } : {}),
    }),
    client.v2.integration.list().catch(() => ({ data: [] as never[] })),
  ]);
  const rows = unwrapV2Envelope<Model[]>((modelsRes as { data?: unknown }).data) ?? [];
  const models = sortOpenCodeModels(rows.map(projectOpenCodeModel));
  const loggedIn = projectIntegrations(
    unwrapV2Envelope<never[]>((integrations as { data?: unknown }).data) ?? [],
  ).some((i) => i.connected);
  return { models, loggedIn };
}

/** Binary health + per-integration login status. Works without a running
 *  server when the CLI is missing (installed:false short-circuits). */
export async function openCodeAuthStatus(): Promise<{
  installed: boolean;
  version?: string;
  integrations: OpenCodeIntegrationStatus[];
  error?: string;
}> {
  if (!resolveOpenCodeCliPath()) {
    return { installed: false, integrations: [] };
  }
  try {
    const { client } = await ensureOpenCodeServer();
    const res = await client.v2.integration.list();
    const raw = unwrapV2Envelope<Array<{
      id: string;
      name: string;
      methods?: Array<{ type?: string }>;
      connections?: Array<{ id?: string }>;
    }>>((res as { data?: unknown }).data) ?? [];
    return { installed: true, integrations: projectIntegrations(raw) };
  } catch (err) {
    const message = (err as Error).message;
    log.warn(`opencode authStatus failed: ${message}`);
    return { installed: true, integrations: [], error: message };
  }
}

/** Connect an integration with an API key (opencode Zen: id "opencode",
 *  key from opencode.ai/auth). Stored by the server in its own credential
 *  store — shared with the user's terminal CLI. */
export async function connectOpenCodeKey(
  integrationId: string,
  key: string,
  label?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { client } = await ensureOpenCodeServer();
    await client.v2.integration.connect.key({
      integrationID: integrationId,
      key,
      ...(label ? { label } : {}),
    });
    log.info(`opencode: connected integration ${integrationId} with API key`);
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message;
    log.warn(`opencode connectKey failed (${integrationId}): ${message}`);
    return { ok: false, error: message };
  }
}

/** Remove one stored credential (logout). */
export async function logoutOpenCode(credentialId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { client } = await ensureOpenCodeServer();
    await client.v2.credential.remove({ credentialID: credentialId });
    log.info(`opencode: removed credential ${credentialId}`);
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message;
    log.warn(`opencode logout failed (${credentialId}): ${message}`);
    return { ok: false, error: message };
  }
}
