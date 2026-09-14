/**
 * Headless smoke for the STREAM SIDEBAR's aggregate cache (`streamSessions`,
 * the `session.listAll` pages the stream view renders) under destructive
 * mutations — delete / archive / pin / rename driven through the REAL
 * sessionStore actions.
 *
 * Regression anchor (2026-09-14): the store mutations only patched the
 * per-project caches; a session beyond its project's first page exists ONLY
 * in `streamSessions`, so deleting/archiving it from the stream view found
 * no cache to patch — `applySessionDeletedState` returned an EMPTY patch
 * (no removal, not even `streamDirty`) and the view kept rendering the dead
 * row until a left-bar view switch remounted the sidebar (the "ghost row"
 * bug). Second failure mode: a first-page fetch already in flight applies
 * its PRE-mutation snapshot wholesale, resurrecting rows deleted seconds
 * earlier when the user cleans up several sessions in quick succession.
 *
 * Pinned here, against the real actions:
 *   - deleting / archiving a stream-only row removes it from the aggregate
 *     immediately and marks streamDirty (totals shrink accordingly),
 *   - restoring a row re-inserts it at its updatedAt-sorted position,
 *   - pinning removes / unpinning re-inserts,
 *   - deleting a page-1 row strips its AGGREGATE duplicate too,
 *   - an in-flight first-page fetch whose snapshot predates a mid-flight
 *     delete is DISCARDED (generation guard) instead of resurrecting the
 *     deleted row, and streamDirty survives so a refetch still happens,
 *   - `loadStreamSessions` still applies a clean (unraced) fetch and clears
 *     the dirty flag.
 *
 * Run: scripts/stream-aggregate-smoke/run.sh
 */
import type { Session } from "@contracts/session";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { setApiHandler, apiCalls, resetApiCalls, type ApiCall } from "./stub-api.js";

