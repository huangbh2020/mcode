/**
 * Voice model management: catalog resolution, downloading and selection.
 *
 * Models are NOT bundled with the app. The user downloads them from the
 * Settings → 语音输入 → 下载语言模型 panel; this module streams the files from
 * the catalog's HuggingFace URLs into `userData/models/voice/<dir>/` and
 * reports progress over the `voice:downloadProgress` push. Once downloaded,
 * the user selects a model; the composer mic button then uses it (the engine
 * resolves the selected model's directory at `voice.start`).
 *
 * State is persisted in the `settings` table:
 *   - ui.voiceModel (selected model id, "" = none)
 *   - ui.voiceDownloadedModels (JSON array of completed model ids)
 */
import { app } from "electron";
import {
  mkdirSync,
  existsSync,
  createWriteStream,
  statSync,
  renameSync,
  rmSync,
  unlinkSync,
  accessSync,
  constants as fsConstants,
} from "node:fs";
import { once } from "node:events";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  VOICE_MODEL_CATALOG,
  UI_VOICE_MODEL_DIR_SETTING_KEY,
  UI_VOICE_MODEL_SETTING_KEY,
  UI_VOICE_DOWNLOADED_MODELS_SETTING_KEY,
  type VoiceModelInfo,
  type VoiceDownloadProgressPayload,
} from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import { SettingRepo } from "@main/store/repositories.js";

/** Default root when the user hasn't customized the path: `<userData>/models/voice`. */
function defaultModelRoot(): string {
  return join(app.getPath("userData"), "models", "voice");
}

/** Read the user-customized root, or `null` when none is set. The empty
 *  string is treated as "use default" so persisted "reset" choices round-trip
 *  safely. A stored path that no longer exists is also treated as unset —
 *  otherwise voice.start would throw a confusing "no model selected" error
 *  instead of falling back to a working location. */
export function customModelRoot(): string | null {
  const raw = SettingRepo.get(UI_VOICE_MODEL_DIR_SETTING_KEY);
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!isAbsolute(trimmed)) return null;
  if (!existsSync(trimmed)) return null;
  try {
    accessSync(trimmed, fsConstants.W_OK);
  } catch {
    return null;
  }
  return trimmed;
}

/** The effective root used by every read/write of model files. Customized
 *  when set, otherwise the default under userData. */
export function voiceModelRoot(): string {
  return customModelRoot() ?? defaultModelRoot();
}

/** Public, used by the IPC layer to render the Settings row. */
export function getModelDirInfo(): { modelDir: string; isCustom: boolean } {
  const custom = customModelRoot();
  return {
    modelDir: custom ?? defaultModelRoot(),
    isCustom: custom !== null,
  };
}

/** Validate + persist a new model root. Empty string resets to the default.
 *  Throws a human-readable error on bad input; the caller's UI surfaces it
 *  directly in a toast. The user's `ui.voiceModel` selection is left alone —
 *  the caller runs {@link scanPresentModels} afterwards and adjusts if the
 *  previously-selected model isn't there. */
export function setCustomModelRoot(raw: string): { modelDir: string; isCustom: boolean; downloaded: string[] } {
  const trimmed = raw.trim();
  // Reset case
  if (!trimmed) {
    SettingRepo.set(UI_VOICE_MODEL_DIR_SETTING_KEY, "");
    return {
      modelDir: defaultModelRoot(),
      isCustom: false,
      downloaded: scanPresentModels(),
    };
  }
  if (!isAbsolute(trimmed)) {
    throw new Error("路径必须是绝对路径。");
  }
  // Reject the userData root itself — that's where app data lives, not models.
  const userData = resolve(app.getPath("userData"));
  const target = resolve(trimmed);
  if (target === userData || target.startsWith(userData + sep)) {
    // Allow only the legacy default `userData/models/voice` and its subdirs;
    // anything higher up under userData would invite accidental wipe of prefs.
    if (target !== resolve(defaultModelRoot()) && !target.startsWith(resolve(defaultModelRoot()) + sep)) {
      throw new Error("请选择 userData 之外的目录作为模型存储位置。");
    }
  }
  // Reject the OS root / drive root. rmdir there is a disaster.
  if (process.platform === "win32") {
    if (/^[a-zA-Z]:[\\/]?$/.test(target)) {
      throw new Error("不能选择驱动器根目录。");
    }
  } else if (target === sep) {
    throw new Error("不能选择文件系统根目录。");
  }
  if (!existsSync(target)) {
    throw new Error("目录不存在,请先创建它。");
  }
  try {
    accessSync(target, fsConstants.W_OK);
  } catch {
    throw new Error("目录不可写,请换一个位置。");
  }
  SettingRepo.set(UI_VOICE_MODEL_DIR_SETTING_KEY, target);
  // Re-scan the new root. Any catalog model already present is auto-detected;
  // we DO NOT auto-move files from the old root — that's a separate, explicit
  // action (or a future "迁移" feature) so the user always knows where bytes
  // are landing.
  return {
    modelDir: target,
    isCustom: true,
    downloaded: scanPresentModels(),
  };
}

