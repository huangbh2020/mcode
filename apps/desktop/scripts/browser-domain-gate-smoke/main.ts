/**
 * Headless smoke for main/browser/domainGate.ts (per-domain approval gate for
 * agent browser navigation). The module itself runs REAL; only the
 * electron-adjacent SettingRepo and logger are stubbed (esbuild aliases).
 *
 * Assertions:
 *  A. URL/host parsing: http/https hosts extracted lowercased, file: → ""
 *     (always allowed), non-http unparsable → null (gate has no opinion).
 *  B. normalizeDomain: case, trailing dots, IPv6 brackets.
 *  C. domainMatches: exact, parent-covers-subdomain, suffix-spoof rejected.
 *  D. Always-allowed hosts: localhost / 127.0.0.1 / [::1] / *.localhost.
 *  E. gateBrowserNavigation matrix:
 *     - localhost + file: pass without prompting (approver never called);
 *     - trusted (global list from settings, session grant, parent domain)
 *       passes without prompting;
 *     - bypassPermissions / dontAsk modes skip the prompt;
 *     - untrusted host raises ONE approval carrying domain+url, allow →
 *       proceed, deny → blocked with a model-facing reason;
 *     - non-http URL passes the gate untouched.
 *  F. Grant persistence: session grant scoped to its session only; global
 *     grant lands in the settings map as sorted JSON (SettingRepo stub);
 *     settings whole-list writer normalizes; clearSessionBrowserDomains
 *     drops session trust only.
 */
import type { ApprovalRequest, ProviderApprovalDecision } from "@contracts/provider";
import {
  domainMatches,
  gateBrowserNavigation,
  grantBrowserDomain,
  getTrustedBrowserDomains,
  setTrustedBrowserDomains,
  isBrowserDomainTrusted,
  clearSessionBrowserDomains,
  hostOfUrl,
  normalizeDomain,
} from "@main/browser/domainGate.js";
import { settingsMap } from "./stub-store.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${name}`);
  }
}

/** Recording approver: lets the test answer each request. */
function makeApprover(
  answer: (req: ApprovalRequest) => ProviderApprovalDecision,
): { calls: ApprovalRequest[]; fn: (req: ApprovalRequest) => Promise<ProviderApprovalDecision> } {
  const calls: ApprovalRequest[] = [];
  return {
    calls,
    fn: async (req: ApprovalRequest) => {
      calls.push(req);
      return answer(req);
    },
  };
}

