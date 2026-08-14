/**
 * Token / secret primitives for mobile pairing, built on node:crypto so no new
 * dependency is needed.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Generate a device id (e.g. `dev_<time><rand>`). Stable for the device's
 *  paired lifetime; persisted in the settings table. */
export function generateDeviceId(): string {
  return `dev_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

/** Generate an opaque 256-bit device token. Sent to the mobile exactly once at
 *  pairing; subsequently carried in the `Authorization: Bearer` header. */
export function generateDeviceToken(): string {
  return randomBytes(32).toString("hex");
}

/** Generate a one-time pairing nonce, valid for {@link PAIRING_TTL_MS}. */
export function generatePairingNonce(): string {
  return randomBytes(12).toString("hex");
}

/** Generate a 6-digit zero-padded verification code shown on the PC. */
export function generateVerificationCode(): string {
  // readUInt32BE gives a uniform 32-bit value; mod 1e6 keeps 6 digits.
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, "0");
}

/** Constant-time comparison for two hex/ascii strings of equal expected length.
 *  Guards token comparison against timing side-channels. Length mismatch returns
 *  false immediately (the length is not itself sensitive here). */
export function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}
