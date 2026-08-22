/**
 * PairingManager — owns the LAN pairing handshake and the paired-device list.
 *
 * Flow:
 *  1. PC calls {@link startPairing} (via IPC) → generates a one-time nonce +
 *     6-digit code + QR URL. The nonce lives in memory for {@link PAIRING_TTL_MS}.
 *  2. Mobile scans the QR, opens the URL, the user types the code shown on PC.
 *  3. Mobile POSTs `/api/pair/verify { nonce, code, deviceName }`.
 *  4. On match, {@link verify} issues a `deviceId` + `deviceToken`, persists the
 *     device into the settings table, and returns the token to the mobile.
 *  5. Thereafter the mobile sends `Authorization: Bearer <deviceToken>`, which
 *     the HTTP server validates via {@link validateToken}.
 *
 * Tokens are stored plaintext in the settings DB (sql.js, on-disk). This is the
 * same threat model as the existing API-key storage: the DB lives in the user's
 * own userData dir, and an attacker who can read it already owns the machine.
 * (safeStorage encryption for API keys protects against a different path —
 * keys that must leave the process to reach an upstream. Device tokens never
 * leave this process, so HMAC-over-time is not needed.)
 */
import { networkInterfaces, hostname } from "node:os";
import { SettingRepo } from "@main/store/repositories.js";
import { awaitDb } from "@main/store/db.js";
import { log } from "@main/lib/logger.js";
import {
  PAIRING_TTL_MS,
  MOBILE_PAIRED_DEVICES_SETTING_KEY,
  type PairedDevice,
  type PairingStartResult,
  type PairingVerifyInput,
  type PairingVerifyResult,
  type StoredPairedDevice,
} from "@contracts/mobile";
import {
  generateDeviceId,
  generateDeviceToken,
  generatePairingNonce,
  generateVerificationCode,
  safeEqualString,
} from "./mobileTokens.js";

interface PendingPairing {
  nonce: string;
  code: string;
  expiresAt: number;
  /** Wrong-code attempts so far; the nonce is voided after 5. */
  attempts?: number;
}

/** Interface-name prefixes that are virtual / non-routable from a phone and
 *  must never become the QR URL's host (the phone would try to reach its own
 *  loopback or a container bridge and time out). Covers Docker (br-/veth/docker),
 *  VMware/VirtualBox (vmnet/vbox), Apple AWDL/llw, tunnels (utun/tun/tap),
 *  and the loopback stack. */
const VIRTUAL_IF_PREFIXES = [
  "docker",
  "br-", // docker bridges
  "veth",
  "vmnet", // VMware / VirtualBox on macOS
  "vbox",
  "awdl", // Apple Wireless Direct Link
  "llw", // Apple low-power Wi-Fi relay
  "utun", // macOS tunnels / VPN / iCloud Private Relay
  "tun",
  "tap",
  "ppp", // PPP / PPPoE
  "tailscale",
  "wg",
];

/** True if the interface name looks like a virtual / non-LAN adapter. */
function isVirtualInterface(name: string): boolean {
  const lower = name.toLowerCase();
  return VIRTUAL_IF_PREFIXES.some((p) => lower.startsWith(p));
}

/** Find the best candidate LAN IPv4 address for the QR URL. Prefers physical
 *  interfaces (en, eth, wlan, Wi-Fi) in the private ranges 192.168 / 10. /
 *  172.16-31; falls back to any non-internal, non-virtual v4. Returns null if
 *  there's no usable address (e.g. fully offline). */
export function detectLanIp(): string | null {
  const nets = networkInterfaces();
  interface Candidate {
    address: string;
    name: string;
    privateRank: number; // 2 = 192.168, 1 = 10. / 172.16-31, 0 = other
    physicalRank: number; // 1 = physical (en/eth/wlan prefix), 0 = other
  }
  const candidates: Candidate[] = [];
  for (const [name, list] of Object.entries(nets)) {
    if (!list) continue;
    if (isVirtualInterface(name)) continue;
    for (const net of list) {
      if (!net || net.family !== "IPv4" || net.internal) continue;
      const a = net.address;
      const privateRank = a.startsWith("192.168.")
        ? 2
        : a.startsWith("10.")
          ? 1
          : /^172\.(1[6-9]|2\d|3[01])\./.test(a)
            ? 1
            : 0;
      const lower = name.toLowerCase();
      const physicalRank =
        lower.startsWith("en") || lower.startsWith("eth") || lower.startsWith("wlan") || lower.startsWith("wi-fi")
          ? 1
          : 0;
      candidates.push({ address: a, name, privateRank, physicalRank });
    }
  }
  if (candidates.length === 0) return null;
  // Prefer: private range (192.168 first), then physical interface, then name.
  candidates.sort((x, y) => y.privateRank - x.privateRank || y.physicalRank - x.physicalRank || x.name.localeCompare(y.name));
  return candidates[0].address;
}

