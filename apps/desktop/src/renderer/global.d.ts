import type { Api } from "../preload/index.js";

declare global {
  interface Window {
    api: Api;
    /** True when running inside the Mcode Electron shell (preload-injected).
     *  Absent in plain browsers (the phone over LAN). See lib/platform.ts. */
    mcodeElectron?: boolean;
  }
}

export {};
