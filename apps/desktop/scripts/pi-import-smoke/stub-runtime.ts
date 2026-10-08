/** Stub for @main/claude/RuntimeManager.js — just the observer registry the
 *  pi-import module attaches to, plus a test hook to fire events through it. */

type Obs = (e: { type: string; sessionId: string }) => void;

const observers: Obs[] = [];

export const runtimeManager = {
  addObserver(fn: Obs): () => void {
    observers.push(fn);
    return () => {
      const i = observers.indexOf(fn);
      if (i >= 0) observers.splice(i, 1);
    };
  },
  /** Test hook: fan an event out to every registered observer. */
  emitTestEvent(e: { type: string; sessionId: string }): void {
    for (const fn of observers) fn(e);
  },
};
