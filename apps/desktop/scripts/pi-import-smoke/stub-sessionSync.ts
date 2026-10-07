/** Stub for @main/lib/sessionSync.js — captures broadcast sessions instead of
 *  pushing into electron windows + the mobile SSE bus. */
import type { Session } from "@contracts/session";

export const broadcasted: Session[] = [];

export function broadcastSessionChanged(session: Session): void {
  broadcasted.push(session);
}

export function broadcastSessionDeleted(_sessionId: string): void {
  /* not consumed by the smoke */
}

export function broadcastRuntimeEvent(_e: unknown): void {
  /* not consumed by the smoke */
}