/** All non-virtual, non-internal IPv4 candidates (for the PC UI to show
 *  alternates when auto-detection picks the wrong one). */
export function detectLanIps(): string[] {
  const nets = networkInterfaces();
  const out: string[] = [];
  for (const [name, list] of Object.entries(nets)) {
    if (!list) continue;
    if (isVirtualInterface(name)) continue;
    for (const net of list) {
      if (!net || net.family !== "IPv4" || net.internal) continue;
      out.push(net.address);
    }
  }
  return out;
}

/** A human-friendly device-id the phone can show in absence of a user-set name.
 *  Purely cosmetic; not used for auth. */
export function detectHostLabel(): string {
  try {
    return hostname() || "Mcode";
  } catch {
    return "Mcode";
  }
}

export class PairingManager {
  private pending: PendingPairing | null = null;

  /** Await DB readiness before any read/write of the device list. */
  private async ready(): Promise<void> {
    await awaitDb();
  }

  /** Begin a pairing session. Idempotent-within-TTL: if an unexpired pairing is
   *  already pending, it is reused (same nonce + code, QR URL rebuilt for the
   *  given endpoint) instead of being superseded. Regenerating on every call
   *  orphaned already-open pages (their pinned `?nonce=` stops matching the
   *  server-side pending nonce, producing a "link mismatch" even when the user
   *  typed the currently-displayed code) and raced the QR-vs-code display under
   *  React StrictMode's double effect invocation. Only an expired or consumed
   *  pending pairing is replaced. The endpoint comes from the HTTP server (it
   *  knows its bound port + detected LAN IP).
   *
   *  `opts.force` voids the pending pairing and generates a fresh nonce + code
   *  — the explicit "refresh QR" path. The pending nonce's TTL-reuse above is
   *  what makes refresh a visible no-op otherwise. Any phone page already
   *  open on the old nonce stops matching (expected: the user asked for a new
   *  code) and must re-scan. */
  startPairing(endpoint: string, opts?: { force?: boolean }): PairingStartResult {
    const now = Date.now();
    if (!opts?.force && this.pending && now <= this.pending.expiresAt) {
      log.info(
        `mobile: pairing reused (nonce ends ${this.pending.nonce.slice(-6)}, expires in ${Math.ceil((this.pending.expiresAt - now) / 1000)}s)`,
      );
      return {
        qrUrl: `${endpoint}/?nonce=${this.pending.nonce}`,
        endpoint,
        nonce: this.pending.nonce,
        code: this.pending.code,
        expiresAt: this.pending.expiresAt,
      };
    }
    const nonce = generatePairingNonce();
    const code = generateVerificationCode();
    const expiresAt = now + PAIRING_TTL_MS;
    this.pending = { nonce, code, expiresAt };
    const qrUrl = `${endpoint}/?nonce=${nonce}`;
    log.info(`mobile: pairing started (nonce ends ${nonce.slice(-6)}, expires in ${PAIRING_TTL_MS / 1000}s)`);
    return { qrUrl, endpoint, nonce, code, expiresAt };
  }

  /** The currently-pending pairing (for the PC UI to display the remaining code
   *  + countdown), or null. */
  getPending(): { code: string; expiresAt: number } | null {
    if (!this.pending) return null;
    if (Date.now() > this.pending.expiresAt) {
      this.pending = null;
      return null;
    }
    return { code: this.pending.code, expiresAt: this.pending.expiresAt };
  }

  /** Cancel any pending pairing (PC UI "cancel" button or dialog close). */
  cancelPairing(): void {
    this.pending = null;
  }

