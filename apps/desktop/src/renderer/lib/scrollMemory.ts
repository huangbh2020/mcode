/**
 * Per-surface scroll positions for the READ-ONLY viewer panes — the desktop's
 * Markdown preview (FileEditor's `MarkdownPreviewPane`) and the mobile shell's
 * file viewer (`components/mobile/FileViewer.tsx`).
 *
 * Why a second cache next to `FileEditor`'s `viewStateCache`: that one holds
 * Monaco view states, which only exist for the edit/diff panes. The preview
 * panes have no model, no cursor and no line-height contract — they are plain
 * `overflow-auto` containers that React unmounts on every file switch, so a
 * long README always re-opened at the top after the user had scrolled it.
 * A plain pixel offset is the right unit for them.
 *
 * Module-level and session-lived, exactly like `viewStateCache`: a scroll
 * offset is convenience, not document state — nothing is persisted to disk.
 * Callers prefix their keys (`ide-preview:<path>`, `mobile-md:<path>`, …) so
 * one file can hold an independent offset per surface.
 */
import { useCallback, useLayoutEffect, useState } from "react";

const positions = new Map<string, number>();

/** Retry offsets (ms) applied after the first restore attempt: the content may
 *  still be growing (async image decode, Shiki replacing the raw fallback),
 *  and a container shorter than the saved offset clamps the write — the user
 *  would land mid-file. Bounded, and abandoned at the first real interaction. */
const RESTORE_RETRY_MS = [120, 400];

/** Restore-on-attach + remember-on-scroll for a scroll container.
 *
 *  Returns a callback ref for the scrolling element. The offset is applied
 *  during the layout phase (before paint, so the pane never flashes at the top
 *  for a frame), then retried briefly while the content settles. Any wheel /
 *  pointer / touch event cancels the pending retries — a late restore must
 *  never yank the view back out from under the user. */
export function useScrollMemory(key: string): (node: HTMLDivElement | null) => void {
  // The node is held inside a state OBJECT so a re-attached container always
  // re-runs the effect: a plain `useState<HTMLElement | null>` bails out when
  // the identity is unchanged, and a remount after a file switch could in
  // principle hand back the very same element.
  const [holder, setHolder] = useState<{ node: HTMLDivElement } | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    setHolder(node ? { node } : null);
  }, []);

  useLayoutEffect(() => {
    const el = holder?.node;
    if (!el) return;
    const saved = positions.get(key);
    // The last offset WE wrote — the only way a `scroll` event can be told
    // apart from a real user scroll (our own writes fire one too, and a
    // clamped write fires one carrying the clamped value).
    let applied = -1;
    let userActed = false;
    const write = (top: number) => {
      el.scrollTop = top;
      applied = el.scrollTop;
    };
    const onScroll = () => {
      if (el.scrollTop !== applied) positions.set(key, el.scrollTop);
    };
    const onIntent = () => {
      userActed = true;
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onIntent, { passive: true });
    el.addEventListener("pointerdown", onIntent);
    el.addEventListener("touchstart", onIntent, { passive: true });

    const timers: ReturnType<typeof setTimeout>[] = [];
    const stopRetries = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
    };
    const attempt = () => {
      if (userActed || saved == null) return;
      write(saved);
      // Sub-pixel scroll offsets are legal, so "arrived" is a tolerance test.
      if (Math.abs(el.scrollTop - saved) < 1) stopRetries();
    };
    if (saved != null) {
      attempt();
      for (const ms of RESTORE_RETRY_MS) timers.push(setTimeout(attempt, ms));
    }

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onIntent);
      el.removeEventListener("pointerdown", onIntent);
      el.removeEventListener("touchstart", onIntent);
      stopRetries();
    };
  }, [holder, key]);

  return ref;
}
