/**
 * Stub for @main/lib/secretStore.js (headless smoke): reverses the base64
 * "encryption" the stub store hands out. No electron import.
 */
export function encrypt(plain: string): string {
  return Buffer.from(plain, "utf8").toString("base64");
}

export function decrypt(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Unused by the smoke but exported to keep the module shape compatible. */
export const CustomModelStore = {};
