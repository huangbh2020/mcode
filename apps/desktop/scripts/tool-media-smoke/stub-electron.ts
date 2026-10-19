// electron stub for the tool-media smoke — only `app.getPath` is reachable
// in this bundle (rgSearch's bundled-rg probe); the miss makes resolveRg()
// fall through to `which rg` on PATH.
export const app = {
  getPath: (_name: string): string => "/tmp/mcode-tool-media-smoke",
};
