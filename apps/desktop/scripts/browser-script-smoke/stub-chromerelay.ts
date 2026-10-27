/** chromeRelay stub for the browser-script smoke (esbuild alias target) —
 *  the script path never uses backend:"chrome", so the relay is inert here;
 *  aliasing it keeps the real chromeRelay→window→electron chain out of the
 *  bundle. */
export const chromeRelayStatus = () => ({
  enabled: false,
  listening: false,
  port: null,
  connected: false,
  chromeVersion: null,
});
export const chromeRelayCommand = async (): Promise<{ ok: false; error: string }> => ({
  ok: false,
  error: "stub: chrome relay not available in smoke",
});