  /** Attempt to complete pairing. Returns the token bundle on success, or an
   *  error with a specific reason on any mismatch / expiry. The reason is
   *  logged server-side and surfaced to the client so pairing failures are
   *  diagnosable instead of an opaque "rejected". */
  async verify(
    input: PairingVerifyInput,
    endpoint: string,
  ): Promise<{ ok: true; result: PairingVerifyResult } | { ok: false; reason: string }> {
    await this.ready();
    const pending = this.pending;
    if (!pending) {
      log.warn("mobile: verify failed — no pending pairing (start pairing on the PC first)");
      return { ok: false, reason: "PC 端尚未发起配对，请先点击「连接手机」生成二维码" };
    }
    if (Date.now() > pending.expiresAt) {
      this.pending = null;
      log.warn(`mobile: verify failed — nonce expired (was pending ${pending.nonce.slice(-6)})`);
      return { ok: false, reason: "验证码已过期，请在 PC 端刷新二维码后重试" };
    }
    if (!safeEqualString(input.nonce, pending.nonce)) {
      log.warn(
        `mobile: verify failed — nonce mismatch (got …${input.nonce.slice(-6)}, pending …${pending.nonce.slice(-6)})`,
      );
      return {
        ok: false,
        reason: "配对链接已失效（PC 端可能已刷新过二维码），请用 PC 端当前二维码重新打开最新链接，再输入验证码",
      };
    }
    // 6-digit code: constant-time comparison is nice-to-have, not critical, but
    // cheap — use it anyway. Also bound the attempts by expiring on 5 wrong
    // codes to blunt brute force (10^6 space, 5 tries / 5 min ⇒ negligible).
    if (!safeEqualString(input.code, pending.code)) {
      pending.attempts = (pending.attempts ?? 0) + 1;
      const remaining = 5 - pending.attempts;
      log.warn(
        `mobile: verify failed — code mismatch (attempt ${pending.attempts}/5, pending …${pending.code.slice(-4)})`,
      );
      if (pending.attempts >= 5) this.pending = null;
      return {
        ok: false,
        reason: remaining > 0 ? `验证码错误，还剩 ${remaining} 次机会` : "验证码错误次数过多，请刷新二维码",
      };
    }

    const deviceId = generateDeviceId();
    const deviceToken = generateDeviceToken();
    const now = Date.now();
    const devices = this.readDevicesRaw();
    devices.push({
      deviceId,
      name: input.deviceName,
      pairedAt: now,
      lastSeenAt: now,
      deviceToken,
    });
    SettingRepo.set(MOBILE_PAIRED_DEVICES_SETTING_KEY, JSON.stringify(devices));
    this.pending = null;
    log.info(`mobile: device paired (${deviceId}, name=${input.deviceName})`);
    return { ok: true, result: { deviceId, deviceToken, endpoint } };
  }

  /** Validate a bearer token. Returns the public device record on success. Also
   *  opportunistically refreshes `lastSeenAt` (throttled to once per minute per
   *  device to avoid DB write churn). */
  async validateToken(token: string): Promise<PairedDevice | null> {
    await this.ready();
    const devices = this.readDevicesRaw();
    const idx = devices.findIndex((d) => safeEqualString(d.deviceToken, token));
    if (idx < 0) return null;
    const d = devices[idx];
    const now = Date.now();
    if (now - d.lastSeenAt > 60_000) {
      devices[idx] = { ...d, lastSeenAt: now };
      SettingRepo.set(MOBILE_PAIRED_DEVICES_SETTING_KEY, JSON.stringify(devices));
    }
    return { deviceId: d.deviceId, name: d.name, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt };
  }

  /** List paired devices (token stripped) for the PC UI. */
  async listDevices(): Promise<PairedDevice[]> {
    await this.ready();
    return this.readDevicesRaw().map(({ deviceToken: _token, ...rest }) => rest);
  }

  /** Forget a device — its token stops being accepted immediately. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.ready();
    const devices = this.readDevicesRaw().filter((d) => d.deviceId !== deviceId);
    SettingRepo.set(MOBILE_PAIRED_DEVICES_SETTING_KEY, JSON.stringify(devices));
    log.info(`mobile: device revoked (${deviceId})`);
  }

  private readDevicesRaw(): StoredPairedDevice[] {
    const raw = SettingRepo.get(MOBILE_PAIRED_DEVICES_SETTING_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed as StoredPairedDevice[];
    } catch {
      return [];
    }
  }
}

/** Process-wide singleton. */
export const pairingManager = new PairingManager();
