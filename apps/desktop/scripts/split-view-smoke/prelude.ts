/**
 * Browser globals the renderer session store touches while its module graph
 * evaluates. Imported FIRST by main.ts — ES module evaluation order
 * guarantees these land before `lib/api.ts` runs its `window.api ??
 * createWebApi()`.
 *
 * Same skeleton as scripts/session-store-smoke/prelude.ts, extended with a
 * CAPTURING `claude.sendTurn` stub — the split-view smoke asserts the
 * per-turn slot binding (model / effort / permissionMode / providerId)
 * shipped for active vs non-active send targets.
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

/** Real settings backend over a Map — split membership persists through
 *  `ui.splitSessions` and the smoke asserts the written blob. */
export const smokeSettings = new Map<string, string>();
const settingApi = {
  get: async ({ key }: { key: string }) => ({ value: smokeSettings.get(key) ?? null }),
  getMany: async ({ keys }: { keys: string[] }) => {
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = smokeSettings.get(k) ?? null;
    return out;
  },
  set: async ({ key, value }: { key: string; value: string }) => {
    smokeSettings.set(key, String(value));
  },
};

/** Every sendTurn call's argument object, in order. */
export const sendTurnCalls: Array<Record<string, unknown>> = [];
const claudeApi = {
  sendTurn: async (args: Record<string, unknown>) => {
    sendTurnCalls.push(args);
    return { session: { id: args.sessionId } };
  },
};

const globalWindow = {
  api: new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "then") return undefined;
        if (prop === "setting") return settingApi;
        if (prop === "claude") return claudeApi;
        if (prop === "constructor") return Object;
        return deepApiStub();
      },
    },
  ),
  mcodeElectron: true,
};

const globalTarget = globalThis as unknown as Record<string, unknown>;
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
