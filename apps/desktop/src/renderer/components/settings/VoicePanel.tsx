/**
 * "语音输入" (Voice Input) settings panel.
 *
 * The one stop for everything voice-dictation:
 *  - 语音识别模型 (SettingsSection): the downloadable on-device ASR catalog.
 *    Cards come from `api.voice.modelList` (catalog + downloaded set + the
 *    active selection). Download streams from HuggingFace in the main process
 *    with live progress on `voice:downloadProgress`; a completed download is
 *    activated via `voice.selectModel` (first download auto-selects).
 *  - 麦克风 (SettingsSection): default capture mode (continuous / hold-to-talk)
 *    + recognition language, persisted through the session store.
 *
 * The composer mic button deep-links here (`setSettingsOpen(true, "voice")`)
 * when recognition fails because no model is selected.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Select, Button } from "@renderer/components/ui/index.js";
import { SettingRow } from "./SettingRow.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import type {
  VoiceInputMode,
  VoiceModelInfo,
  VoiceDownloadProgressPayload,
} from "@contracts/ipc";
import {
  IconMicrophone,
  IconDownload,
  IconPlayerStop,
  IconCheck,
  IconLoader2,
  IconAlertTriangle,
  IconTrash,
  IconFolder,
  IconFolderOpen,
  IconRefresh,
} from "@renderer/lib/icons.js";

/** Shape of `voice.modelList`. */
interface ModelListState {
  models: VoiceModelInfo[];
  downloaded: string[];
  /** "" / null = nothing selected yet. */
  selected: string | null;
  /** Active model root (default or custom). */
  modelDir: string;
  isCustom: boolean;
}

