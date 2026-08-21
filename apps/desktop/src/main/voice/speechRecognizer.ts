/**
 * Main-process speech-to-text engine backed by sherpa-onnx (k2-fsa).
 *
 * WHY SHERPA-ONNX (not Web Speech API): the user wants strong Chinese
 * recognition. The Chromium `webkitSpeechRecognition` path routes to the OS's
 * built-in recognizer, whose Chinese accuracy is weak and which we can't
 * control. sherpa-onnx runs modern open ASR models fully on-device (offline,
 * free):
 *
 *   - Streaming Zipformer (Chinese, trained on WenetSpeech), e.g.
 *     `sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23`. Supports *streaming*
 *     decoding with live interim ("partial") results — this is what drives the
 *     live "文字边听边出" UX for both continuous and push-to-talk modes.
 *   - NVIDIA Parakeet (e.g. Parakeet TDT v3) offline recognizer for a final
 *     high-accuracy pass (no interim results). Not yet wired — the parakeet
 *     engine request falls back to the streaming zipformer recognizer.
 *
 * MODEL MANAGEMENT: models are downloaded from the catalog in Settings →
 * 语音输入 (see models.ts). The engine validates that the required files are
 * present in the model directory at `voice.start` time and reports a clear
 * error (with which file is missing) if they aren't. All recognition happens
 * locally; nothing is sent to the network at inference time.
 *
 * The heavy native addon is lazily required on the first `voice.start` call so
 * app startup is not slowed and so a missing/broken native dependency cannot
 * take down the whole main process — the IPC layer catches and reports the
 * error to the renderer instead.
 */
import { join } from "node:path";
import type { VoiceResultPayload } from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import {
  requireModelDir,
  selectedModelId,
  transducerFilesFor,
} from "./models.js";

/** Emitted per live result (partial/final). Hooked by the IPC layer to push
 *  to the renderer. */
export interface VoiceResultListener {
  (payload: VoiceResultPayload): void;
}

/** A single in-flight recognition session (one active listen). */
interface Session {
  /** Online streaming stream for the zipformer decoder. */
  stream: OnlineStream | null;
  /** The live online recognizer this session belongs to. */
  online: OnlineRecognizer | null;
  /** Total samples received — logs the first chunk so main.log proves the
   *  renderer uplink is alive (a dead uplink otherwise fails silently). */
  fedSamples: number;
  /** Segments already committed at endpoint (trailing-silence) boundaries. */
  committedText: string;
  /** Latest text of the CURRENT (not yet endpoint-reset) segment. */
  currentSegment: string;
  /** Last text pushed as a partial — dedupes the push channel (decode()
   *  runs many times per second; text changes less often). */
  lastEmitted: string;
}

/** Minimal structural types for the `sherpa-onnx-node` addon. We duck-type it
 *  (loaded lazily) rather than importing, so a missing addon doesn't break
 *  module load. */
interface OnlineStream {
  handle: unknown;
  acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
}
interface OnlineRecognizer {
  createStream(): OnlineStream;
  isReady(s: { handle: unknown }): boolean;
  decode(s: { handle: unknown }): void;
  isEndpoint(s: { handle: unknown }): boolean;
  reset(s: { handle: unknown }): void;
  getResult(s: { handle: unknown }): { text: string; tokens?: string[] };
}
interface OfflineStream {
  handle: unknown;
  acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void;
}
interface OfflineRecognizer {
  createStream(): OfflineStream;
  decode(s: { handle: unknown }): void;
  getResult(s: { handle: unknown }): { text: string };
}

const SAMPLE_RATE = 16000;
const FEATURE_DIM = 80;

/** CJK detection for endpoint punctuation — the streaming zipformer emits no
 *  punctuation at all, so segments run together into unreadable sludge
 *  ("今天天气很好我们出去玩吧"). At each endpoint (trailing-silence boundary)
 *  we append a sentence mark matched to the segment's dominant script:
 *  。 for CJK, ". " for Latin. */
const HAS_CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/;

/** Drop the cached recognizer so the next session rebuilds against the
 *  currently-selected model. Called when a model is deleted from disk (the
 *  cache would otherwise point at unlinked ONNX files). */
export function resetRecognizerCache(): void {
  onlineRecognizer = null;
  recognizerModelId = null;
}

/** Registry of in-flight sessions keyed by the renderer's opaque token. */
const sessions = new Map<string, Session>();
let onlineRecognizer: OnlineRecognizer | null = null;
/** Which model the cached recognizer was built for — a selection change in
 *  Settings must rebuild instead of reusing the stale engine. */
let recognizerModelId: string | null = null;
let listener: VoiceResultListener | null = null;

/** Set the callback invoked for every live result. */
export function setVoiceResultListener(fn: VoiceResultListener): void {
  listener = fn;
}

function emit(sessionId: string, kind: "partial" | "final", text: string): void {
  if (listener) listener({ sessionId, kind, text });
}

/** Lazily load + build the shared streaming (zipformer) recognizer for the
 *  currently-selected voice model. Resolves the model's directory (throwing a
 *  clear error when nothing is selected or files are missing) via models.ts,
 *  then constructs the sherpa online recognizer.
 *
 *  NOTE the config shape: the native addon reads `modelConfig.transducer` for
 *  streaming zipformer models (encoder/decoder/joiner live there — streaming
 *  zipformer IS a transducer in sherpa's model taxonomy). An unknown key like
 *  `zipformer` is silently dropped, leaving transducer paths empty, and the
 *  C++ side then fails with `transducer encoder: '' does not exist`.
 */
