/* Smoke stub for @main/lib/binaryResolve.js — `which` is steerable from the
 * test body via globalThis.__SMOKE_WHICH__ (unset = not found). */
export function which(name: string): string | null {
  const g = globalThis as { __SMOKE_WHICH__?: (n: string) => string | null };
  return g.__SMOKE_WHICH__ ? g.__SMOKE_WHICH__(name) : null;
}

export function whichAny(names: string[]): string | null {
  return which(names[0]);
}
