/**
 * Global voice-dictation indicator — a lightweight capsule floating at the
 * top-center of the page whenever ANY composer is listening.
 *
 * Driven by the voiceController active-state pub/sub (flipped the instant a
 * listen is armed — on click or the ⌘/Ctrl+Shift+V chord — not when the
 * async capture chain finally completes), so the user gets immediate
 * feedback that dictation started.
 *
 * Shows a running duration (proof the mic is still alive) plus a
 * mode-specific "how to stop" hint and the Esc-cancel affordance.
 *
 * Reuses the live-activity equalizer (`.live-eq`) for the animation and the
 * badge pop-in keyframes; fully pointer-transparent so it never blocks the
 * UI underneath.
 */
import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { onVoiceActiveChange } from "@renderer/lib/voiceController.js";

/** mm:ss for the duration readout. */
function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function VoiceListeningOverlay() {
  const { t } = useI18n();
  const [active, setActive] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const voiceInputMode = useSessionStore((s) => s.voiceInputMode);

  useEffect(() => onVoiceActiveChange(setActive), []);

  // Duration ticker: runs only while a listen is active; resets per listen.
  useEffect(() => {
    if (!active) return;
    setSeconds(0);
    const started = Date.now();
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [active]);

  if (!active) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-[18%] z-50 flex justify-center"
      aria-live="polite"
    >
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-full border border-edge bg-surface/95 py-1.5 pl-4 pr-5",
          "shadow-2xl backdrop-blur animate-[live-badge-in_220ms_ease-out]",
        )}
      >
        <span className="live-eq" aria-hidden>
          <span />
          <span />
          <span />
        </span>
        <span className="text-xs font-medium text-content">
          {t("chat.voice.listening")}
        </span>
        <span className="text-xs tabular-nums text-content-subtle">
          {formatDuration(seconds)}
        </span>
        <span className="text-[0.7rem] text-content-subtle">
          {voiceInputMode === "pushToTalk"
            ? t("chat.voice.overlayHintPtt")
            : t("chat.voice.overlayHintContinuous")}
        </span>
      </div>
    </div>
  );
}
