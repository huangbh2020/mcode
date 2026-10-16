/**
 * Bash-window video inventory diff — the detection half of inline chat
 * video (the render half is the renderer's `video` block + the guarded
 * `app-resource://` streaming protocol).
 *
 * Render/tutorial scripts produce video files as a SIDE EFFECT of a Bash
 * command: nothing in the tool stream references them, so the transcript
 * would never show what was produced. Mirroring the service scanner's
 * attribution windows, the adapter snapshots the cwd's video-file set at
 * the Bash tool_use edge and diffs it at the completion edge; files that
 * appeared become `tool.media` events.
 *
 * Listing goes through `rg --files` (C-speed walk). rg is invoked with
 * --no-ignore (matching the file-search semantics), so the heavy dirs MUST
 * be excluded explicitly — MEDIA_DIFF_IGNORED is the price of correctness
 * here; without it a node_modules-heavy repo would walk twice per Bash
 * call. Returns null when rg is unavailable: the adapter treats that as
 * "feature off" rather than falling back to a slow JS walk.
 */
import { VIDEO_FILE_EXTENSIONS } from "@contracts/runtime";
import { stat } from "node:fs/promises";
import { rgListFiles } from "@main/lib/rgSearch.js";

/** Directory names excluded from the inventory walk. Intentionally much
 *  smaller than the file-tree's IGNORED_ENTRIES: the diff only cares about
 *  video files, which live in output/asset dirs the tree hides (dist,
 *  build, out) — so those stay INCLUDED; only dependency/VCS/cache dirs
 *  that can hold gigabytes of non-media files are cut. */
const MEDIA_DIFF_IGNORED = [
  "node_modules",
  ".git",
  ".pnpm-store",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
  ".next",
  ".nuxt",
  "target",
];

/** Identity of one video file for the window diff. Renders overwrite STABLE
 *  output paths (every run rewrites C1.mp4), so path-presence alone only
 *  fires on a filename's very first creation — (mtime, size) makes an
 *  overwritten render count as "produced" too. */
export interface MediaFileStamp {
  mtimeMs: number;
  size: number;
}

function isVideoPath(absPath: string): boolean {
  const lower = absPath.toLowerCase();
  return VIDEO_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Snapshot the video files under `cwd` (absolute path → stamp). Never
 *  rejects. `rg --files` exits 1 for "no files found" (e.g. a fresh project
 *  with only empty dirs) — rgListFiles conflates that with real failures and
 *  resolves null; mapping null to an EMPTY map is the correct baseline
 *  semantics here ("nothing existed before"), and when rg is genuinely
 *  unavailable both sides of the diff come back empty, which degenerates to
 *  "no new files" (feature quietly off) instead of a bogus everything-is-new
 *  event. The rg listing is C-speed; the per-file stat only touches video
 *  files (dozens at most). */
export async function snapshotVideoFiles(cwd: string): Promise<Map<string, MediaFileStamp>> {
  const files = await rgListFiles(cwd, MEDIA_DIFF_IGNORED);
  const out = new Map<string, MediaFileStamp>();
  if (!files) return out;
  for (const f of files) {
    if (!isVideoPath(f.abs)) continue;
    try {
      const s = await stat(f.abs);
      out.set(f.abs, { mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      // Listed a moment ago but gone now (temp render file) — treat as
      // never-existed; the after-snapshot decides.
    }
  }
  return out;
}
