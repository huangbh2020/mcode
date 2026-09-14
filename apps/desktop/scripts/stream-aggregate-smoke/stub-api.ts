/**
 * Stub for `@renderer/lib/api.js` — a Proxy-based `api` whose every
 * `api.<ns>.<method>(...)` call is recorded and, when a handler was
 * installed via {@link setApiHandler}, resolved by it; handler-less calls
 * resolve `undefined` (fire-and-forget persistence writes etc.).
 */
type ApiCall = { ns: string; method: string; args: unknown[] };

const calls: ApiCall[] = [];
const handlers = new Map<string, unknown>();

export function setApiHandler(ns: string, method: string, fn: (...args: never[]) => unknown): void {
  const bucket = (handlers.get(ns) ?? {}) as Record<string, unknown>;
  bucket[method] = fn;
  handlers.set(ns, bucket);
}

export function apiCalls(ns?: string, method?: string): ApiCall[] {
  return calls.filter((c) => (ns == null || c.ns === ns) && (method == null || c.method === method));
}

export function resetApiCalls(): void {
  calls.length = 0;
}

function nsProxy(ns: string): unknown {
  return new Proxy(
    {},
    {
      get: (_t, method: string) =>
        (...args: unknown[]) => {
          calls.push({ ns, method, args });
          const bucket = (handlers.get(ns) ?? {}) as Record<string, unknown>;
          const fn = bucket[method];
          return fn ? fn(...(args as never[])) : Promise.resolve(undefined);
        },
    },
  );
}

export const api: unknown = new Proxy(
  {},
  {
    get: (_t, ns: string) => nsProxy(ns),
  },
);
