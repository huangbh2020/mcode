/**
 * Headless smoke for the GitHub client (main/github/GitHubClient.ts):
 *
 *  1. parseGithubRemote — https / scp-style ssh / ssh:// URLs, .git suffix,
 *     credentials in URL, trailing slash; non-GitHub hosts and noise → null.
 *  2. parseClosingIssues — the Fixes/Closes/Resolves keyword family, "Closes:
 *     #N" colon form, dedupe, "#N without keyword" stays ignored, #0 dropped.
 *  3. REST call normalization + request shaping through a stubbed
 *     globalThis.fetch: PR/issue list filtering (each endpoint also returns
 *     the other kind), draft/merged state mapping, PR detail with linked-issue
 *     resolution and files, issue timeline cross-references, merge body
 *     shaping (method + delete_branch_after_merge), create responses, the
 *     404 error path, and the auth header derived from the stubbed settings
 *     token.
 *
 * No electron, no sqlite, no network — the token comes from the stubbed
 * settings repo (base64 "smoke-test-token").
 */
import {
  parseGithubRemote,
  parseClosingIssues,
  listPulls,
  listIssues,
  getPullDetail,
  getIssueDetail,
  mergePull,
  createPull,
  createIssue,
  GitHubError,
} from "@main/github/GitHubClient.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`);
  }
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ── 1. parseGithubRemote ── */
check("https with .git", eq(parseGithubRemote("https://github.com/foo/bar.git"), { owner: "foo", repo: "bar" }));
check("https without .git", eq(parseGithubRemote("https://github.com/foo/bar"), { owner: "foo", repo: "bar" }));
check("https with credentials", eq(parseGithubRemote("https://x-access-token:ghp_x@github.com/foo/bar.git"), { owner: "foo", repo: "bar" }));
check("https trailing slash", eq(parseGithubRemote("https://github.com/foo/bar/"), { owner: "foo", repo: "bar" }));
check("scp-style ssh", eq(parseGithubRemote("git@github.com:foo/bar.git"), { owner: "foo", repo: "bar" }));
check("scp-style ssh no .git", eq(parseGithubRemote("git@github.com:foo/bar"), { owner: "foo", repo: "bar" }));
check("ssh:// URL", eq(parseGithubRemote("ssh://git@github.com/foo/bar.git"), { owner: "foo", repo: "bar" }));
check("gitlab → null", parseGithubRemote("https://gitlab.com/foo/bar.git") === null);
check("ssh gitlab → null", parseGithubRemote("git@gitlab.com:foo/bar.git") === null);
check("garbage → null", parseGithubRemote("not a remote") === null);
check("empty → null", parseGithubRemote("") === null);
check("dotted owner ok", eq(parseGithubRemote("https://github.com/my.org/my.repo.git"), { owner: "my.org", repo: "my.repo" }));

/* ── 2. parseClosingIssues ── */
check("fixes #N", eq(parseClosingIssues("this fixes #12"), [12]));
check("keyword family + colon", eq(parseClosingIssues("Closes: #34"), [34]));
check("multiple keywords", eq(parseClosingIssues("fixes #1, closes #2, resolves #3"), [1, 2, 3]));
check("dedupe", eq(parseClosingIssues("fixes #1 and fixes #1 again"), [1]));
check("no keyword → none", eq(parseClosingIssues("see #99 and issue #100"), []));
check("#0 dropped", eq(parseClosingIssues("fixes #0"), []));
check("case insensitive", eq(parseClosingIssues("FIXES #7"), [7]));

/* ── 3. REST normalization via stubbed fetch ── */

interface CapturedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  auth: string;
  apiVersion: string;
}

const calls: CapturedCall[] = [];

type Route = (url: string) => { status: number; json: unknown } | null;
let route: Route = () => null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  let body: Record<string, unknown> | null = null;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  const headers = new Headers(init?.headers);
  const matched = route(url);
  calls.push({
    url,
    method,
    body,
    auth: headers.get("Authorization") ?? "",
    apiVersion: headers.get("X-GitHub-Api-Version") ?? "",
  });
  return new Response(
    JSON.stringify(matched ? matched.json : { message: "unexpected route" }),
    { status: matched ? matched.status : 500 },
  );
}) as typeof fetch;