/** Resolve a catalog model id → its absolute on-disk directory. */
export function modelDirFor(modelId: string): string {
  const info = VOICE_MODEL_CATALOG.find((m) => m.id === modelId);
  return join(voiceModelRoot(), info?.dir ?? modelId);
}

/** The currently selected model id ("" when none). */
export function selectedModelId(): string {
  return SettingRepo.get(UI_VOICE_MODEL_SETTING_KEY) ?? "";
}

/** Persist the active model selection. */
export function setSelectedModel(modelId: string): void {
  SettingRepo.set(UI_VOICE_MODEL_SETTING_KEY, modelId);
}

/** Read the persisted list of downloaded model ids (JSON array). */
export function downloadedModelIds(): string[] {
  try {
    const raw = SettingRepo.get(UI_VOICE_DOWNLOADED_MODELS_SETTING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Persist the list of downloaded model ids. */
export function setDownloadedModelIds(ids: string[]): void {
  SettingRepo.set(UI_VOICE_DOWNLOADED_MODELS_SETTING_KEY, JSON.stringify(ids));
}

/** Rescan the on-disk model dir: ids whose required files are all present. */
function scanPresentModels(): string[] {
  const root = voiceModelRoot();
  const present: string[] = [];
  for (const info of VOICE_MODEL_CATALOG) {
    const dir = modelDirFor(info.id);
    const complete = info.files.every((f) => existsSync(join(dir, f.rel)));
    if (complete) present.push(info.id);
  }
  // Sync the persisted list with reality (a partial download that was never
  // finished shouldn't show as "downloaded").
  const prev = downloadedModelIds();
  const merged = Array.from(new Set([...present, ...prev.filter((id) => {
    const info = VOICE_MODEL_CATALOG.find((m) => m.id === id);
    return info && info.files.every((f) => existsSync(join(modelDirFor(id), f.rel)));
  })]));
  if (merged.join(",") !== prev.join(",")) setDownloadedModelIds(merged);
  return merged;
}

/** Progress listener — wired once by the IPC layer. */
type ProgressListener = (p: VoiceDownloadProgressPayload) => void;
let onProgress: ProgressListener | null = null;
export function setDownloadProgressListener(fn: ProgressListener | null): void {
  onProgress = fn;
}
function emit(p: VoiceDownloadProgressPayload): void {
  onProgress?.(p);
}

/* huggingface.co is unreachable from some networks (notably mainland China) —
 * `fetch failed` with no useful detail. Every catalog URL lives on HF, so on
 * failure retry the same path from the hf-mirror.com reverse proxy (same
 * paths) and remember the origin that worked for the rest of the session. */
const HF_ORIGIN = "https://huggingface.co";
const HF_MIRROR_ORIGIN = "https://hf-mirror.com";
let preferredOrigin: string | null = null;

function urlWithOrigin(url: string, origin: string): string {
  return url.startsWith(HF_ORIGIN) ? origin + url.slice(HF_ORIGIN.length) : url;
}

/** Candidate URLs for one file: the proven origin first, the other second. */
function candidateUrls(url: string): string[] {
  const origins =
    preferredOrigin === HF_MIRROR_ORIGIN
      ? [HF_MIRROR_ORIGIN, HF_ORIGIN]
      : [HF_ORIGIN, HF_MIRROR_ORIGIN];
  return Array.from(new Set(origins.map((o) => urlWithOrigin(url, o))));
}

interface DownloadHandle {
  model: VoiceModelInfo;
  cancel: boolean;
  /** Aborts the in-flight HTTP transfer. Cooperative-only cancellation (the
   *  boolean flag) leaves a 50MB encoder download running to completion before
   *  the loop notices — abort is what makes 取消 instant. */
  abort: AbortController;
  done: Promise<void>;
}
const activeDownloads = new Map<string, DownloadHandle>();

/** Whether a download is currently in flight for `modelId`. */
export function isDownloading(modelId: string): boolean {
  return activeDownloads.has(modelId);
}

/** Ceiling on connect + waiting for response headers. Some unreachable hosts
 *  blackhole instead of refusing, which would hang a file download for
 *  minutes; the body stream is guarded separately by the stall timer below. */
const CONNECT_TIMEOUT_MS = 30_000;
/** Ceiling on a DRY body — no bytes for this long means the transfer died
 *  (half-open connection). Slow links are fine: every received chunk re-arms
 *  the timer. */
const STALL_TIMEOUT_MS = 60_000;

/** HEAD-probe every file's Content-Length so whole-model progress can be
 *  byte-weighted (the encoder is ~95% of the bytes; file-count weighting makes
 *  the bar sit still for minutes and then jump). Unknown sizes fall back to
 *  file-count weighting for that file. */
async function probeFileSizes(
  model: VoiceModelInfo,
  signal?: AbortSignal,
): Promise<(number | null)[]> {
  return Promise.all(
    model.files.map(async (f) => {
      for (const url of candidateUrls(f.url)) {
        if (signal?.aborted) return null;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        try {
          const res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
          // Follow the LFS redirect chain? fetch already followed it; the
          // final response carries the real length.
          const len = Number(res.headers.get("content-length") ?? 0);
          if (res.ok && len > 0) return len;
        } catch {
          /* try the next origin */
        } finally {
          clearTimeout(timer);
        }
      }
      return null;
    }),
  );
}

/** Download one model's files sequentially. Resolves when complete (or
 *  rejected on error / cancellation). Cancellation aborts the in-flight
 *  transfer immediately via the handle's AbortController. */
export function downloadModel(modelId: string): Promise<void> {
  const existing = activeDownloads.get(modelId);
  if (existing) return existing.done;

  const model = VOICE_MODEL_CATALOG.find((m) => m.id === modelId);
  if (!model) return Promise.reject(new Error(`unknown model: ${modelId}`));

  mkdirSync(voiceModelRoot(), { recursive: true });
  const dir = modelDirFor(modelId);
  mkdirSync(dir, { recursive: true });

  // The `done` promise is attached AFTER the handle object exists —
  // referencing `handle` inside a closure defined in its own initializer trips
  // TS2454 (used-before-assigned); by then it is definitely assigned.
  const handle: DownloadHandle = {
    model,
    cancel: false,
    abort: new AbortController(),
    done: Promise.resolve(),
  };
  handle.done = (async () => {
    log.info(`[voice] download start ${modelId}`);
    const fileCount = model.files.length;
    // Immediate 0% so the UI flips to its downloading state right away —
    // the size probe below can take a few seconds on slow links.
    emit({ modelId, stage: "downloading", percent: 0, fileIndex: 0, fileCount, fileBytes: 0 });
    const sizes = await probeFileSizes(model, handle.abort.signal);
    const bytesTotal = sizes.reduce<number>((a, b) => a + (b ?? 0), 0);
    let bytesDone = 0; // bytes of files completed so far
    const wholePercent = (extraBytes: number, fileIdx: number) =>
      bytesTotal > 0
        ? Math.min(
            99,
            Math.floor(((bytesDone + extraBytes) / bytesTotal) * 100),
          )
        : Math.round(((fileIdx + 0.5) / fileCount) * 100);
    for (let i = 0; i < fileCount; i++) {
      const f = model.files[i]!;
      if (handle.cancel) throw new Error("cancelled");
      const dest = join(dir, f.rel);
      if (existsSync(dest)) {
        // already downloaded (resume) — its size still counts toward progress
        bytesDone += statSync(dest).size;
        continue;
      }
      emit({
        modelId,
        stage: "downloading",
        percent: wholePercent(0, i),
        fileIndex: i,
        fileCount,
        fileBytes: 0,
        ...(sizes[i] ? { fileTotalBytes: sizes[i]! } : {}),
      });
      try {
        await downloadWithFallback(
          f.url,
          dest,
          (bytes, total) => {
            emit({
              modelId,
              stage: "downloading",
              percent: wholePercent(bytes, i),
              fileIndex: i,
              fileCount,
              fileBytes: bytes,
              ...(total > 0 ? { fileTotalBytes: total } : {}),
            });
          },
          handle.abort.signal,
        );
      } catch (err) {
        if (handle.cancel) throw new Error("cancelled");
        throw err;
      }
      bytesDone += statSync(dest).size;
    }
    // Persist as downloaded; auto-select on first successful download (when
    // nothing is selected yet) so the mic works out of the box.
    const ids = scanPresentModels();
    if (!ids.includes(modelId)) ids.push(modelId);
    setDownloadedModelIds(ids);
    if (!selectedModelId()) setSelectedModel(modelId);
    emit({ modelId, stage: "done", percent: 100, fileIndex: fileCount - 1, fileCount, fileBytes: 0 });
    log.info(`[voice] download done ${modelId}`);
  })().catch((err) => {
    const cancelled = handle.cancel || String(err?.message ?? err).toLowerCase().includes("cancel");
    emit({ modelId, stage: cancelled ? "cancelled" : "error", percent: 0, fileIndex: 0, fileCount: model.files.length, fileBytes: 0, error: cancelled ? undefined : String(err?.message ?? err) });
    throw err; // the renderer's invoke promise rejects too
  }).finally(() => {
    activeDownloads.delete(modelId);
  });
  activeDownloads.set(modelId, handle);
  return handle.done;
}

/** Cancel an in-flight download: flag the loop AND abort the live transfer. */
export function cancelDownload(modelId: string): void {
  const h = activeDownloads.get(modelId);
  if (!h) return;
  h.cancel = true;
  h.abort.abort();
}

/** List the model catalog + which are downloaded + the selection + the
 *  active model root (so the renderer can render the "存储位置" row). */
export function listModels(): {
  models: VoiceModelInfo[];
  downloaded: string[];
  selected: string;
  modelDir: string;
  isCustom: boolean;
} {
  const dir = getModelDirInfo();
  return {
    models: VOICE_MODEL_CATALOG,
    downloaded: scanPresentModels(),
    selected: selectedModelId(),
    modelDir: dir.modelDir,
    isCustom: dir.isCustom,
  };
}

/** Delete a downloaded model's local files. If the deleted model was the
 *  active selection, the selection re-points at another downloaded model (or
 *  clears). The caller is responsible for dropping a cached recognizer built
 *  on the deleted files (`resetRecognizerCache`). */
export function removeLocalModel(modelId: string): void {
  if (activeDownloads.has(modelId)) {
    throw new Error("模型正在下载中,无法删除。");
  }
  const model = VOICE_MODEL_CATALOG.find((m) => m.id === modelId);
  if (!model) throw new Error(`未知模型: ${modelId}`);
  const dir = modelDirFor(modelId);
  // Defense in depth: only ever rmdir inside the active voice-model root —
  // never let a custom root point somewhere arbitrary and let us walk it.
  const root = resolve(voiceModelRoot());
  const target = resolve(dir);
  if (
    target !== root &&
    target.startsWith(root + sep) &&
    existsSync(dir)
  ) {
    rmSync(dir, { recursive: true, force: true });
    log.info(`[voice] removed model files ${dir}`);
  } else if (existsSync(dir)) {
    // Path resolved outside the active root — refuse instead of recursively
    // nuking whatever happens to be at `dir`.
    log.warn(
      `[voice] refuse to remove ${target}: not under active root ${root}`,
    );
  }
  const ids = scanPresentModels().filter((id) => id !== modelId);
  setDownloadedModelIds(ids);
  if (selectedModelId() === modelId) {
    setSelectedModel(ids[0] ?? "");
  }
}

/** Download one file, retrying the mirror origin if the primary fetch fails.
 *  Remembers the origin that succeeded so later files skip the failed host.
 *  `onBytes` fires INCREMENTALLY (received-so-far, content-length when known)
 *  so the progress bar moves during multi-MB files, not only between them. */
async function downloadWithFallback(
  url: string,
  dest: string,
  onBytes: (bytes: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const candidates = candidateUrls(url);
  let lastErr: unknown = new Error("no download candidates");
  for (const candidate of candidates) {
    if (signal?.aborted) throw new Error("cancelled");
    try {
      await downloadToFile(candidate, dest, onBytes, signal);
      const origin = new URL(candidate).origin;
      if (origin !== preferredOrigin) {
        preferredOrigin = origin;
        log.info(`[voice] downloads now prefer ${origin}`);
      }
      return;
    } catch (err) {
      if (signal?.aborted) throw new Error("cancelled"); // don't retry the mirror
      lastErr = err;
      log.warn(
        `[voice] download failed via ${candidate}: ${String((err as Error)?.message ?? err)}`,
      );
    }
  }
  const detail = String((lastErr as Error)?.message ?? lastErr);
  throw new Error(
    candidates.length > 1
      ? `下载失败(已尝试 huggingface.co 与 hf-mirror.com 镜像): ${detail}`
      : `下载失败: ${detail}`,
  );
}

/** Stream `url` into `dest` atomically: write to `<dest>.part` and rename only
 *  on success, so an interrupted download can never leave a partial file that
 *  the resume/existence checks would mistake for a complete one.
 *
 *  Two abort paths fold into one controller: the caller's signal (user hit
 *  取消) and our own timers (connect timeout, dry-body stall). */
async function downloadToFile(
  url: string,
  dest: string,
  onBytes: (bytes: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const part = `${dest}.part`;
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  const connectTimer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
  let stallTimer: NodeJS.Timeout | undefined;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => ctrl.abort(new Error(`下载停滞(超过 ${STALL_TIMEOUT_MS / 1000}s 无数据)`)),
      STALL_TIMEOUT_MS,
    );
  };
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } catch (err) {
      if (signal?.aborted) throw new Error("cancelled");
      if (ctrl.signal.aborted) {
        throw new Error(
          `${ctrl.signal.reason instanceof Error ? ctrl.signal.reason.message : `连接超时(${CONNECT_TIMEOUT_MS / 1000}s 无响应)`}: ${url}`,
        );
      }
      throw err;
    }
    clearTimeout(connectTimer);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${url}`);
    const total = Number(res.headers.get("content-length") ?? 0);

    const reader = res.body.getReader();
    const ws = createWriteStream(part);
    let received = 0;
    armStall();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armStall();
      received += value.byteLength;
      onBytes(received, total);
      if (!ws.write(value)) await once(ws, "drain");
    }
    await new Promise<void>((resolveP, rejectP) =>
      ws.end((err: Error | null | undefined) => (err ? rejectP(err) : resolveP())),
    );
    renameSync(part, dest);
    // Report the final byte count so the last file's bar reaches the end.
    onBytes(statSync(dest).size, total);
  } catch (err) {
    try {
      unlinkSync(part);
    } catch {
      /* nothing to clean up */
    }
    if (signal?.aborted) throw new Error("cancelled");
    throw err;
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(stallTimer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Canonical subdir for model files (kept in sync with catalogs). Used by the
 *  engine to validate a downloaded model's completeness at `voice.start`. */
export function requireModelDir(modelId: string): string {
  const model = VOICE_MODEL_CATALOG.find((m) => m.id === modelId);
  if (!model) throw new Error(`未知模型: ${modelId}`);
  const dir = modelDirFor(modelId);
  const missing = model.files.find((f) => !existsSync(join(dir, f.rel)));
  if (missing) {
    throw new Error(`语音模型未下载或不完整:缺少 ${missing.rel}。请在设置中下载 "${model.name}" 后再试。`);
  }
  return dir;
}

/** A catalog model's files mapped to the sherpa-onnx transducer config roles. */
export interface TransducerModelFiles {
  tokens: string;
  encoder: string;
  decoder: string;
  joiner: string;
}

/** Map a model's catalog file list to config roles by filename prefix
 *  (files starting with "encoder" / "decoder" / "joiner" / "tokens") —
 *  decoupled from the epoch and quantization suffixes that vary across model
 *  releases, so the recognizer and the download catalog can't drift apart. */
export function transducerFilesFor(modelId: string): TransducerModelFiles {
  const model = VOICE_MODEL_CATALOG.find((m) => m.id === modelId);
  if (!model) throw new Error(`未知模型: ${modelId}`);
  const roles: Partial<TransducerModelFiles> = {};
  for (const f of model.files) {
    const base = f.rel.split(/[\\/]/).pop() ?? f.rel;
    if (base.startsWith("encoder")) roles.encoder = f.rel;
    else if (base.startsWith("decoder")) roles.decoder = f.rel;
    else if (base.startsWith("joiner")) roles.joiner = f.rel;
    else if (base.startsWith("tokens")) roles.tokens = f.rel;
  }
  const missing = (["tokens", "encoder", "decoder", "joiner"] as const).filter(
    (k) => !roles[k],
  );
  if (missing.length) {
    throw new Error(`模型文件清单不完整(缺少 ${missing.join("/")}): ${modelId}`);
  }
  return roles as TransducerModelFiles;
}

