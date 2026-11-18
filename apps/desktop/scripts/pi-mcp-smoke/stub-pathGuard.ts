/**
 * Electron-free stand-in for @main/lib/pathGuard.js — the real module imports
 * `app` from "electron" at top level, which cannot survive esbuild's esm
 * bundle (electron's CJS entry does a dynamic require("fs")). Only the pure
 * comparison helpers are replicated here, verbatim from the source.
 */
import { resolve, sep } from "node:path";
import { platform } from "node:os";

const CASE_INSENSITIVE = platform() === "win32" || platform() === "darwin";

function norm(p: string): string {
  const r = resolve(p);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}

export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

export function pathWithin(root: string, abs: string): boolean {
  const r = norm(root);
  const a = norm(abs);
  if (a === r) return true;
  return a.startsWith(r + sep);
}
