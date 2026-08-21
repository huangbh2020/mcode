/**
 * Voice-input hook: capture the microphone in the renderer and stream 16 kHz
 * mono PCM to the main-process ASR (sherpa-onnx) engine, then surface live
 * partial + final transcripts.
 *
 * The hook is MODE-AGNOSTIC: it owns a single active "listen". Callers decide
 * whether that's "continuous" (start → user speaks → stop) or push-to-talk
 * (start on pointer-down, stop on pointer-up).
 *
 * Audio path:
 *   getUserMedia({ audio }) → AudioContext at the DEVICE-NATIVE rate →
 *   ScriptProcessorNode → in-JS linear resample to 16 kHz → a running
 *   Float32 accumulator. Every callback's samples go to main via
 *   `api.voice.feed` (converted to number[] for the IPC contract). Live
 *   results arrive back on the `voice:result` push channel.
 *
 * WHY native-rate context (not `new AudioContext({ sampleRate: 16000 })`):
 * Chromium's audio-processing chain (AEC/NS/AGC) runs the mic track at the
 * device rate (usually 48 kHz). Feeding a getUserMedia stream into a
 * context whose rate differs from that is a known-flaky combination on
 * Windows — the ScriptProcessor can deliver all-zero buffers, which silently
 * produces no transcription. Running the context at its native rate and
 * resampling to 16 kHz in JS is deterministic everywhere.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import type { VoiceEngine } from "@contracts/ipc";

/** Target ASR sample rate (Hz) — matches the engine's featConfig. */
const TARGET_RATE = 16000;
/** Minimum clip length (samples) forced out on stop — a tap on the mic button
 *  shouldn't inject a frame of near-silence. */
const MIN_CHUNK_SAMPLES = 320; // 20ms @ 16kHz
/** Batch samples up to ~250ms before feeding IPC. Each invoke costs a
 *  structured clone + zod validation round-trip; at the ScriptProcessor's
 *  ~85ms cadence that's a needless ~12 invokes/sec. Partial-text latency is
 *  unaffected in practice (humans read slower than 250ms). */
const FLUSH_SAMPLES = TARGET_RATE / 4;

/** Options for the hook. `onFinal` fires with the committed transcript; the
 *  mic state settles regardless of whether text was produced. */
interface UseVoiceInputOptions {
  /** Default recognition language tag (e.g. "zh-CN" | "en-US"). */
  lang?: string;
  /** Desired ASR engine; falls back to streaming zipformer when unavailable. */
  engine?: VoiceEngine;
  /** Live interim text as it streams. */
  onPartial?: (text: string) => void;
  /** Committed final text. */
  onFinal?: (text: string) => void;
}

interface UseVoiceInputResult {
  /** True while a listen is active (mic engaged + streaming to ASR). */
  busy: boolean;
  /** Start a listen. Resolves once the mic is live and ASR is primed. */
  start: () => Promise<void>;
  /** Stop the active listen, flush the decoder, and return the final text. */
  stop: () => Promise<string>;
  /** Discard the active listen without returning text. */
  cancel: () => Promise<void>;
  /** A friendly mic error message (permission denied / no device), or null. */
  micError: string | null;
  /** Clear the mic-error state. */
  clearMicError: () => void;
}

