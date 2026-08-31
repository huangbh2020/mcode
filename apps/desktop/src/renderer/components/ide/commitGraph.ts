import type { GitCommitInfo } from "@contracts/ipc";

/**
 * Lane layout for the git history graph gutter (GitHistoryView).
 *
 * Pure function over a `git log --topo-order` result: assigns each commit a
 * horizontal lane and derives, per row, which rail segments to draw so the
 * list reads as a commit graph (merge commits fan out, branch rails fold back
 * in at their fork point). Rows are index-aligned with the input commits, so
 * the caller renders row[i] next to commits[i].
 *
 * The classic "active lanes" model: `lanes[i]` holds the hash whose rail
 * occupies lane i (null = free). A rail is created when some commit first
 * references a parent, spans every row in between as a through-line, and is
 * consumed when that parent's own row arrives. The first parent inherits the
 * commit's lane (straight rail down); extra parents open or join other lanes
 * (the merge fan-out). Because topo order guarantees children before parents,
 * every fork point is naturally handled: the second child of a commit finds
 * its parent already pending and folds into that lane.
 *
 * Recomputing the whole layout on append (rather than carrying state across
 * pages) keeps page boundaries trivially correct; the input is capped by
 * pagination so the O(n x lanes) pass stays sub-millisecond.
 */

/** One edge from a row's node down to a parent's lane. */
export interface GraphConnection {
  /** Lane the edge starts from — always the row's own node lane. */
  fromLane: number;
  /** Lane the edge ends on (where the parent's rail lives). */
  toLane: number;
}

/** Draw instructions for one list row. */
export interface CommitGraphRow {
  /** Lane index of this commit's node (the dot). */
  lane: number;
  /** The commit was referenced by an earlier row — draw the incoming rail
   *  from the row's top edge down to the dot. False for the first row and
   *  for commits that had to fall back to a free lane (ordering gap). */
  incoming: boolean;
  /** Edges from the dot down to each parent's lane. A `toLane === fromLane`
   *  edge is a straight rail; otherwise it curves into the target lane. */
  connections: GraphConnection[];
  /** Lane indices whose rails merely pass through this row (full-height
   *  verticals that don't involve the node itself). */
  through: number[];
  /** More than one parent — merge commit, drawn with a larger dot. */
  isMerge: boolean;
}

export interface CommitGraphLayout {
  /** Per-row draw instructions, index-aligned with the input commits. */
  rows: CommitGraphRow[];
  /** Highest lane index used + 1 — how many lanes the gutter must fit. */
  laneCount: number;
}

export function layoutCommitGraph(commits: GitCommitInfo[]): CommitGraphLayout {
  const lanes: Array<string | null> = [];
  const rows: CommitGraphRow[] = [];
  let laneCount = 1;

  for (const commit of commits) {
    // Occupancy snapshot before this row consumes its slot — needed to tell
    // through-rails (occupied before AND after) from rails that end here.
    const before = lanes.map((occupied) => occupied !== null);

    let lane = lanes.indexOf(commit.hash);
    const incoming = lane !== -1;
    if (!incoming) {
      // Not referenced by any earlier row (page boundary or ordering gap) —
      // fall back to the first free lane, opening a new one if none is free.
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lanes.push(commit.hash);
        lane = lanes.length - 1;
      }
    }
    lanes[lane] = null;

    const parents = commit.parents ?? [];
    const connections: GraphConnection[] = [];
    parents.forEach((parent, i) => {
      let toLane = lanes.indexOf(parent);
      if (toLane === -1) {
        if (i === 0) {
          // First parent inherits the commit's lane (trunk stays straight).
          toLane = lane;
        } else {
          // Extra parent: open the first free lane (may be the just-freed
          // own lane — that's a legitimate straight fan-out edge).
          toLane = lanes.indexOf(null);
          if (toLane === -1) {
            lanes.push(parent);
            toLane = lanes.length - 1;
          }
        }
        lanes[toLane] = parent;
      }
      // A parent that was already pending keeps its lane — the edge simply
      // folds into that existing rail (fork point) instead of duplicating it.
      connections.push({ fromLane: lane, toLane });
    });

    const through: number[] = [];
    for (let l = 0; l < lanes.length; l++) {
      if (l !== lane && before[l] && lanes[l] !== null) through.push(l);
    }

    laneCount = Math.max(
      laneCount,
      lane + 1,
      ...connections.map((c) => c.toLane + 1),
      ...through.map((l) => l + 1),
    );

    rows.push({ lane, incoming, connections, through, isMerge: parents.length > 1 });
  }

  return { rows, laneCount };
}
