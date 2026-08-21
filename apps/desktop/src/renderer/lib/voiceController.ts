/**
 * Session-keyed registry of live voice-dictation handles.
 *
 * The composer's `MicButton` owns the actual listen (mic capture + live
 * transcript insertion via `useVoiceInput`), but keyboard shortcuts and the
 * command palette live at the app root and can't reach into a component's
 * internals. Each mounted MicButton registers its handle here (keyed by its
 * pane's session id — in tabs mode every pane stays mounted, so the LAST
 * registered per session wins), and the `voice.dictation` command resolves
 * the ACTIVE session's handle through `voiceHandleFor`.
 *
 * Handles are plain callbacks reading refs, so they never go stale; the
 * unregister function removes the entry when the pane unmounts.
 */

/** Imperative control surface over one composer's active listen. */
export interface VoiceHandle {
  /** Start a fresh listen. No-op when one is already active or the composer
   *  is locked; resets the live-transcript tail bookkeeping. */
  startListen: () => Promise<void>;
  /** Stop the active listen and commit the transcript into the composer.
   *  Safe to call when idle (no-op). */
  stopListen: () => Promise<void>;
  /** Discard the active listen AND the partial text it streamed into the
   *  composer. Safe to call when idle (no-op). */
  cancelListen: () => Promise<void>;
  /** True while a listen is active OR being started (the async getUserMedia
   *  window counts, so a quick tap in hold-to-talk mode still stops). */
  isBusy: () => boolean;
}

const handles = new Map<string, VoiceHandle>();

/** Register the handle for a session's composer. Returns an unregister fn. */
export function registerVoiceHandle(
  sessionId: string,
  handle: VoiceHandle,
): () => void {
  handles.set(sessionId, handle);
  return () => {
    // Only remove if this exact handle is still the registered one — a
    // remount may have already replaced it.
    if (handles.get(sessionId) === handle) handles.delete(sessionId);
  };
}

/** The handle for a session's composer, if its pane is mounted. */
export function voiceHandleFor(sessionId: string): VoiceHandle | undefined {
  return handles.get(sessionId);
}

/* ── active-state pub/sub ──
 * The global listening overlay (VoiceListeningOverlay) needs to know when ANY
 * composer is listening, without reaching into a component. MicButton flips
 * this the moment a listen is ARMED (synchronously on click/keypress — before
 * the async capture chain completes), so feedback is instant. */

type ActiveListener = (active: boolean) => void;
const activeListeners = new Set<ActiveListener>();
let voiceActive = false;

/** Flip the global "listening" state and notify subscribers. */
export function setVoiceActive(active: boolean): void {
  if (voiceActive === active) return;
  voiceActive = active;
  for (const l of activeListeners) l(active);
}

/** Subscribe to the global listening state. Returns an unsubscribe fn. */
export function onVoiceActiveChange(fn: ActiveListener): () => void {
  activeListeners.add(fn);
  return () => {
    activeListeners.delete(fn);
  };
}
