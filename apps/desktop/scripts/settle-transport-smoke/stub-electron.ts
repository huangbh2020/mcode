// electron stub — only `app.getPath` is reachable in this bundle; the miss
// makes resolveRg() fall through to `which rg` on PATH (no rg use expected
// here, but the import chain must load).
export const app = {
  getPath: (_name: string): string => "/tmp/mcode-settle-smoke",
};
