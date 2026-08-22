/**
 * UpdateNotification - global bottom-right update notice card.
 *
 * Mounted once at the app root (App.tsx), inside the same fixed corner
 * container as the toast stack so the two never overlap. Shows up when the
 * main process's background check (boot + 10s, then every 4h) discovers a new
 * release — until now that push was only consumed by the About panel, which
 * is mounted only while the settings page is open.
 *
 * Platform flows:
 *  - Windows: "new version" card → user confirms → in-app download with a
 *    live progress bar → "restart & install" (autoInstallOnAppQuit backs up a
 *    dismissed install prompt).
 *  - macOS: the shipped app is ad-hoc signed, so Squirrel.Mac can never
 *    auto-install — the card goes straight to "download from the releases
 *    page" (`manualInstallRequired` is detected at discovery time, before any
 *    bytes are wasted on an in-app download).
 *
 * Anti-noise rules ("good UX" requirements):
 *  - Only reacts to `source === "auto"` checks; a manual check from the About
 *    panel means the user is already looking at that panel's banner.
 *  - Skips when the settings overlay is open (same reason).
 *  - Pops at most once per app run — the 4h recurring check re-discovering the
 *    same version stays silent. "稍后" dismisses until the next launch.
 *  - Download-progress/downloaded events are only consumed for downloads this
 *    card initiated (About-panel-initiated downloads keep their panel banner).
 *  - Dismissing the card mid-download does NOT cancel the download; when it
 *    completes the card returns once with the install prompt.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { formatBytes, formatSpeed } from "@renderer/lib/format.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { isWindows } from "@renderer/lib/platform.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button } from "@renderer/components/ui/index.js";
import {
  IconDownload,
  IconExternalLink,
  IconRocket,
  IconX,
} from "@renderer/lib/icons.js";

/** GitHub Releases latest URL — where macOS users land for a manual download
 *  (ad-hoc signature, Squirrel.Mac can't auto-install). */
const RELEASES_URL = "https://github.com/huangbh2020/mcode/releases/latest";

/** Update flow state shown by the card. `hidden` = nothing to say. */
type NoticeState =
  | { kind: "hidden" }
  | { kind: "available"; version: string; manualInstallRequired: boolean }
  | {
      kind: "downloading";
      version: string;
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }
  | { kind: "downloaded"; version: string; manualInstallRequired: boolean };