async function getOnlineRecognizer(): Promise<OnlineRecognizer> {
  const modelId = selectedModelId();
  if (!modelId) {
    throw new Error("尚未选择语音模型。请在 设置 → 语音输入 中先下载并选择一个模型。");
  }
  if (onlineRecognizer && recognizerModelId === modelId) return onlineRecognizer;
  const modelDir = requireModelDir(modelId);
  const files = transducerFilesFor(modelId);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OnlineRecognizer } = require("sherpa-onnx-node") as {
    OnlineRecognizer: new (cfg: unknown) => OnlineRecognizer;
  };
  const enc = (rel: string) => join(modelDir, rel);
  onlineRecognizer = new OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: FEATURE_DIM },
    modelConfig: {
      tokens: enc(files.tokens),
      transducer: {
        encoder: enc(files.encoder),
        decoder: enc(files.decoder),
        joiner: enc(files.joiner),
      },
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
  });
  recognizerModelId = modelId;
  log.info(`[voice] online(zipformer) recognizer ready (modelDir=${modelDir})`);
  return onlineRecognizer;
}

/** Pre-build the cached recognizer in the background so the FIRST
 *  `voice.start` doesn't pay the model-load latency (loading the native addon
 *  + ONNX files takes seconds). Safe to call repeatedly — once built the
 *  cached instance returns immediately. Errors are swallowed (e.g. no model
 *  selected yet) — `voice.start` surfaces them properly when it matters. */
export function warmupRecognizer(): void {
  void getOnlineRecognizer().catch((err) => {
    log.info(`[voice] warmup skipped: ${(err as Error).message}`);
  });
}

/** Start a voice session for the given token. `lang` is accepted but the model
 *  is language-fixed; sherpa-onnx decodes whatever language is spoken. Loads
 *  the native addon + validates the selected model on first use; throws a
 *  clear error when no model is selected/downloaded yet. */
export async function startSession(
  sessionId: string,
  lang: string,
  engine: "zipformer" | "parakeet",
): Promise<void> {
  if (sessions.has(sessionId)) return;
  log.info(`[voice] start session=${sessionId} lang=${lang} engine=${engine}`);
  const rec = await getOnlineRecognizer();
  const stream = rec.createStream();
  sessions.set(sessionId, {
    stream,
    online: rec,
    fedSamples: 0,
    committedText: "",
    currentSegment: "",
    lastEmitted: "",
  });
  log.info(`[voice] session started ${sessionId}`);
}

/** Feed a 16 kHz mono Float32 chunk into the active session. */
export function feedPcm(sessionId: string, pcm: Float32Array): void {
  const s = sessions.get(sessionId);
  if (!s || !s.stream) return;
  if (s.fedSamples === 0) {
    log.info(`[voice] first pcm chunk ${sessionId} (${pcm.length} samples)`);
  }
  s.fedSamples += pcm.length;
  try {
    s.stream.acceptWaveform({ samples: pcm, sampleRate: SAMPLE_RATE });
  } catch (err) {
    log.error(`[voice] feedPcm failed: ${(err as Error).message}`);
    return;
  }
  // Drain the decoder: emit live partials as the streaming grammar advances.
  const rec = s.online;
  if (!rec) return;
  try {
    while (rec.isReady(s.stream)) {
      rec.decode(s.stream);
      const r = rec.getResult(s.stream);
      if (r.text) s.currentSegment = r.text;
      // Endpoint (trailing silence): commit the segment and RESET the
      // decoder. Without the reset the streaming transducer tends to loop on
      // repeated tokens after silence, and the partial text never segments.
      if (rec.isEndpoint(s.stream)) {
        // Commit the segment with a script-matched sentence mark (see HAS_CJK)
        // and RESET the decoder. Without the reset the streaming transducer
        // tends to loop on repeated tokens after silence, and the partial text
        // never segments.
        if (s.currentSegment) {
          s.committedText +=
            s.currentSegment + (HAS_CJK.test(s.currentSegment) ? "。" : ". ");
        }
        s.currentSegment = "";
        rec.reset(s.stream);
      }
    }
    const text = s.committedText + s.currentSegment;
    if (text && text !== s.lastEmitted) {
      s.lastEmitted = text;
      emit(sessionId, "partial", text);
    }
  } catch (err) {
    log.error(`[voice] decode failed: ${(err as Error).message}`);
  }
}

/** Stop the session, returning the final transcript. */
export function stopSession(sessionId: string): { text: string } {
  const s = sessions.get(sessionId);
  if (!s) return { text: "" };
  const rec = s.online;
  let text = "";
  try {
    if (s.stream && rec) {
      s.stream.inputFinished();
      while (rec.isReady(s.stream)) {
        rec.decode(s.stream);
        const r = rec.getResult(s.stream);
        if (r.text) s.currentSegment = r.text;
      }
      text = s.committedText + s.currentSegment;
    }
  } catch (err) {
    log.error(`[voice] stop decode failed: ${(err as Error).message}`);
  }
  sessions.delete(sessionId);
  if (text) emit(sessionId, "final", text);
  log.info(
    `[voice] session stopped ${sessionId} => ${text ? `${text.length} chars` : "(empty)"} (${(s.fedSamples / 16000).toFixed(1)}s audio received)`,
  );
  return { text };
}

/** Cancel/discard a session without committing text. */
export function cancelSession(sessionId: string): void {
  sessions.delete(sessionId);
  log.info(`[voice] session cancelled ${sessionId}`);
}