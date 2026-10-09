/** base64 stand-in for safeStorage encrypt/decrypt — round-trips so the
 *  resolveApiKey path can be asserted without electron. */
export function encrypt(plain: string): string {
  return Buffer.from(plain, "utf-8").toString("base64");
}

export function decrypt(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf-8");
}