export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputResult {
  const { lang, engine = "zipformer", onPartial, onFinal } = options;
  const langRef = useRef(lang);
  const engineRef = useRef(engine);
  const onPartialRef = useRef(onPartial);
  const onFinalRef = useRef(onFinal);
  langRef.current = lang;
  engineRef.current = engine;
  onPartialRef.current = onPartial;
  onFinalRef.current = onFinal;

  const [busy, setBusy] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  // Refs to live audio + session resources so the async capture callbacks
  // (onaudioprocess / push results) never operate on stale closures.
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  // Device-native capture rate (set once the context opens) + the fractional
  // resampler position carried across chunks so seams between callbacks
  // introduce no drift.
  const srcRateRef = useRef(48000);
  const resamplePosRef = useRef(0);
  // Guards the async start() path so a rapid double-click can't open two
  // AudioContexts before `busy` state propagates.
  const startingRef = useRef(false);
  // Accumulated 16 kHz samples not yet flushed to main.
  const pendingRef = useRef<Float32Array | null>(null);
  // Uplink observability: total 16 kHz samples sent + last log watermark, so
  // the renderer console (forwarded to stderr) shows audio actually flowing.
  const sentSamplesRef = useRef(0);
  const lastStatRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  // The recognizer may finish a segment (endpoint) mid-listen; we keep the
  // consolidated final text so stop() can return everything spoken.
  const committedRef = useRef("");
  // Listen generation — bumped by start/stop/cancel so a superseded async
  // start() aborts at its next checkpoint (see `stale()` in start).
  const genRef = useRef(0);

  const clearMicError = useCallback(() => setMicError(null), []);

  /** Drain accumulated samples to main. Feed failures are logged rather than
   *  swallowed — a silently-dropping uplink otherwise looks exactly like "the
   *  recognizer heard nothing". Pass `force` on stop to push a sub-250ms
   *  remainder (above MIN_CHUNK_SAMPLES) instead of dropping it. */
  const flush = useCallback((force = false) => {
    const pending = pendingRef.current;
    const sessionId = sessionIdRef.current;
    const min = force ? MIN_CHUNK_SAMPLES : FLUSH_SAMPLES;
    if (!pending || pending.length < min || !sessionId) return;
    pendingRef.current = null;
    sentSamplesRef.current += pending.length;
    if (sentSamplesRef.current - lastStatRef.current >= TARGET_RATE * 2) {
      lastStatRef.current = sentSamplesRef.current;
      console.debug(
        `[voice] streamed ${(sentSamplesRef.current / TARGET_RATE).toFixed(1)}s of audio`,
      );
    }
    // Send the Float32Array as-is: structured clone carries typed arrays at
    // 4 bytes/sample and the schema validates them with one instanceof check
    // (the old Array.from(pending) path cost a number[] allocation + a
    // per-element zod parse on every chunk, ~12×/s).
    void api.voice.feed({ sessionId, pcm: pending }).catch((err) => {
      console.warn("[voice] feed failed:", err);
    });
  }, []);

  /** Linear-resample one native-rate chunk to 16 kHz, carrying the fractional
   *  source position across calls (same approach validated against the engine
   *  offline). Good enough for ASR — this is not a quality-critical path.
   *  The phase carry is CLAMPED ≥ 0: the loop can exit one sample before the
   *  buffer end, and a negative phase would read `input[-1]` → a NaN at the
   *  head of every chunk, which the feed schema rejects (and the engine
   *  would choke on) — this exact bug punched 85ms holes into the audio. */
  const resampleChunk = useCallback((input: Float32Array): Float32Array => {
    const ratio = srcRateRef.current / TARGET_RATE;
    if (ratio === 1) return input;
    const out: number[] = [];
    let pos = resamplePosRef.current;
    while (pos + 1 < input.length) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = input[i0] ?? 0;
      const b = input[i0 + 1] ?? a;
      out.push(a + (b - a) * frac);
      pos += ratio;
    }
    resamplePosRef.current = Math.max(0, pos - input.length);
    return Float32Array.from(out);
  }, []);

  /** Subscribe to push results; forwards partials live and commits finals.
   *  No React state here — partials already stream into the composer via
   *  onPartial, and a per-partial setState would re-render the mic button
   *  several times a second for nothing. */
  useEffect(() => {
    return api.on.voiceResult((msg) => {
      if (msg.sessionId !== sessionIdRef.current) return; // stale listen
      if (msg.kind === "partial") {
        onPartialRef.current?.(msg.text);
      } else {
        // final — accumulate into committedText
        committedRef.current = msg.text;
      }
    });
  }, []);

  const teardownAudio = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    pendingRef.current = null;
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (busy || startingRef.current) return;
    startingRef.current = true;
    // Generation token: stop()/cancel() bump it, so a start() still in its
    // async window (e.g. a quick keyboard tap: keyup lands while getUserMedia
    // is pending) aborts instead of opening a mic nobody owns anymore.
    const gen = ++genRef.current;
    /** True when a newer start/stop has superseded this invocation. */
    const stale = () => gen !== genRef.current;
    try {
      setMicError(null);
      committedRef.current = "";
      sentSamplesRef.current = 0;
      lastStatRef.current = 0;

      // Fresh per-listen token so push results from a previous listen can't
      // leak into the next one.
      const sessionId = `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      sessionIdRef.current = sessionId;

      // Kick off the engine session and the mic acquisition CONCURRENTLY —
      // they're independent, so the click-to-capture dead time is the slower
      // leg instead of the sum (saves the full getUserMedia round-trip).
      // Results come back as discriminated objects: closure-assigned `let`s
      // defeat TS's control-flow narrowing.
      const startPromise = api.voice
        .start({ sessionId, lang: langRef.current ?? "zh-CN", engine: engineRef.current })
        .then(
          () => ({ ok: true as const, err: null as unknown }),
          (err: unknown) => ({ ok: false as const, err }),
        );
      const micPromise = navigator.mediaDevices
        .getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            autoGainControl: true,
            noiseSuppression: true,
          },
        })
        .then(
          (s) => ({ ok: s as MediaStream | null, err: null as unknown }),
          (err: unknown) => ({ ok: null as MediaStream | null, err }),
        );
      const [startRes, micRes] = await Promise.all([startPromise, micPromise]);

      if (!startRes.ok) {
        micRes.ok?.getTracks().forEach((t) => t.stop());
        if (!stale()) setMicError(String((startRes.err as Error).message ?? startRes.err));
        sessionIdRef.current = null;
        return;
      }
      if (!micRes.ok) {
        if (!stale()) setMicError(String((micRes.err as Error)?.message ?? micRes.err));
        void api.voice.cancel({ sessionId }).catch(() => {});
        sessionIdRef.current = null;
        return;
      }
      if (stale()) {
        // Someone stopped us mid-acquire — close what we just opened.
        micRes.ok.getTracks().forEach((t) => t.stop());
        void api.voice.cancel({ sessionId }).catch(() => {});
        sessionIdRef.current = null;
        return;
      }
      streamRef.current = micRes.ok;

      // Native-rate context — see header note for why NOT 16000.
      const stream = micRes.ok;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      srcRateRef.current = ctx.sampleRate;
      resamplePosRef.current = 0;
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      // bufferSize 4096 at 48 kHz ≈ 85ms per callback; resampled to ~1365
      // samples @16 kHz. Three callbacks amortize into one 4000-sample
      // (250ms) batch — see FLUSH_SAMPLES.
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        const resampled = resampleChunk(data);
        const pending = pendingRef.current;
        // Append this callback's samples onto the accumulator.
        const merged = new Float32Array((pending?.length ?? 0) + resampled.length);
        if (pending) merged.set(pending, 0);
        merged.set(resampled, pending?.length ?? 0);
        pendingRef.current = merged;
        flush();
      };
      source.connect(processor);
      processor.connect(ctx.destination); // must be connected to fire onaudioprocess

      if (stale()) {
        // Superseded while the AudioContext was resuming.
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close().catch(() => {});
        streamRef.current = null;
        ctxRef.current = null;
        void api.voice.cancel({ sessionId }).catch(() => {});
        sessionIdRef.current = null;
        return;
      }

      setBusy(true);
    } finally {
      startingRef.current = false;
    }
  }, [busy, flush]);

  const stop = useCallback(async (): Promise<string> => {
    // Invalidate any start() still in its async window so it aborts (and
    // closes whatever it acquired) instead of resurrecting the mic.
    genRef.current++;
    const sessionId = sessionIdRef.current;
    if (!sessionId) return "";
    // Flush any residual samples before closing (force: sub-250ms tail).
    flush(true);
    teardownAudio();
    sessionIdRef.current = null;
    setBusy(false);
    let text = "";
    try {
      const res = await api.voice.stop({ sessionId });
      text = res.text || committedRef.current;
    } catch {
      text = committedRef.current;
    }
    if (text) onFinalRef.current?.(text);
    return text;
  }, [flush, teardownAudio]);

  const cancel = useCallback(async (): Promise<void> => {
    genRef.current++;
    const sessionId = sessionIdRef.current;
    // Drop the un-sent batch too — cancel discards everything.
    pendingRef.current = null;
    teardownAudio();
    sessionIdRef.current = null;
    setBusy(false);
    if (sessionId) {
      await api.voice.cancel({ sessionId }).catch(() => {});
    }
  }, [teardownAudio]);

  // Safety: never leave the mic engaged if the consumer unmounts mid-listen.
  useEffect(() => {
    return () => {
      genRef.current++; // abort any start() still in its async window
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void ctxRef.current?.close().catch(() => {});
      if (sessionId) void api.voice.cancel({ sessionId }).catch(() => {});
    };
  }, []);

  return { busy, start, stop, cancel, micError, clearMicError };
}
