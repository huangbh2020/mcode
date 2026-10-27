/**
 * Domain-level approval gate for agent-initiated browser navigation.
 *
 * Borrowed from the Codex Chrome-extension playbook ("ask before touching a
 * new site"): the agent's browser_navigate is approved per DOMAIN, not per
 * call. Previously every navigate hit the generic per-call approval card (or,
 * on Codex dynamic tools, no approval at all); now:
 *
 *   - localhost / 127.0.0.1 / [::1] / *.localhost and file: origins are
 *     always allowed (dev servers the app itself surfaces in the services
 *     panel; local files are already covered by the file tools' guards).
 *   - hosts in the trusted-domain store (session-scoped in-memory set ∪
 *     persisted global list) pass without prompting. Trusting a parent
 *     domain covers its subdomains (trusting github.com also allows
 *     api.github.com — sites span subdomains heavily; users wanting precise
 *     scope can enter a FQDN).
 *   - bypassPermissions / dontAsk sessions skip the prompt entirely (same
 *     exemption semantics as the project-boundary guards); plan mode still
 *     prompts (plan = review everything).
 *   - anything else raises an approval request whose card carries
 *     `domain: host` — the always-scope select then grants the DOMAIN into
 *     this store (session or global), never the tool name into the tool
 *     allowlists (approving github.com must not blanket-approve navigation
 *     everywhere).
 *
 * Only AGENT-initiated navigation goes through the gate — the user browsing
 * the panel by hand never consults it. The gate is provider-neutral: Claude's
 * canUseTool, Pi's tool_call guard and Codex's invokeDynamicTool all call
 * gateBrowserNavigation with their own requestApproval bridge.
 *
 * Storage mirrors ApprovalBridge's global-allowlist pattern: lazy SettingRepo
 * load (the DB may not be ready when the module first loads; turns can't run
 * that early), whole-list writer for the settings editor, best-effort persist
 * keeping the in-memory grant alive on write failure.
 */
import { randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  ProviderApprovalDecision,
} from "@contracts/provider";
import type { PermissionMode } from "@contracts/runtime";
import { BROWSER_TRUSTED_DOMAINS_SETTING_KEY } from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import { SettingRepo } from "@main/store/repositories.js";

/** Session-scoped trusted domains (die with the app). */
const sessionTrustedDomains = new Map<string, Set<string>>();
/** Persisted global trusted domains (BROWSER_TRUSTED_DOMAINS_SETTING_KEY). */
let globalTrustedDomains = new Set<string>();
let globalTrustedDomainsLoaded = false;

const BROWSER_NAVIGATE_TOOL = "browser_navigate";

/** True for origins the gate never questions. */
function isAlwaysAllowedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1") {
    return true;
  }
  return h.endsWith(".localhost");
}

/** Normalize a host for trust comparisons: lowercase, strip a trailing dot
 *  (FQDN form), strip brackets off IPv6 literals. */