let checks = 0;
let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failures++;
    process.stdout.write(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}\n`);
  }
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

function mkSession(id: string, projectId: string, updatedAt: number, extra: Partial<Session> = {}): Session {
  return {
    id,
    projectId,
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind: "chat",
    parentSessionId: null,
    title: `title ${id}`,
    status: "idle",
    model: "default",
    effort: "default",
    permissionMode: "default",
    customModelId: null,
    archived: false,
    pinnedAt: null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    usageHistory: null,
    turnFiles: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  };
}

const P1 = "proj-1";

/** Seed the store with: project P1 holding ONE first-page row (`p1a`) and a
 *  total of 3 local sessions, plus a stream aggregate of 4 rows where
 *  `s2`/`s3`/`s4` exist ONLY there (page-2+ rows — the ghost class). */
function seed(streamExtra: Session[] = []): Session[] {
  const p1a = mkSession("p1a", P1, 1000);
  const s2 = mkSession("s2", P1, 900);
  const s3 = mkSession("s3", P1, 800);
  const s4 = mkSession("s4", P1, 700);
  const stream = [p1a, s2, s3, s4, ...streamExtra]; // updatedAt DESC
  useSessionStore.setState({
    projects: [{ id: P1, name: "P1", path: "/p1", archived: false, group: null } as never],
    activeProjectId: P1,
    sessionsByProject: { [P1]: [p1a] },
    archivedSessionsByProject: {},
    pinnedSessions: [],
    sessionsTotalByProject: { [P1]: 3 },
    sessionsHasMoreByProject: { [P1]: true },
    streamSessions: stream,
    streamHasMore: false,
    streamTotal: stream.length,
    streamDirty: false,
    openTabs: [],
    activeSessionId: null,
  });
  resetApiCalls();
  return stream;
}

// Default handler for `session.archive` / `.pin` / `.rename`: echo the row
// the way the main process would (server-fresh copy derives from the input).
function echoSessionHandlers(): void {
  setApiHandler("session", "archive", (raw: { id: string; archived: boolean }) => {
    const st = useSessionStore.getState();
    const row =
      st.streamSessions.find((x) => x.id === raw.id) ??
      st.pinnedSessions.find((x) => x.id === raw.id) ??
      Object.values(st.archivedSessionsByProject).flatMap((l) => l).find((x) => x.id === raw.id) ??
      mkSession(raw.id, P1, 500);
    return { session: { ...row, archived: raw.archived, pinnedAt: raw.archived ? null : row.pinnedAt } };
  });
  setApiHandler("session", "pin", (raw: { id: string; pinned: boolean }) => {
    const st = useSessionStore.getState();
    const row =
      st.streamSessions.find((x) => x.id === raw.id) ?? st.pinnedSessions.find((x) => x.id === raw.id) ??
      mkSession(raw.id, P1, 500);
    return { session: { ...row, pinnedAt: raw.pinned ? Date.now() : null } };
  });
  setApiHandler("session", "rename", (raw: { id: string; title: string }) => {
    const st = useSessionStore.getState();
    const row =
      st.streamSessions.find((x) => x.id === raw.id) ?? st.pinnedSessions.find((x) => x.id === raw.id) ??
      mkSession(raw.id, P1, 500);
    return { session: { ...row, title: raw.title } };
  });
  setApiHandler("session", "delete", () => ({}));
}

async function main(): Promise<void> {
  echoSessionHandlers();

  /* ── A. Delete a stream-ONLY row (the regression: used to be a no-op patch) ── */
  section("A. delete of a stream-only (page-2+) row");
  seed();
  await useSessionStore.getState().deleteSession("s3");
  const a = useSessionStore.getState();
  check("row removed from streamSessions", !a.streamSessions.some((x) => x.id === "s3"));
  check("streamDirty set (drives the refetch)", a.streamDirty === true);
  check("project total shrank 3 → 2", (a.sessionsTotalByProject[P1] ?? -1) === 2);
  check("IPC reached main", apiCalls("session", "delete").length === 1);

  /* ── B. Archive a stream-only row ── */
  section("B. archive of a stream-only row");
  seed();
  await useSessionStore.getState().archiveSession("s3", true);
  const b = useSessionStore.getState();
  check("row removed from streamSessions", !b.streamSessions.some((x) => x.id === "s3"));
  check("row parked in the project's archived bin", (b.archivedSessionsByProject[P1] ?? []).some((x) => x.id === "s3"));
  check("streamDirty set", b.streamDirty === true);
  check("still absent after a hypothetical apply of same list", !b.streamSessions.some((x) => x.id === "s3"));

  /* ── C. Restore re-inserts at the updatedAt-sorted position ── */
  section("C. restore (un-archive) re-inserts sorted");
  await useSessionStore.getState().archiveSession("s3", false);
  const c = useSessionStore.getState();
  const idx = c.streamSessions.findIndex((x) => x.id === "s3");
  check("row back in streamSessions", idx !== -1);
  check("sorted position (after s2, before s4)", idx !== -1 && c.streamSessions[idx - 1]?.id === "s2" && c.streamSessions[idx + 1]?.id === "s4");
  check("left the archived bin", !(c.archivedSessionsByProject[P1] ?? []).some((x) => x.id === "s3"));

  /* ── D. Pin / unpin moves the aggregate row too ── */
  section("D. pin toggle");
  await useSessionStore.getState().setSessionPinned("s3", true);
  const d1 = useSessionStore.getState();
  check("pinned row left the aggregate (listAll excludes pinned)", !d1.streamSessions.some((x) => x.id === "s3"));
  check("pinned row in the global pinned bucket", d1.pinnedSessions.some((x) => x.id === "s3"));
  await useSessionStore.getState().setSessionPinned("s3", false);
  const d2 = useSessionStore.getState();
  const didx = d2.streamSessions.findIndex((x) => x.id === "s3");
  check("unpinned row back in the aggregate, sorted", didx !== -1 && d2.streamSessions[didx - 1]?.id === "s2");

  /* ── E. Deleting a page-1 row also strips its aggregate duplicate ── */
  section("E. delete of a page-1 row strips the aggregate twin");
  seed();
  await useSessionStore.getState().deleteSession("p1a");
  const e = useSessionStore.getState();
  check("gone from the per-project cache", !(e.sessionsByProject[P1] ?? []).some((x) => x.id === "p1a"));
  check("gone from the aggregate too", !e.streamSessions.some((x) => x.id === "p1a"));
  check("openTabs fallback intact (was not open)", e.openTabs.length === 0);

  /* ── F. In-flight fetch predating a delete is discarded, not applied ── */
  section("F. stale in-flight fetch is discarded (generation guard)");
  seed();
  // A mutation has just marked the aggregate dirty and the sidebar's effect
  // kicked off the refetch this test races against.
  useSessionStore.setState({ streamDirty: true });
  let resolveListAll: (v: unknown) => void = () => {};
  setApiHandler("session", "listAll", () => new Promise((res) => { resolveListAll = res; }));
  const fetchP = useSessionStore.getState().loadStreamSessions();
  check("fetch issued", apiCalls("session", "listAll").length === 1);
  // The user deletes a row WHILE the first-page fetch is in flight.
  await useSessionStore.getState().deleteSession("s3");
  // …the PRE-delete snapshot (captured before the delete) arrives late and
  // would resurrect the row.
  const staleSnapshot = useSessionStore.getState().streamSessions.filter((x) => x.id !== "s3");
  resolveListAll({
    sessions: [mkSession("s3", P1, 900), ...staleSnapshot],
    hasMore: false,
    total: 4,
  });
  await fetchP;
  const f = useSessionStore.getState();
  check("stale snapshot discarded — deleted row NOT resurrected", !f.streamSessions.some((x) => x.id === "s3"));
  check("streamDirty survives so a fresh refetch still happens", f.streamDirty === true);

  /* ── G. A clean (unraced) fetch still applies and clears the flag ── */
  section("G. clean fetch applies and clears streamDirty");
  seed();
  useSessionStore.setState({ streamDirty: true });
  setApiHandler("session", "listAll", () =>
    Promise.resolve({ sessions: [mkSession("fresh", P1, 2000)], hasMore: false, total: 1 }));
  await useSessionStore.getState().loadStreamSessions();
  const g = useSessionStore.getState();
  check("response applied", g.streamSessions.length === 1 && g.streamSessions[0]?.id === "fresh");
  check("streamDirty cleared", g.streamDirty === false);

  /* ── H. Deleting an unknown id is a no-op ── */
  section("H. delete of an unknown id");
  seed();
  const before = useSessionStore.getState().streamSessions;
  await useSessionStore.getState().deleteSession("nope");
  const h = useSessionStore.getState();
  check("aggregate untouched", h.streamSessions === before);
  check("no dirty flag on a no-op", h.streamDirty === false);

  process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
  if (failures > 0) process.exit(1);
}

void main();
