/** Smoke stub for @main/lib/sessionSync.js. */
import type { Session } from "@contracts/session";

export const broadcasted: Session[] = [];
export function broadcastSessionChanged(session: Session): void {
  broadcasted.push(session);
}
