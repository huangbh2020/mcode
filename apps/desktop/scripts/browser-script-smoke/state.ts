/** Shared fake-BrowserManager state for the browser-script smoke. The
 *  alias-target stub files (stub-manager.ts etc.) all import from here so the
 *  test main.ts sees ONE recorder. The REAL agentBrowserTools + domainGate
 *  run against it. */
export const calls: Array<[string, unknown]> = [];
export const scripted: Record<string, unknown> = {};
export const resetStubs = (): void => {
  calls.length = 0;
  for (const k of Object.keys(scripted)) delete scripted[k];
};
export function record<T>(method: string, arg: unknown, fallback: T): T {
  calls.push([method, arg]);
  const res = scripted[method];
  if (res instanceof Error) throw res;
  return (res === undefined ? fallback : res) as T;
}
export const LIVE = [{ browserId: "b1", projectPath: "/proj", url: "http://localhost:5173/", title: "App" }];
