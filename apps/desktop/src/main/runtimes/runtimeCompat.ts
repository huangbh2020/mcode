/**
 * Mcode's agent-runtime compatibility list — the human-knowledge layer of the
 * "check for updates" feature (docs/agent-runtime-update.md §4.1).
 *
 * Upstream behavioral breakage (permission prompts dying with "Stream closed",
 * dialog kinds renamed, settle-gate races — see AGENTS.md's SDK upgrade
 * checklist) can NOT be detected by client-side probing. It is only known
 * after a manual regression pass. That knowledge lives here:
 *
 *   - `tested`: versions a human has regression-tested with THIS app build
 *     (the four chains: plan approval / AskUserQuestion / tool approval /
 *     subagent finish). Installing one of these shows a GREEN light and
 *     skips the install-time gates — the human pass already covered it.
 *   - `broken`: versions with a KNOWN incompatibility, with the reason. RED.
 *   - anything else: YELLOW (untested — user may force-install).
 *
 * Sources:
 *   1. BASELINE — the embedded constant below, shipped with the app. Mirrors
 *      `config/agent-runtime-compat.json` at the repo root (the smoke script
 *      asserts the two stay in sync — edit BOTH or run the script).
 *   2. REMOTE OVERRIDE — the same file fetched from GitHub raw at check time.
 *      This is the release channel: allowing a new upstream version = adding
 *      a line here + pushing to main. No app release needed. Fetched fresh on
 *      every check (the check is user-clicked; no caching complexity), size-
 *      capped and zod-validated — remote data is UNTRUSTED INPUT used only
 *      for the verdict, never executed.
 *
 * Pure node (no electron import) so the headless smoke bundle can exercise it.
 */
import { z } from "zod";

export interface CompatList {
  schema: number;
  claude: CompatAgent;
  codex: CompatAgent;
  pi: CompatAgent;
}

export interface CompatAgent {
  tested: string[];
  broken: Record<string, string>;
}

/** Mirrors config/agent-runtime-compat.json at the repo root. */
export const BASELINE_COMPAT_LIST: CompatList = {
  schema: 1,
  claude: { tested: ["0.3.258"], broken: {} },
  codex: { tested: ["0.153.4"], broken: {} },
  // pi 0.87.1 was marked broken on 2026-09-24 (`globSync` from node:fs needs
  // Node >= 22.14; the then-current Electron 33 main ran Node 20) and
  // un-marked the same day after the app moved to Electron 37 (Node 22.21),
  // where the SDK imports cleanly — verified by loading the real managed
  // 0.87.1 install under Electron's own runtime.
  pi: { tested: ["0.83.0"], broken: {} },
};

/** Where the remote override is fetched from — a fallback CHAIN, first
 *  reachable wins. raw.githubusercontent.com is unreliable from CN networks,
 *  so jsDelivr's GitHub CDN goes first (it serves the same file from the same
 *  repo, with CDN lag instead of GFW flakiness). `MCODE_COMPAT_LIST_URL`
 *  (single URL) replaces the whole chain — for tests / forks. */
export const COMPAT_LIST_URLS: readonly string[] =
  process.env["MCODE_COMPAT_LIST_URL"]
    ? [process.env["MCODE_COMPAT_LIST_URL"]]
    : [
        "https://cdn.jsdelivr.net/gh/huangbh2020/mcode@main/config/agent-runtime-compat.json",
        "https://raw.githubusercontent.com/huangbh2020/mcode/main/config/agent-runtime-compat.json",
      ];

const COMPAT_FETCH_TIMEOUT_MS = 10_000;
/** Remote data is untrusted input — a hostile/misconfigured URL must not be
 *  able to balloon memory. The real list is well under 1KB. */
const COMPAT_LIST_MAX_BYTES = 64 * 1024;

const CompatAgentSchema = z.object({
  tested: z.array(z.string().min(1)).max(200),
  broken: z.record(z.string().min(1), z.string().min(1)).default({}),
});

const CompatListSchema = z.object({
  schema: z.number().int().min(1),
  claude: CompatAgentSchema,
  codex: CompatAgentSchema,
  pi: CompatAgentSchema,
});

export type CompatListStaleReason = "fetch-failed" | "invalid" | null;

export interface LoadedCompatList {
  list: CompatList;
  /** Non-null when the remote override could not be fetched/validated and
   *  the (possibly stale) baseline was used — the verdict layer surfaces
   *  this so the UI can downgrade green lights. */
  staleReason: CompatListStaleReason;
}

/** Fetch + validate the remote override from the URL chain; null when every
 *  source fails (offline, file not pushed yet, oversized, schema drift). */
async function fetchRemoteCompatList(): Promise<CompatList | null> {
  for (const url of COMPAT_LIST_URLS) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(COMPAT_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.length > COMPAT_LIST_MAX_BYTES) continue;
      const parsed = CompatListSchema.parse(JSON.parse(text));
      // Reject unknown agents silently dropped by zod's strip — the file must
      // be fully understood, not partially.
      if (!("claude" in parsed && "codex" in parsed && "pi" in parsed)) continue;
      return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/** Load the effective compat list: remote override when healthy, else the
 *  embedded baseline flagged stale. Always resolves — the version comparison
 *  part of a check must not depend on the list being reachable. */
export async function loadCompatList(): Promise<LoadedCompatList> {
  const remote = await fetchRemoteCompatList();
  if (remote) return { list: remote, staleReason: null };
  return { list: BASELINE_COMPAT_LIST, staleReason: "fetch-failed" };
}

/** Verdict contribution of the compat list for one candidate version:
 *  "tested" | "unlisted" | "broken:<reason>". */
export function classifyVersion(
  list: CompatList,
  agent: keyof Omit<CompatList, "schema">,
  version: string,
): "tested" | "unlisted" | `broken:${string}` {
  const entry = list[agent];
  const reason = entry.broken[version];
  if (reason) return `broken:${reason}`;
  return entry.tested.includes(version) ? "tested" : "unlisted";
}
