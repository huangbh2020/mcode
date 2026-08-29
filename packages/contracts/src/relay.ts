/**
 * Relay contracts — types + zod schemas for the SSH-based remote access relay.
 *
 * The relay lets the mobile companion app reach the desktop from outside the
 * LAN without any third-party tunnel service (Cloudflare/ngrok etc., which are
 * frequently blocked in mainland China). The desktop maintains an SSH
 * connection to a user-provided VPS and uses SSH reverse port forwarding
 * (`forwardIn`) to expose its local mobile HTTP server through the VPS.
 *
 * Architecture:
 *   phone → VPS:publicPort → forwarder(socat/python3) → VPS:sshPort
 *          → SSH reverse tunnel → desktop:7331 (MobileHttpServer)
 *
 * The forwarder on the VPS is a trivial TCP port-forwarder (`socat` one-liner
 * or a 25-line python3 script) that bridges the public port to the SSH
 * reverse-tunnel's localhost binding. No `GatewayPorts` sshd config needed.
 */
import { z } from "zod";

/** Setting key under which the VPS connection config is persisted (JSON). */
export const RELAY_CONFIG_SETTING_KEY = "relay.vpsConfig";

/** Setting key for "start remote access automatically on app launch" ("1"/"0"). */
export const RELAY_AUTO_START_SETTING_KEY = "relay.autoStart";

/** Default public port on the VPS that the phone connects to. */
export const RELAY_DEFAULT_PUBLIC_PORT = 7331;

/** Which program to deploy on the VPS as the public-port forwarder.
 *  - "auto": try socat first, fall back to the python3 script (default)
 *  - "socat" / "python3": force the choice; deploy fails with an explicit
 *    error when the binary is missing on the VPS (no silent fallback). */
export type RelayForwarderChoice = "auto" | "socat" | "python3";

/** Lifecycle state of the relay connection, surfaced to the renderer. */
export type RelayState =
  | "idle" // never connected / disconnected
  | "connecting" // SSH connecting
  | "deploying" // uploading/starting forwarder on VPS
  | "connected" // SSH tunnel active, phone can reach desktop
  | "error"; // connection failed or dropped

/** VPS connection configuration (persisted in settings). Passwords are stored
 *  in plaintext, same threat model as device tokens — the settings DB lives in
 *  the user's own userData dir. */
export interface RelayVpsConfig {
  /** VPS hostname or IP address (e.g. `1.2.3.4` or `vps.example.com`). */
  host: string;
  /** SSH port (default 22). */
  sshPort: number;
  /** SSH username (e.g. `root`, `ubuntu`). */
  username: string;
  /** SSH password (empty when using key auth). */
  password: string;
  /** Optional path to a private key file on the local machine. */
  privateKeyPath?: string;
  /** Public port on the VPS that the phone connects to. Default 7331. */
  publicPort: number;
  /** Forwarder program to deploy on the VPS. Absent (older saved configs)
   *  behaves as "auto". */
  forwarder?: RelayForwarderChoice;
}

/** A snapshot of the relay's current status, returned by `relay.status`. */
export interface RelayStatus {
  state: RelayState;
  /** The public HTTP endpoint the phone should open (only when `connected`).
   *  E.g. `http://1.2.3.4:7331`. Null otherwise. */
  endpoint: string | null;
  /** The VPS host (for UI display). */
  vpsHost: string | null;
  /** The public port on the VPS. */
  publicPort: number;
  /** Human-readable error message (only when `state === "error"`). */
  error: string | null;
  /** How the forwarder was deployed (for UI display). */
  forwarderType: "socat" | "python3" | null;
}

/** ── zod schemas (for IPC input validation) ── */

export const RelayVpsConfigSchema = z.object({
  host: z.string().min(1).max(256),
  sshPort: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(128),
  password: z.string().max(256).default(""),
  privateKeyPath: z.string().max(512).optional(),
  publicPort: z.number().int().min(1).max(65535).default(RELAY_DEFAULT_PUBLIC_PORT),
  forwarder: z.enum(["auto", "socat", "python3"]).default("auto"),
});

export type RelayVpsConfigInput = z.infer<typeof RelayVpsConfigSchema>;