export function normalizeDomain(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Does `host` match a trusted `entry`? Exact match, or the entry is a
 *  parent domain (github.com covers api.github.com, never
 *  notgithub.com.evil.tld). */
export function domainMatches(host: string, entry: string): boolean {
  const h = normalizeDomain(host);
  const e = normalizeDomain(entry);
  if (!h || !e) return false;
  return h === e || h.endsWith("." + e);
}

/** Extract the host of a URL (lowercased, port stripped — trust is
 *  port-agnostic, and "localhost:5173" must match the localhost exemption);
 *  null for non-http(s) schemes or unparseable input. `file:` returns ""
 *  (always allowed — local files). */
export function hostOfUrl(url: string): string | null {
  const trimmed = url.trim();
  if (/^file:/i.test(trimmed)) return "";
  const m = trimmed.match(/^https?:\/\/([^/?#]+)/i);
  if (!m) return null;
  let host = m[1].toLowerCase();
  if (host.startsWith("[")) {
    // IPv6 literal: authority is [::1]:port — keep up to the bracket close.
    const close = host.indexOf("]");
    if (close !== -1) host = host.slice(0, close + 1);
  } else {
    // Exactly one colon separates host:port; multiple colons = a bracketless
    // IPv6 literal, which can't legally appear in a URL authority anyway.
    const colon = host.indexOf(":");
    if (colon !== -1 && host.indexOf(":", colon + 1) === -1) host = host.slice(0, colon);
  }
  return host;
}

/** Load the persisted trusted-domain list on first use (DB may not be ready
 *  yet — same retry posture as ApprovalBridge.ensureGlobalAllowedToolsLoaded). */
function ensureGlobalLoaded(): void {
  if (globalTrustedDomainsLoaded) return;
  try {
    const raw = SettingRepo.get(BROWSER_TRUSTED_DOMAINS_SETTING_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        globalTrustedDomains = new Set(
          parsed
            .filter((d): d is string => typeof d === "string" && d.length > 0)
            .map((d) => normalizeDomain(d))
            .filter((d) => d.length > 0),
        );
      }
    }
    globalTrustedDomainsLoaded = true;
  } catch (err) {
    log.warn(`browser domain gate: failed to load trusted domains: ${(err as Error).message}`);
  }
}

function persistGlobal(): void {
  try {
    SettingRepo.set(
      BROWSER_TRUSTED_DOMAINS_SETTING_KEY,
      JSON.stringify([...globalTrustedDomains].sort()),
    );
  } catch (err) {
    log.error(`browser domain gate: failed to persist trusted domains: ${(err as Error).message}`);
  }
}

/** Is this host trusted for this session (session set ∪ global list)? */
export function isBrowserDomainTrusted(sessionId: string, host: string): boolean {
  ensureGlobalLoaded();
  for (const entry of sessionTrustedDomains.get(sessionId) ?? []) {
    if (domainMatches(host, entry)) return true;
  }
  for (const entry of globalTrustedDomains) {
    if (domainMatches(host, entry)) return true;
  }
  return false;
}

/** Record a trusted-domain grant (called by ApprovalBridge.resolveApproval
 *  when the user grants a domain-kind approval with an always scope). */
export function grantBrowserDomain(
  sessionId: string,
  domain: string,
  scope: "session" | "global",
): void {
  const d = normalizeDomain(domain);
  if (!d) return;
  if (scope === "global") {
    ensureGlobalLoaded();
    if (!globalTrustedDomains.has(d)) {
      globalTrustedDomains.add(d);
      persistGlobal();
    }
  } else {
    let set = sessionTrustedDomains.get(sessionId);
    if (!set) {
      set = new Set();
      sessionTrustedDomains.set(sessionId, set);
    }
    set.add(d);
  }
}

/** Drop session-scoped trust state (ApprovalBridge.rejectAll parity — keeps a
 *  reused session id from inheriting stale grants). */
export function clearSessionBrowserDomains(sessionId: string): void {
  sessionTrustedDomains.delete(sessionId);
}

/** Persisted trusted-domain list (sorted) — settings editor read. */
export function getTrustedBrowserDomains(): string[] {
  ensureGlobalLoaded();
  return [...globalTrustedDomains].sort();
}

/** Replace the persisted list — settings editor write (whole-list). */
export function setTrustedBrowserDomains(domains: string[]): void {
  globalTrustedDomains = new Set(
    domains.map((d) => normalizeDomain(d)).filter((d) => d.length > 0),
  );
  globalTrustedDomainsLoaded = true;
  persistGlobal();
}

export interface DomainGateResult {
  allowed: boolean;
  /** Denial reason aimed at the model (guides it to ask the user or use a
   *  trusted domain). Empty when allowed. */
  reason?: string;
}

/** True when a navigation would pass the gate WITHOUT prompting — used by
 *  browser_script's navigate steps: the batch already ran under one tool
 *  approval, so untrusted domains must go through a standalone
 *  browser_navigate call to get their own domain approval. Mode exemptions
 *  are the caller's concern (the script itself was approved as a tool). */
export function isBrowserNavigationPreapproved(url: string, sessionId: string): boolean {
  const host = hostOfUrl(url);
  if (host === null) return true;
  if (host === "" || isAlwaysAllowedHost(host)) return true;
  return isBrowserDomainTrusted(sessionId, host);
}

/** Decide whether an agent navigation to `url` may proceed, prompting the
 *  user via `requestApproval` when the domain is neither exempt nor trusted.
 *  Providers pass their own approval bridge; `mode` gates the bypass/dontAsk
 *  exemptions (undefined mode = always prompt, used by backends without a UI
 *  permission mode). */
export async function gateBrowserNavigation(
  url: string,
  opts: {
    sessionId: string;
    mode?: PermissionMode;
    requestApproval: (req: ApprovalRequest) => Promise<ProviderApprovalDecision>;
  },
): Promise<DomainGateResult> {
  const host = hostOfUrl(url);
  if (host === null) {
    // Not http(s)/file — the shared browserNavigate's own isAllowedUrl will
    // reject it; the gate has no opinion.
    return { allowed: true };
  }
  if (host === "" || isAlwaysAllowedHost(host)) return { allowed: true };
  if (isBrowserDomainTrusted(opts.sessionId, host)) return { allowed: true };
  if (opts.mode === "bypassPermissions" || opts.mode === "dontAsk") {
    return { allowed: true };
  }
  const decision = await opts.requestApproval({
    requestId: `dom_${randomUUID()}`,
    toolName: BROWSER_NAVIGATE_TOOL,
    input: { url },
    // No description: the card renders localized copy from `domain` itself
    // (i18n lives renderer-side); main stays dictionary-free.
    domain: host,
  });
  if (decision.allow) return { allowed: true };
  return {
    allowed: false,
    reason: `用户拒绝了访问 ${host}。请改用已获信任的域名，或询问用户是否信任该站点。`,
  };
}