export function UpdateNotification() {
  const { t } = useI18n();
  const [state, setState] = useState<NoticeState>({ kind: "hidden" });
  /** Whether this run already auto-popped for a background discovery — the 4h
   *  recurring check must not re-notify for the same pending version. */
  const autoNotifiedRef = useRef(false);
  /** Whether the current download was started from this card (vs the About
   *  panel). Gates progress/downloaded handling so the two UIs don't fight. */
  const cardInitiatedDownloadRef = useRef(false);

  useEffect(() => {
    const offAvailable = api.on.updateAvailable((msg) => {
      // Manual checks come from the About panel, which renders its own banner
      // — popping a corner card on top of it would be redundant.
      if (msg.source !== "auto") return;
      if (autoNotifiedRef.current) return;
      // Settings overlay open = the About banner is (a click away from being)
      // on screen; let it carry the news.
      if (useSessionStore.getState().settingsOpen) return;
      autoNotifiedRef.current = true;
      cardInitiatedDownloadRef.current = false;
      setState({
        kind: "available",
        version: msg.version,
        manualInstallRequired: msg.manualInstallRequired ?? false,
      });
    });
    const offProgress = api.on.updateDownloadProgress((msg) => {
      // Only track downloads this card owns; About-panel downloads update the
      // panel's own banner via the same event.
      setState((prev) =>
        prev.kind === "downloading"
          ? {
              kind: "downloading",
              version: prev.version,
              percent: msg.percent,
              transferred: msg.transferred,
              total: msg.total,
              bytesPerSecond: msg.bytesPerSecond,
            }
          : prev,
      );
    });
    const offDownloaded = api.on.updateDownloaded((msg) => {
      if (!cardInitiatedDownloadRef.current) return;
      // Re-show even if the user closed the progress card — the install
      // decision is a state change worth surfacing exactly once.
      setState({
        kind: "downloaded",
        version: msg.version,
        manualInstallRequired: msg.manualInstallRequired ?? false,
      });
    });
    return () => {
      offAvailable();
      offProgress();
      offDownloaded();
    };
  }, []);

  if (state.kind === "hidden") return null;

  const dismiss = () => setState({ kind: "hidden" });

  const openReleases = () => {
    window.open(RELEASES_URL, "_blank", "noopener,noreferrer");
    dismiss();
  };

  const onDownload = async () => {
    if (state.kind !== "available") return;
    cardInitiatedDownloadRef.current = true;
    setState({
      kind: "downloading",
      version: state.version,
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
    });
    try {
      await api.app.downloadUpdate();
      // update:downloadProgress refreshes percent/bytes; update:downloaded
      // moves us to "downloaded".
    } catch {
      // downloadUpdate re-throws on failure — fall back to the available card
      // so the user can retry instead of staring at a dead progress bar.
      cardInitiatedDownloadRef.current = false;
      setState(state);
    }
  };

  const onQuitAndInstall = async () => {
    try {
      await api.app.quitAndInstall();
    } catch {
      // Install failed; the app is still running — keep the card as is.
    }
  };

  const showProgress = state.kind === "downloading";

  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto w-80 rounded-md border border-edge border-l-2 border-l-accent bg-surface px-3 py-2.5 shadow-lg",
        "animate-[home-fade-up_160ms_ease-out]",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="mt-0.5 min-w-0 flex-1">
          {showProgress ? (
            <DownloadingContent state={state} />
          ) : state.kind === "downloaded" ? (
            <DownloadedContent state={state} />
          ) : (
            <AvailableContent state={state} />
          )}
        </div>
        <button
          onClick={dismiss}
          className="shrink-0 rounded p-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
          aria-label={t("common.close")}
        >
          <IconX size={14} />
        </button>
      </div>

      {!showProgress && (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          {state.kind === "available" ? (
            // Windows (or any auto-installable build): confirm → in-app download.
            // macOS ad-hoc: straight to the releases page, no wasted download.
            state.manualInstallRequired || !isWindows ? (
              <>
                <Button variant="ghost" size="sm" onClick={dismiss}>
                  {t("settings.update.remindLater")}
                </Button>
                <Button variant="primary" size="sm" onClick={openReleases} className="gap-1.5">
                  <IconExternalLink size={14} />
                  {t("settings.update.goToDownload")}
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={dismiss}>
                  {t("settings.update.remindLater")}
                </Button>
                <Button variant="primary" size="sm" onClick={() => void onDownload()} className="gap-1.5">
                  <IconDownload size={14} />
                  {t("settings.update.downloadNow")}
                </Button>
              </>
            )
          ) : state.kind === "downloaded" ? (
            state.manualInstallRequired ? (
              <Button variant="primary" size="sm" onClick={openReleases} className="gap-1.5">
                <IconExternalLink size={14} />
                {t("settings.update.goToDownload")}
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={dismiss}>
                  {t("settings.update.remindLater")}
                </Button>
                <Button variant="primary" size="sm" onClick={() => void onQuitAndInstall()} className="gap-1.5">
                  <IconRocket size={14} />
                  {t("settings.about.restartInstall")}
                </Button>
              </>
            )
          ) : null}
        </div>
      )}
    </div>
  );
}

/** "New version discovered" title + platform-appropriate body. */
function AvailableContent({ state }: { state: Extract<NoticeState, { kind: "available" }> }) {
  const { t } = useI18n();
  const body =
    state.manualInstallRequired || !isWindows
      ? t("settings.update.availableBodyManual")
      : t("settings.update.availableBodyWin");
  return (
    <>
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-content">
        <IconDownload size={15} className="shrink-0 text-accent" />
        {t("settings.update.availableTitle", { version: state.version })}
      </div>
      <div className="mt-0.5 text-[12px] leading-relaxed text-content-muted">{body}</div>
    </>
  );
}

/** Download-in-progress: percent + byte counter + speed + progress bar. */
function DownloadingContent({ state }: { state: Extract<NoticeState, { kind: "downloading" }> }) {
  const { t } = useI18n();
  const percent = Math.min(100, Math.max(0, state.percent));
  const bytesText =
    state.total > 0
      ? `${formatBytes(state.transferred)} / ${formatBytes(state.total)}`
      : formatBytes(state.transferred);
  const speedText = state.bytesPerSecond > 0 ? ` · ${formatSpeed(state.bytesPerSecond)}` : "";
  return (
    <>
      <div className="text-[13px] font-medium text-content">
        {t("settings.update.downloadingTitle", { version: state.version })}
      </div>
      <div className="mt-1 tabular-nums text-[11px] text-content-muted">
        {percent.toFixed(0)}% · {bytesText}
        {speedText}
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    </>
  );
}

/** Download finished: prompt restart (or manual download as a fallback). */
function DownloadedContent({ state }: { state: Extract<NoticeState, { kind: "downloaded" }> }) {
  const { t } = useI18n();
  return (
    <>
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-content">
        <IconRocket size={15} className="shrink-0 text-accent" />
        {t("settings.update.downloadedTitle", { version: state.version })}
      </div>
      <div className="mt-0.5 text-[12px] text-content-muted">{t("settings.update.downloadedBody")}</div>
    </>
  );
}
