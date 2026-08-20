/**
 * Shared filesystem path containment helpers used by IDE IPC handlers
 * (files / git / terminal / lsp). Every renderer-supplied path must resolve
 * inside a known project root before main touches the disk or spawns a process.
 *
 * On Windows + macOS (case-insensitive filesystems) path comparisons are
 * case-insensitive so a lowercased drive letter from Monaco/LSP (`d:\foo`)
 * still matches a project stored with an uppercase letter (`D:\foo`).
 */
import { resolve, sep } from "node:path";
import { platform } from "node:os";
import { ProjectRepo } from "@main/store/repositories.js";

/** True on case-insensitive filesystems (Windows, macOS). Linux is
 *  case-sensitive. Used to normalize path comparisons. */
const CASE_INSENSITIVE = platform() === "win32" || platform() === "darwin";

/** Normalize a path for comparison: resolve + optional lowercase. */
function norm(p: string): string {
  const r = resolve(p);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}

/** Compare two filesystem paths for equality after normalizing (resolving
 *  `.`, `..`, redundant separators, and trailing separators). On
 *  case-insensitive filesystems the comparison is case-insensitive. */
export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

/** True if `abs` is inside `root` (or equals it), after normalizing both.
 *  Uses `resolve` + a separator-aware prefix check so "/foo/bar" doesn't
 *  match root "/foo/ba". Case-insensitive on Windows/macOS. */
export function pathWithin(root: string, abs: string): boolean {
  const r = norm(root);
  const a = norm(abs);
  if (a === r) return true;
  return a.startsWith(r + sep);
}

/** Verify a path is inside SOME persisted project root. Returns the matching
 *  project root path, or null if the path is outside all roots (refuse). */
export function findContainingProject(absPath: string): string | null {
  const root = ProjectRepo.listPaths().find((p) => pathWithin(p, absPath));
  return root ?? null;
}

/** True if `projectPath` exactly matches a persisted Project.path (normalized,
 *  case-insensitive on Windows/macOS). */
export function isKnownProjectPath(projectPath: string): boolean {
  return ProjectRepo.listPaths().some((p) => samePath(p, projectPath));
}
