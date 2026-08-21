/**
 * IPC handlers for speech-to-text (voice input) + model management.
 *
 * Recognition path: the renderer streams 16 kHz mono PCM via `voice.feed`;
 * the main-process sherpa-onnx engine decodes the selected voice model and
 * pushes live `partial`/`final` results back on `voice:result`. Errors (wrong
 * model state / missing native addon) reject the relevant invoke so the
 * composer mic button can surface a friendly message.
 *
 * Model path (Settings → 语音输入 → 下载语言模型):
 *   - voice.modelList        : catalog + which are downloaded + the selection
 *   - voice.downloadModel    : stream a catalog model's files from HF
 *   - voice.cancelModelDownload : stop an in-flight download
 *   - voice.selectModel      : persist the active selection
 * Progress arrives on `voice:downloadProgress` (percentage across the model).
 */
import type { IpcMain } from "electron";
import {
  IPC,
  VoiceStartSchema,
  VoiceFeedSchema,
  VoiceStopSchema,
  VoiceCancelSchema,
  VoiceDownloadModelSchema,
  GetVoiceModelDirSchema,
  SetVoiceModelDirSchema,
  type VoiceDownloadProgressPayload,
} from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import { sendToRenderer } from "@main/window.js";
import {
  listModels,
  downloadModel,
  cancelDownload,
  setSelectedModel,
  setDownloadProgressListener,
  getModelDirInfo,
  setCustomModelRoot,
  removeLocalModel,
} from "@main/voice/models.js";
import {
  setVoiceResultListener,
  startSession,
  feedPcm,
  stopSession,
  cancelSession,
  warmupRecognizer,
  resetRecognizerCache,
} from "@main/voice/speechRecognizer.js";

/** Wire the ASR engine's live results + model download progress into renderer
 *  pushes. Called once at registration. */
function wirePushes(): void {
  setVoiceResultListener(({ sessionId, kind, text }) => {
    sendToRenderer(IPC.VOICE_RESULT, { channel: IPC.VOICE_RESULT, sessionId, kind, text });
  });
  setDownloadProgressListener((p: VoiceDownloadProgressPayload) => {
    sendToRenderer(IPC.VOICE_DOWNLOAD_PROGRESS, { channel: IPC.VOICE_DOWNLOAD_PROGRESS, ...p });
  });
}

export function registerVoiceHandlers(ipcMain: IpcMain): void {
  wirePushes();

  // Warm the ASR engine in the background so the first mic click doesn't
  // wait on the model load. No-op when no model is selected / already built.
  // Delayed past the boot window: the (synchronous) ONNX load otherwise
  // competes with first paint — observed delaying ready-to-show past its 3s
  // timeout. An earlier first click still works, it just pays the load.
  setTimeout(() => warmupRecognizer(), 8000);

  ipcMain.handle(IPC.VOICE_START, async (_evt, raw) => {
    const input = VoiceStartSchema.parse(raw);
    await startSession(input.sessionId, input.lang, input.engine);
  });

  ipcMain.handle(IPC.VOICE_FEED, (_evt, raw) => {
    const input = VoiceFeedSchema.parse(raw);
    // The schema accepts both wire forms; normalize once here so feedPcm (the
    // hot path, ~4×/s while listening) never re-copies an already-typed array.
    feedPcm(
      input.sessionId,
      input.pcm instanceof Float32Array ? input.pcm : Float32Array.from(input.pcm),
    );
  });

  ipcMain.handle(IPC.VOICE_STOP, (_evt, raw) => {
    const input = VoiceStopSchema.parse(raw);
    return stopSession(input.sessionId);
  });

  ipcMain.handle(IPC.VOICE_CANCEL, (_evt, raw) => {
    const input = VoiceCancelSchema.parse(raw);
    cancelSession(input.sessionId);
  });

  // ── Model management (Settings → 语音输入) ──
  ipcMain.handle(IPC.VOICE_MODEL_LIST, () => {
    warmupRecognizer(); // panel opened — good moment to prime the engine
    return listModels();
  });

  ipcMain.handle(IPC.VOICE_DOWNLOAD_MODEL, (_evt, raw) => {
    const input = VoiceDownloadModelSchema.parse(raw);
    // Fire-and-forget: progress + final status flow through the push channel.
    // A completed download (auto-selected on first success) warms the engine.
    void downloadModel(input.modelId)
      .then(() => warmupRecognizer())
      .catch(() => {});
  });

  ipcMain.handle(IPC.VOICE_CANCEL_MODEL_DOWNLOAD, (_evt, raw) => {
    const input = VoiceDownloadModelSchema.parse(raw);
    cancelDownload(input.modelId);
  });

  ipcMain.handle(IPC.VOICE_SELECT_MODEL, (_evt, raw) => {
    const input = VoiceDownloadModelSchema.parse(raw);
    setSelectedModel(input.modelId);
    warmupRecognizer(); // selection may have switched the engine's model
  });

  ipcMain.handle(IPC.VOICE_REMOVE_MODEL, (_evt, raw) => {
    const input = VoiceDownloadModelSchema.parse(raw);
    removeLocalModel(input.modelId);
    // The cached recognizer may have been built on the deleted files.
    resetRecognizerCache();
    warmupRecognizer(); // rebuild if another model is still selected
  });

  ipcMain.handle(IPC.VOICE_GET_MODEL_DIR, (_evt, raw) => {
    GetVoiceModelDirSchema.parse(raw);
    return getModelDirInfo();
  });

  ipcMain.handle(IPC.VOICE_SET_MODEL_DIR, (_evt, raw) => {
    const input = SetVoiceModelDirSchema.parse(raw);
    const result = setCustomModelRoot(input.modelDir);
    // The recognizer may have been built on the old root; drop it so the
    // next start rebuilds against whatever's at the new location.
    resetRecognizerCache();
    warmupRecognizer();
    return result;
  });

  log.info("[voice] handlers registered");
}