export function VoicePanel() {
  const { t } = useI18n();

  // ── Mic capture preferences (moved here from GeneralPanel) ──
  const voiceInputMode = useSessionStore((s) => s.voiceInputMode);
  const setVoiceInputMode = useSessionStore((s) => s.setVoiceInputMode);
  const voiceLang = useSessionStore((s) => s.voiceLang);
  const setVoiceLang = useSessionStore((s) => s.setVoiceLang);

  // ── Model catalog + selection ──
  const [list, setList] = useState<ModelListState | null>(null);
  const [progress, setProgress] = useState<
    Record<string, VoiceDownloadProgressPayload>
  >({});

  const reload = useCallback(() => {
    void api.voice
      .modelList()
      .then((res) => setList(res))
      .catch(() => {
        /* desktop engine not ready — the empty catalog state shows */
      });
  }, []);

  useEffect(() => reload(), [reload]);

  // Live download progress; terminal stages (done/error/cancelled) re-list so
  // the downloaded set + selection reflect reality (listModels rescans disk).
  useEffect(
    () =>
      api.on.voiceDownloadProgress((msg) => {
        setProgress((prev) => ({ ...prev, [msg.modelId]: msg }));
        if (msg.stage !== "downloading") reload();
      }),
    [reload],
  );

  const handleDownload = (modelId: string) => {
    void api.voice.downloadModel({ modelId }).catch(() => {});
  };
  const handleCancel = (modelId: string) => {
    void api.voice.cancelModelDownload({ modelId }).catch(() => {});
  };
  const handleSelect = (modelId: string) => {
    void api.voice
      .selectModel({ modelId })
      .then(reload)
      .catch(() => {});
  };
  const handleRemove = (model: VoiceModelInfo) => {
    if (
      !window.confirm(
        `${t("settings.voice.modelDeleteConfirm")}\n\n${model.name} (${model.sizeLabel})`,
      )
    ) {
      return;
    }
    void api.voice
      .removeModel({ modelId: model.id })
      .then(reload)
      .catch((err: unknown) => {
        useToastStore.getState().push({
          kind: "warning",
          title: t("settings.voice.modelDeleteFailed"),
          body: String((err as Error)?.message ?? err),
        });
      });
  };

  const handlePickModelDir = async () => {
    const picked = await api.pickFolder().catch(() => ({ path: null }));
    const path = picked?.path;
    if (!path) return;
    try {
      const res = await api.voice.setModelDir({ modelDir: path });
      setList((prev) =>
        prev
          ? {
              ...prev,
              modelDir: res.modelDir,
              isCustom: res.isCustom,
              downloaded: res.downloaded,
            }
          : prev,
      );
      reload();
      useToastStore.getState().push({
        kind: "info",
        title: t("settings.voice.modelDirChanged"),
        body: res.modelDir,
      });
    } catch (err) {
      useToastStore.getState().push({
        kind: "warning",
        title: t("settings.voice.modelDirChangeFailed"),
        body: String((err as Error)?.message ?? err),
      });
    }
  };
  const handleResetModelDir = async () => {
    try {
      const res = await api.voice.setModelDir({ modelDir: "" });
      setList((prev) =>
        prev
          ? {
              ...prev,
              modelDir: res.modelDir,
              isCustom: res.isCustom,
              downloaded: res.downloaded,
            }
          : prev,
      );
      reload();
    } catch (err) {
      useToastStore.getState().push({
        kind: "warning",
        title: t("settings.voice.modelDirChangeFailed"),
        body: String((err as Error)?.message ?? err),
      });
    }
  };

  const selected = list?.selected ?? "";

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader
        title={t("settings.voice.title")}
        desc={t("settings.voice.desc")}
        icon={IconMicrophone}
      />

      {/* ── 语音识别模型 ── */}
      <SettingsSection
        title={t("settings.voice.sectionModels")}
        desc={t("settings.voice.sectionModelsDesc")}
      >
        {!list ? (
          <div className="flex items-center justify-center gap-2 px-4 py-8 text-[0.85em] text-content-subtle">
            <IconLoader2 size={14} className="animate-spin" />
            {t("settings.voice.loading")}
          </div>
        ) : (
          list.models.map((m) => (
            <ModelCard
              key={m.id}
              model={m}
              downloaded={list.downloaded.includes(m.id)}
              selected={selected === m.id}
              progress={progress[m.id]}
              onDownload={handleDownload}
              onCancel={handleCancel}
              onSelect={handleSelect}
              onRemove={handleRemove}
            />
          ))
        )}
        {list && !selected && (
          <div className="px-4 py-2.5 text-[0.7857em] text-content-subtle">
            {t("settings.voice.noModelSelected")}
          </div>
        )}

        {/* Storage location — defaults to userData, or any absolute
            path the user picks. Re-scanning picks up catalog models
            already present in the new directory (no re-download). */}
        {list && (
          <SettingRow
            title={t("settings.voice.modelDirTitle")}
            desc={t("settings.voice.modelDirDesc")}
            controlAlign="start"
            layout="vertical"
          >
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
              <code
                className="flex min-w-0 flex-1 items-center gap-2 truncate rounded border border-edge bg-surface-muted px-3 py-1.5 font-mono text-[0.7857em] text-content"
                title={list.modelDir}
              >
                <IconFolder size={14} className="shrink-0 text-content-subtle" />
                <span className="truncate">{list.modelDir}</span>
                {list.isCustom && (
                  <span className="ml-auto shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[0.7rem] font-medium text-accent">
                    {t("settings.voice.modelDirCustom")}
                  </span>
                )}
              </code>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handlePickModelDir}
                  title={t("settings.voice.modelDirPick")}
                >
                  <IconFolderOpen size={13} />
                  {t("settings.voice.modelDirPick")}
                </Button>
                {list.isCustom && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleResetModelDir}
                    title={t("settings.voice.modelDirReset")}
                    aria-label={t("settings.voice.modelDirReset")}
                  >
                    <IconRefresh size={14} />
                  </Button>
                )}
              </div>
            </div>
          </SettingRow>
        )}
      </SettingsSection>

      {/* ── 麦克风 ── */}
      <SettingsSection title={t("settings.voice.sectionMic")}>
        <SettingRow
          title={t("settings.voice.mode")}
          desc={t("settings.voice.modeDesc")}
          htmlFor="setting-voice-mode"
        >
          <Select.Root
            value={voiceInputMode}
            onValueChange={(v) => void setVoiceInputMode(v as VoiceInputMode)}
          >
            <Select.Trigger id="setting-voice-mode" className="min-w-[10rem]">
              <Select.Value>
                {(val: VoiceInputMode) =>
                  val === "pushToTalk"
                    ? t("settings.voice.modePush")
                    : t("settings.voice.modeContinuous")
                }
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    <Select.Item value="continuous">
                      <Select.ItemText>
                        {t("settings.voice.modeContinuous")}
                      </Select.ItemText>
                    </Select.Item>
                    <Select.Item value="pushToTalk">
                      <Select.ItemText>
                        {t("settings.voice.modePush")}
                      </Select.ItemText>
                    </Select.Item>
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>

        <SettingRow
          title={t("settings.voice.lang")}
          desc={t("settings.voice.langDesc")}
          htmlFor="setting-voice-lang"
        >
          <Select.Root
            value={voiceLang}
            onValueChange={(v) => void setVoiceLang(v as string)}
          >
            <Select.Trigger id="setting-voice-lang" className="min-w-[10rem]">
              <Select.Value>
                {(val: string) =>
                  val === "en-US"
                    ? t("settings.voice.langEn")
                    : t("settings.voice.langZh")
                }
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    <Select.Item value="zh-CN">
                      <Select.ItemText>
                        {t("settings.voice.langZh")}
                      </Select.ItemText>
                    </Select.Item>
                    <Select.Item value="en-US">
                      <Select.ItemText>
                        {t("settings.voice.langEn")}
                      </Select.ItemText>
                    </Select.Item>
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>
      </SettingsSection>
    </section>
  );
}

