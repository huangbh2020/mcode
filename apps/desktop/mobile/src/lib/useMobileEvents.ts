/**
 * useMobileEvents — subscribes to the desktop's event stream via SSE and feeds
 * every RuntimeEvent into the mobile store's reducer.
 *
 * EventSource auto-reconnects natively; on a fresh connection we also re-fetch
 * the active session's message snapshot (so deltas missed while disconnected
 * are recovered as aggregated state). A heartbeat watchdog surfaces a
 * "reconnecting" state if no bytes arrive for ~25s (the server pings every 15s).
 */
import { useEffect, useRef, useState } from "react";
import { mobileApi } from "./mobileApi.js";
import { useMobileStore } from "../stores/mobileStore.js";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "error";

export function useMobileEvents(enabled: boolean): ConnectionState {
  const [state, setState] = useState<ConnectionState>("connecting");
  const ingest = useMobileStore((s) => s.ingestEvent);
  const recover = useMobileStore((s) => s.recoverAfterReconnect);
  const esRef = useRef<EventSource | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const connect = () => {
      let url: string;
      try {
        url = mobileApi.eventsUrl();
      } catch {
        setState("error");
        return;
      }
      const es = new EventSource(url);
      esRef.current = es;
      setState(es.readyState === 1 ? "open" : "connecting");

      es.onopen = () => {
        if (cancelled) return;
        setState("open");
        // Re-fetch the active session snapshot to recover missed events.
        void recover();
        armWatchdog();
      };

      es.onmessage = (ev) => {
        if (cancelled) return;
        armWatchdog();
        try {
          const frame = JSON.parse(ev.data) as { sessionId: string; event: unknown };
          ingest(frame.event);
        } catch {
          // ignore malformed frames
        }
      };

      es.onerror = () => {
        if (cancelled) return;
        // EventSource will auto-reconnect; mark state so the UI can show it.
        setState("reconnecting");
      };
    };

    // Heartbeat watchdog: if no message (data or `: ping` comment) arrives
    // within ~25s, assume the link is stale. EventSource should reconnect on
    // its own; we just reflect it in the UI.
    const armWatchdog = () => {
      if (watchdogRef.current) clearInterval(watchdogRef.current);
      watchdogRef.current = setInterval(() => {
        const es = esRef.current;
        if (!es) return;
        if (es.readyState !== 1) setState("reconnecting");
      }, 25_000);
    };

    connect();

    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
      if (watchdogRef.current) clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    };
  }, [enabled, ingest, recover]);

  return state;
}
