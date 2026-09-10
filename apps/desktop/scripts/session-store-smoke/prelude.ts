/**
 * Browser globals the renderer session store touches while its module graph
 * evaluates. Imported FIRST by main.ts — ES module evaluation order guarantees
 * these land before `lib/api.ts` runs its `window.api ?? createWebApi()`.
 *
 * The smoke never exercises a turn, so the `api` stub only has to exist and
 * stay await-safe: any property access yields another stub function, and
 * `then` stays undefined so `await api.foo.bar()` never hangs as a thenable.
 */
const asyncNoop = (): Promise<undefined> => Promise.resolve(undefined);

function deepApiStub(): unknown {
  return new Proxy(asyncNoop, {
    get: (_target, prop) => {
      if (prop === "then") return undefined;
      if (prop === "constructor") return Object;
      return deepApiStub();
    },
    apply: () => Promise.resolve(undefined),
  });
}

const localStorageMap = new Map<string, string>();

const globalWindow = {
  api: deepApiStub(),
  mcodeElectron: true,
};

const globalTarget = globalThis as unknown as Record<string, unknown>;
// Node exposes `navigator` only from v21 on (and as a getter there), so define
// it defensively instead of assigning — ESM is strict mode, so writing to a
// getter-only global would throw.
if (typeof (globalThis as unknown as { navigator?: unknown }).navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "McodeSmoke", maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
}
globalTarget.window = globalWindow;
globalTarget.document = {
  documentElement: { setAttribute: () => {}, lang: "zh" },
  body: { appendChild: () => {}, removeChild: () => {} },
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
};
globalTarget.localStorage = {
  getItem: (k: string) => localStorageMap.get(k) ?? null,
  setItem: (k: string, v: string) => void localStorageMap.set(k, String(v)),
  removeItem: (k: string) => void localStorageMap.delete(k),
  clear: () => localStorageMap.clear(),
  key: (i: number) => [...localStorageMap.keys()][i] ?? null,
  get length() {
    return localStorageMap.size;
  },
};
globalTarget.requestAnimationFrame = (cb: (t: number) => void) =>
  setTimeout(() => cb(Date.now()), 16) as unknown as number;
globalTarget.cancelAnimationFrame = (handle: number) => clearTimeout(handle);

export {};