/** One catalog model: name + language + size on the left, download/use
 *  controls + live progress bar on the right. */
function ModelCard({
  model,
  downloaded,
  selected,
  progress,
  onDownload,
  onCancel,
  onSelect,
  onRemove,
}: {
  model: VoiceModelInfo;
  downloaded: boolean;
  selected: boolean;
  progress?: VoiceDownloadProgressPayload;
  onDownload: (modelId: string) => void;
  onCancel: (modelId: string) => void;
  onSelect: (modelId: string) => void;
  onRemove: (model: VoiceModelInfo) => void;
}) {
  const { t } = useI18n();
  const downloading = progress?.stage === "downloading";

  const statusKey: MessageId | null = selected
    ? "settings.voice.modelSelected"
    : downloaded
      ? "settings.voice.modelDownloaded"
      : null;

  /** "12.3 / 50.6 MB" while the current file streams (only when its
   *  Content-Length is known); bare percent otherwise. */
  const bytesLabel =
    downloading && progress?.fileTotalBytes
      ? ` · ${formatBytes(progress.fileBytes)} / ${formatBytes(progress.fileTotalBytes)}`
      : "";

  return (
    <SettingRow
      title={model.name}
      desc={
        <span>
          {model.langLabel} · {model.sizeLabel}
          {statusKey && (
            <span className="ml-1.5 text-content-subtle">
              · {t(statusKey)}
            </span>
          )}
        </span>
      }
      descExtra={
        progress?.stage === "error" ? (
          <div
            className="flex items-center gap-1.5 text-[0.7857em] text-danger"
            role="alert"
          >
            <IconAlertTriangle size={13} className="shrink-0" />
            <span className="truncate" title={progress.error}>
              {progress.error ?? t("settings.voice.modelDownloadFailed")}
            </span>
          </div>
        ) : undefined
      }
      controlAlign="start"
    >
      {downloading ? (
        <div className="flex w-44 flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[0.7857em] tabular-nums text-content-subtle">
              {t("settings.voice.modelDownloading", {
                percent: progress?.percent ?? 0,
              })}
              {bytesLabel}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onCancel(model.id)}
              aria-label={t("settings.voice.modelCancel")}
              title={t("settings.voice.modelCancel")}
            >
              <IconPlayerStop size={14} />
            </Button>
          </div>
          <div className="h-1 w-full overflow-hidden rounded bg-surface-muted">
            <div
              className="h-full rounded bg-accent transition-[width] duration-200"
              style={{ width: `${progress?.percent ?? 0}%` }}
            />
          </div>
        </div>
      ) : selected ? (
        <span className="inline-flex items-center gap-1 text-[0.7857em] font-medium text-accent">
          <IconCheck size={14} />
          {t("settings.voice.modelSelected")}
        </span>
      ) : downloaded ? (
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="sm" onClick={() => onSelect(model.id)}>
            <IconCheck size={13} />
            {t("settings.voice.modelUse")}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onRemove(model)}
            aria-label={t("settings.voice.modelDelete")}
            title={t("settings.voice.modelDelete")}
          >
            <IconTrash size={14} />
          </Button>
        </div>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => onDownload(model.id)}>
          <IconDownload size={13} />
          {t("settings.voice.modelDownload")}
        </Button>
      )}
    </SettingRow>
  );
}

/** Bytes → human MB (1 decimal); bytes stay bytes below 1 MB. */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