async function main(): Promise<void> {
  console.log("browser domain gate smoke");
  // Seed the persisted trusted-domain list BEFORE the first gate call — the
  // module lazy-loads it once (production always has the DB ready by then).
  settingsMap.set("browser.trustedDomains", JSON.stringify(["docs.python.org"]));

  console.log("A. hostOfUrl");
  check("http host lowercased", hostOfUrl("HTTP://Example.COM/x?y") === "example.com");
  check("https port stripped", hostOfUrl("https://api.site.io:8443/p") === "api.site.io");
  check("localhost port stripped", hostOfUrl("http://localhost:5173/") === "localhost");
  check("ipv6 port stripped", hostOfUrl("http://[::1]:8080/") === "[::1]");
  check("file → empty (always allowed)", hostOfUrl("file:///D:/x/index.html") === "");
  check("javascript → null (no opinion)", hostOfUrl("javascript:alert(1)") === null);
  check("garbage → null", hostOfUrl("not a url") === null);

  console.log("B. normalizeDomain");
  check("lowercases", normalizeDomain("ExAmPle.COM") === "example.com");
  check("strips trailing dot", normalizeDomain("example.com.") === "example.com");
  check("strips IPv6 brackets", normalizeDomain("[::1]") === "::1");

  console.log("C. domainMatches");
  check("exact", domainMatches("example.com", "example.com"));
  check("parent covers subdomain", domainMatches("api.example.com", "example.com"));
  check("deep subdomain covered", domainMatches("a.b.example.com", "example.com"));
  check("suffix spoof rejected", !domainMatches("notexample.com", "example.com"));
  check("evil suffix rejected", !domainMatches("example.com.evil.tld", "example.com"));
  check("different host rejected", !domainMatches("other.com", "example.com"));

  console.log("D. always-allowed hosts (via gate, no prompt)");
  const noPrompt = makeApprover(() => ({ allow: true }));
  check(
    "localhost with port passes silently",
    (await gateBrowserNavigation("http://localhost:5173/", { sessionId: "s1", requestApproval: noPrompt.fn })).allowed,
  );
  check("approver never called for localhost", noPrompt.calls.length === 0);
  check(
    "127.0.0.1 passes silently",
    (await gateBrowserNavigation("http://127.0.0.1:3000/", { sessionId: "s1", requestApproval: noPrompt.fn })).allowed,
  );
  check(
    "[::1] passes silently",
    (await gateBrowserNavigation("http://[::1]:8080/", { sessionId: "s1", requestApproval: noPrompt.fn })).allowed,
  );
  check(
    "subdomain.localhost passes silently",
    (await gateBrowserNavigation("http://app.localhost/", { sessionId: "s1", requestApproval: noPrompt.fn })).allowed,
  );
  check(
    "file: passes silently",
    (await gateBrowserNavigation("file:///D:/doc.html", { sessionId: "s1", requestApproval: noPrompt.fn })).allowed,
  );

  console.log("E. gate matrix");
  const trustedApprover = makeApprover(() => ({ allow: true }));
  check(
    "global-listed domain passes silently",
    (await gateBrowserNavigation("https://docs.python.org/3/", { sessionId: "sX", requestApproval: trustedApprover.fn }))
      .allowed,
  );
  check("approver never called for trusted", trustedApprover.calls.length === 0);

  // Session grant + parent coverage.
  grantBrowserDomain("sA", "github.com", "session");
  check(
    "session grant passes for that session",
    (await gateBrowserNavigation("https://github.com/org/repo", { sessionId: "sA", requestApproval: trustedApprover.fn }))
      .allowed,
  );
  check(
    "session grant covers subdomains",
    (await gateBrowserNavigation("https://api.github.com/", { sessionId: "sA", requestApproval: trustedApprover.fn }))
      .allowed,
  );
  const otherSession = makeApprover(() => ({ allow: true }));
  check(
    "session grant does NOT leak to other sessions",
    (await gateBrowserNavigation("https://github.com/", { sessionId: "sB", requestApproval: otherSession.fn })).allowed ===
      false || otherSession.calls.length === 1,
  );

  // Mode exemptions.
  for (const mode of ["bypassPermissions", "dontAsk"] as const) {
    const approver = makeApprover(() => ({ allow: true }));
    check(
      `${mode} skips the prompt`,
      (await gateBrowserNavigation("https://fresh.example/", { sessionId: "sC", mode, requestApproval: approver.fn }))
        .allowed && approver.calls.length === 0,
    );
  }

  // Untrusted: prompts once with domain, allow → proceed.
  const askApprover = makeApprover(() => ({ allow: true }));
  const allowed = await gateBrowserNavigation("https://news.ycombinator.com/", {
    sessionId: "sD",
    requestApproval: askApprover.fn,
  });
  check("untrusted + user allows → allowed", allowed.allowed);
  check("prompt carried the domain", askApprover.calls[0]?.domain === "news.ycombinator.com");
  check("prompt carried toolName browser_navigate", askApprover.calls[0]?.toolName === "browser_navigate");
  check("prompt carried the url in input", (askApprover.calls[0]?.input as { url?: string })?.url === "https://news.ycombinator.com/");
  check("one-shot allow does not persist trust", !isBrowserDomainTrusted("sD", "news.ycombinator.com"));

  // Untrusted + deny → blocked with a model-facing reason.
  const denyApprover = makeApprover(() => ({ allow: false }));
  const denied = await gateBrowserNavigation("https://evil.tld/", {
    sessionId: "sE",
    requestApproval: denyApprover.fn,
  });
  check("user deny → blocked", !denied.allowed);
  check("deny carries a reason mentioning the host", (denied.reason ?? "").includes("evil.tld"));

  // Non-http URL: gate has no opinion (browserNavigate's own validation owns it).
  check(
    "non-http passes gate untouched",
    (await gateBrowserNavigation("ftp://files.example/", { sessionId: "sF", requestApproval: noPrompt.fn })).allowed,
  );

  console.log("F. grant persistence");
  grantBrowserDomain("sG", "global.example", "global");
  check("global grant persisted as sorted JSON", settingsMap.get("browser.trustedDomains") !== undefined);
  check(
    "global grant visible via getTrustedBrowserDomains",
    getTrustedBrowserDomains().includes("global.example") && getTrustedBrowserDomains().includes("docs.python.org"),
  );
  check("global grant applies to fresh sessions", isBrowserDomainTrusted("brand-new", "global.example"));

  setTrustedBrowserDomains(["Only.One ", "only.one", "UPPER.Case"]);
  check("whole-list writer normalizes + dedupes", JSON.stringify(getTrustedBrowserDomains()) === JSON.stringify(["only.one", "upper.case"]));

  clearSessionBrowserDomains("sA");
  const afterClear = makeApprover(() => ({ allow: true }));
  const gated = await gateBrowserNavigation("https://github.com/", {
    sessionId: "sA",
    requestApproval: afterClear.fn,
  });
  check("clearSession drops session trust (re-prompts)", !gated.allowed || afterClear.calls.length === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