async function main(): Promise<void> {
  /* ── listPulls: mapping + auth ── */
  route = (url) => {
    if (url === "https://api.github.com/repos/foo/bar/pulls?per_page=100&page=1") {
      return {
        status: 200,
        json: [
          { number: 1, title: "plain open", state: "open", user: { login: "a", avatar_url: "u1" }, head: { ref: "feat", sha: "s1" }, base: { ref: "main" }, labels: [{ name: "bug", color: "ff0000" }], created_at: "t0", updated_at: "t1", comments: 2, mergeable: true, mergeable_state: "clean" },
          { number: 2, title: "draft", state: "open", draft: true, user: { login: "b", avatar_url: "" }, head: { ref: "d", sha: "s2" }, base: { ref: "main" }, created_at: "t0", updated_at: "t1", comments: 0, mergeable: null, mergeable_state: "unknown" },
          { number: 3, title: "merged", state: "closed", merged_at: "2026-01-01T00:00:00Z", user: { login: "c", avatar_url: "" }, head: { ref: "m", sha: "s3" }, base: { ref: "main" }, created_at: "t0", updated_at: "t1", comments: 0, mergeable: null, mergeable_state: "clean" },
        ],
      };
    }
    return null;
  };
  const pulls = await listPulls("foo", "bar");
  const firstCall = calls[calls.length - 1];
  check("listPulls: count", pulls.length === 3);
  check("listPulls: bearer token from settings", firstCall?.auth === "Bearer smoke-test-token");
  check("listPulls: api version pinned", firstCall?.apiVersion === "2022-11-28");
  check("listPulls: open mapping", pulls[0]?.state === "open" && pulls[0]?.mergeable === true && pulls[0]?.labels[0]?.name === "bug");
  check("listPulls: draft mapping", pulls[1]?.state === "draft");
  check("listPulls: merged mapping", pulls[2]?.state === "merged");
  check("listPulls: branch refs", pulls[0]?.headRef === "feat" && pulls[0]?.baseRef === "main");

  /* ── listIssues: PR entries filtered out ── */
  route = (url) => {
    if (url.startsWith("https://api.github.com/repos/foo/bar/issues?state=open")) {
      return {
        status: 200,
        json: [
          { number: 10, title: "real issue", state: "open", user: { login: "a", avatar_url: "" }, created_at: "t0", updated_at: "t1", comments: 1, labels: [] },
          { number: 11, title: "sneaky PR", state: "open", user: { login: "a", avatar_url: "" }, created_at: "t0", updated_at: "t1", comments: 0, labels: [], pull_request: { url: "x" } },
        ],
      };
    }
    return null;
  };
  const issues = await listIssues("foo", "bar", "open");
  check("listIssues: PR filtered", issues.length === 1 && issues[0]?.number === 10);

  /* ── getPullDetail: body/comments/files + linked issue resolution ── */
  route = (url) => {
    if (url.endsWith("/repos/foo/bar/pulls/5")) {
      return {
        status: 200,
        json: { number: 5, title: "fix thing", body: "Fixes #77", state: "open", user: { login: "a", avatar_url: "" }, head: { ref: "f", sha: "sha5" }, base: { ref: "main" }, created_at: "t0", mergeable: true, mergeable_state: "clean", html_url: "https://github.com/foo/bar/pull/5" },
      };
    }
    if (url.endsWith("/repos/foo/bar/issues/5/comments")) {
      return { status: 200, json: [{ id: 9, user: { login: "rev", avatar_url: "" }, body: "closes #88", created_at: "t2" }] };
    }
    if (url.endsWith("/repos/foo/bar/pulls/5/files")) {
      return { status: 200, json: [{ filename: "a.ts", additions: 3, deletions: 1, status: "modified" }] };
    }
    if (url.endsWith("/repos/foo/bar/issues/77")) {
      return { status: 200, json: { number: 77, title: "the linked one", state: "closed" } };
    }
    if (url.endsWith("/repos/foo/bar/issues/88")) {
      return { status: 404, json: { message: "Not Found" } };
    }
    return null;
  };
  const detail = await getPullDetail("foo", "bar", 5);
  check("getPull: fields", detail.number === 5 && detail.headSha === "sha5" && detail.baseRef === "main" && detail.htmlUrl.endsWith("/pull/5"));
  check("getPull: comments mapped", detail.comments.length === 1 && detail.comments[0]?.author.login === "rev");
  check("getPull: files mapped", detail.files[0]?.filename === "a.ts" && detail.files[0]?.additions === 3);
  check("getPull: linked issues from body+comments", eq(detail.linkedIssues.map((i) => i.number), [77, 88]));
  check("getPull: linked title resolved", detail.linkedIssues[0]?.title === "the linked one" && detail.linkedIssues[0]?.state === "closed");
  check("getPull: failed lookup degrades", detail.linkedIssues[1]?.title === "" && detail.linkedIssues[1]?.number === 88);

  /* ── getIssueDetail: timeline cross-references ── */
  route = (url) => {
    if (url.endsWith("/repos/foo/bar/issues/10")) {
      return { status: 200, json: { number: 10, title: "bug", body: "boom", state: "open", user: { login: "a", avatar_url: "" }, created_at: "t0", labels: [] } };
    }
    if (url.endsWith("/repos/foo/bar/issues/10/comments")) {
      return { status: 200, json: [] };
    }
    if (url.endsWith("/repos/foo/bar/issues/10/timeline")) {
      return {
        status: 200,
        json: [
          { event: "cross-referenced", source: { issue: { number: 5, title: "fix thing", state: "open", user: { login: "a" }, pull_request: {} } } },
          { event: "cross-referenced", source: { issue: { number: 5, title: "dup", state: "open", user: { login: "a" }, pull_request: {} } } },
          { event: "cross-referenced", source: { issue: { number: 12, title: "an issue (not PR)", state: "open", user: { login: "a" } } } },
          { event: "commented", body: "noise" },
        ],
      };
    }
    return null;
  };
  const issue = await getIssueDetail("foo", "bar", 10);
  check("getIssue: PR cross-refs only, deduped", eq(issue.linkedPulls.map((p) => p.number), [5]));
  check("getIssue: fields", issue.number === 10 && issue.title === "bug" && issue.state === "open");

  /* ── mergePull: request shaping ── */
  route = (url) => {
    if (url.endsWith("/repos/foo/bar/pulls/5/merge")) {
      return { status: 200, json: { merged: true } };
    }
    return null;
  };
  const merged = await mergePull({ owner: "foo", repo: "bar", number: 5, method: "squash", deleteBranch: true, commitTitle: null, commitMessage: null });
  const mergeCall = calls[calls.length - 1];
  check("merge: result", merged.merged === true);
  check("merge: PUT to merge endpoint", mergeCall?.method === "PUT" && mergeCall.url.endsWith("/pulls/5/merge"));
  check("merge: body shaping", mergeCall?.body?.merge_method === "squash" && mergeCall?.body?.delete_branch_after_merge === true);

  /* ── merge rejection throws (the IPC handler catches → { ok:false }) ── */
  route = () => ({ status: 405, json: { message: "Pull Request is not mergeable" } });
  try {
    await mergePull({ owner: "foo", repo: "bar", number: 5, method: "merge", deleteBranch: false, commitTitle: null, commitMessage: null });
    check("merge: 405 throws GitHubError", false);
  } catch (err) {
    check("merge: 405 throws GitHubError", err instanceof GitHubError && err.status === 405 && err.message.includes("not mergeable"));
  }

  /* ── createPull / createIssue ── */
  route = (url) => {
    if (url.endsWith("/repos/foo/bar/pulls")) {
      return { status: 201, json: { number: 9, html_url: "https://github.com/foo/bar/pull/9" } };
    }
    if (url.endsWith("/repos/foo/bar/issues")) {
      return { status: 201, json: { number: 20 } };
    }
    return null;
  };
  const pr = await createPull({ owner: "foo", repo: "bar", title: "t", head: "h", base: "b", body: "Fixes #1", draft: false });
  check("createPull: number + url", pr.number === 9 && pr.htmlUrl?.endsWith("/pull/9") === true);
  const issueCreated = await createIssue("foo", "bar", "t", "b");
  check("createIssue: number", issueCreated === 20);

  /* ── error normalization ── */
  route = () => ({ status: 404, json: { message: "Not Found" } });
  try {
    await listPulls("foo", "missing");
    check("404 throws GitHubError", false);
  } catch (err) {
    check("404 throws GitHubError", err instanceof GitHubError && err.status === 404 && err.message.includes("Not Found"));
  }

  console.log(`github smoke: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await main();
