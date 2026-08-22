import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { formatBytes } from "@renderer/lib/format.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button } from "@renderer/components/ui/index.js";
import {
  IconCopy,
  IconCheck,
  IconExternalLink,
  IconInfoCircle,
  IconDownload,
  IconRefresh,
  IconAlertTriangle,
  IconRocket,
  SiGithub,
} from "@renderer/lib/icons.js";
import {
  UPDATE_STATE_SETTING_KEY,
  type AppInfoResult,
  type CheckForUpdatesResult,
  type PersistedUpdateState,
} from "@contracts/ipc";

/**
 * About panel - app identity, runtime info, license, repo links, and update
 * checking.
 *
 * Pulls version + runtime info from the main process via the parameterless
 * `app.info` RPC (electron's `app.getVersion()` + `process.versions`). The
 * "检查更新" button triggers `app.checkForUpdates`; if a newer version exists
 * on the GitHub Releases channel, an `update:available` push event arrives and
 * the panel offers a download button. Once downloaded (`update:downloaded`),
 * a "重启安装" button calls `app.quitAndInstall`.
 *
 * The updater only runs in packaged builds; in dev every check short-circuits
 * to "up-to-date" so the button still works without erroring.
 */

/** App display name (matches the root package.json "name"). */
const APP_NAME = "Mcode";
/** GitHub repo URL. */
const REPO_URL = "https://github.com/huangbh2020/mcode";
/** GitHub Releases latest URL — where the user lands to manually download on
 *  macOS when Squirrel.Mac can't auto-install (ad-hoc signature). */
const RELEASES_URL = "https://github.com/huangbh2020/mcode/releases/latest";
/** SPDX license identifier. */
const LICENSE = "MIT";

/** Update flow state shown by the panel. */
type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; version: string }
  | { kind: "available"; version: string; manualInstallRequired: boolean }
  | { kind: "downloading"; percent: number; transferred: number; total: number }
  | { kind: "downloaded"; version: string; manualInstallRequired: boolean }
  | { kind: "error"; message: string };

/** Restore the in-memory UpdateState from a persisted snapshot (read on mount
 *  so reopening the About panel or restarting the app keeps the banner). */
function stateFromPersisted(persisted: PersistedUpdateState | null): UpdateState | null {
  if (!persisted) return null;
  if (persisted.status === "downloading") {
    return {
      kind: "downloading",
      percent: persisted.percent,
      transferred: persisted.transferred,
      total: persisted.total,
    };
  }
  if (persisted.status === "downloaded") {
    return {
      kind: "downloaded",
      version: persisted.version,
      manualInstallRequired: persisted.manualInstallRequired ?? false,
    };
  }
  return null;
}

/** Parse a persisted update-state JSON string, returning null on any error so
 *  a corrupt entry never breaks the panel. */
function safeParse(raw: string): PersistedUpdateState | null {
  try {
    const parsed = JSON.parse(raw) as PersistedUpdateState;
    if (parsed.status !== "downloading" && parsed.status !== "downloaded") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Human-readable OS label from the platform string. */
function platformLabel(platform: string): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform;
}

export function AboutPanel() {
  const { t } = useI18n();
  const [info, setInfo] = useState<AppInfoResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" });

  // Fetch runtime info once on mount. Failures (e.g. main not ready) leave the
  // version rows showing "-" rather than crashing the panel.
  useEffect(() => {
    let cancelled = false;
    void api.app.info().then((result) => {
      if (!cancelled) setInfo(result);
    }).catch(() => {
      // leave info null -> rows render "-"
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore the update banner from the persisted snapshot so reopening the
  // About panel (or restarting the app mid-download) keeps showing progress /
  // "ready to install" instead of dropping back to idle.
  useEffect(() => {
    let cancelled = false;
    void api.setting
      .get({ key: UPDATE_STATE_SETTING_KEY })
      .then(({ value }) => {
        if (cancelled) return;
        const restored = stateFromPersisted(value ? safeParse(value) : null);
        if (restored) setUpdateState(restored);
      })
      .catch(() => {
        // DB read failure is non-fatal; just leave state as idle.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to updater push events. update-available fires when the main
  // process finds a newer version (either from the boot check or a manual
  // check); update-downloadProgress carries live percent/byte counts;
  // update-downloaded fires once the download finishes.
  useEffect(() => {
    const offAvailable = api.on.updateAvailable((msg) => {
      setUpdateState({
        kind: "available",
        version: msg.version,
        // Known at discovery time on macOS (ad-hoc signature): guide the user
        // to the releases page right away instead of letting them download
        // ~100MB that Squirrel.Mac could never install.
        manualInstallRequired: msg.manualInstallRequired ?? false,
      });
    });
    const offProgress = api.on.updateDownloadProgress((msg) => {
      setUpdateState({
        kind: "downloading",
        percent: msg.percent,
        transferred: msg.transferred,
        total: msg.total,
      });
    });
    const offDownloaded = api.on.updateDownloaded((msg) => {
      setUpdateState({
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

  const versionText = info
    ? `${APP_NAME} v${info.appVersion} / Electron ${info.electron} / Node ${info.node} / Chromium ${info.chromium} / ${platformLabel(info.platform)} ${info.arch}`
    : `${APP_NAME}`;

  const onCopyVersion = async () => {
    try {
      await navigator.clipboard.writeText(versionText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable (sandbox); silently no-op.
    }
  };

  const openExternal = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const onCheckForUpdates = async () => {
    setUpdateState({ kind: "checking" });
    try {
      const result: CheckForUpdatesResult = await api.app.checkForUpdates();
      if (result.status === "up-to-date") {
        setUpdateState({ kind: "up-to-date", version: result.version });
      } else if (result.status === "available") {
        setUpdateState({
          kind: "available",
          version: result.version,
          manualInstallRequired: result.manualInstallRequired,
        });
      } else {
        setUpdateState({ kind: "error", message: result.error });
      }
    } catch (err) {
      setUpdateState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onDownloadUpdate = async () => {
    setUpdateState({ kind: "downloading", percent: 0, transferred: 0, total: 0 });
    try {
      await api.app.downloadUpdate();
      // update-downloadProgress events will refresh percent/bytes;
      // update-downloaded will move us to "downloaded".
    } catch (err) {
      setUpdateState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onQuitAndInstall = async () => {
    try {
      await api.app.quitAndInstall();
    } catch {
      // If install fails, the app is still running; leave the state as-is.
    }
  };

  /** macOS ad-hoc fallback: the update has been downloaded but Squirrel.Mac
   *  can't apply it, so open the releases page for a manual install. */
  const onGoToDownload = () => {
    openExternal(RELEASES_URL);
  };

  const rows: { label: string; value: string }[] = [
    { label: t("settings.about.version"), value: info ? `v${info.appVersion}` : "-" },
    { label: t("settings.about.license"), value: LICENSE },
    { label: "Electron", value: info?.electron ?? "-" },
    { label: "Node.js", value: info?.node ?? "-" },
    { label: "Chromium", value: info?.chromium ?? "-" },
    { label: t("settings.about.system"), value: info ? `${platformLabel(info.platform)} · ${info.arch}` : "-" },
  ];

  return (
    <section className="flex min-h-full flex-col items-center px-6 py-10">
      {/* App identity */}
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <div
          className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10 text-accent"
          aria-hidden
        >
          <SiGithub size={32} />
        </div>
        <h2 className="text-lg font-semibold text-content">{APP_NAME}</h2>
        <p className="mt-1.5 text-[0.8571em] leading-relaxed text-content-subtle">
          {t("settings.about.desc")}
        </p>
        {info && (
          <p className="mt-1 text-[0.7857em] tabular-nums text-content-muted">
            v{info.appVersion}
          </p>
        )}
      </div>

      {/* Runtime info rows */}
      <div className="mt-8 w-full max-w-md divide-y divide-edge rounded-lg border border-edge">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-4 px-4 py-2.5"
          >
            <span className="text-[0.8571em] text-content-muted">{row.label}</span>
            <span className="text-[0.8571em] tabular-nums text-content">
              {row.value}
            </span>
          </div>
        ))}
      </div>

      {/* Update status banner */}
      <UpdateBanner
        state={updateState}
        onDownload={onDownloadUpdate}
        onInstall={onQuitAndInstall}
        onGoToDownload={onGoToDownload}
      />

      {/* Action buttons */}
      <div className="mt-6 flex w-full max-w-md flex-wrap items-center justify-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCopyVersion}
          title={t("settings.about.copyVersionInfo")}
          className="gap-1.5"
        >
          {copied ? (
            <IconCheck size={14} className="text-accent" />
          ) : (
            <IconCopy size={14} />
          )}
          {copied ? t("common.copied") : t("settings.about.copyVersionInfo")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openExternal(REPO_URL)}
          title={t("settings.about.openRepoTitle")}
          className="gap-1.5"
        >
          <SiGithub size={14} />
          {t("settings.about.githubRepo")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCheckForUpdates}
          disabled={updateState.kind === "checking" || updateState.kind === "downloading"}
          title={t("settings.about.checkUpdateTitle")}
          className="gap-1.5"
        >
          {updateState.kind === "checking" ? (
            <IconRefresh size={14} className="animate-spin" />
          ) : (
            <IconExternalLink size={14} />
          )}
          {updateState.kind === "checking" ? t("settings.about.checking") : t("settings.about.checkForUpdates")}
        </Button>
      </div>

      {/* Footer note */}
      <p className="mt-8 flex w-full max-w-md items-center justify-center gap-1.5 text-center text-[0.7143em] leading-relaxed text-content-subtle">
        <IconInfoCircle size={12} className="shrink-0" />
        <span>{t("settings.about.footer")}</span>
      </p>
    </section>
  );
}

/** Compact banner showing the current update-flow state and the next action.
 *  Only renders when there's something to say (not idle/checking - those are
 *  reflected by the button itself). */
function UpdateBanner({
  state,
  onDownload,
  onInstall,
  onGoToDownload,
}: {
  state: UpdateState;
  onDownload: () => void;
  onInstall: () => void;
  onGoToDownload: () => void;
}) {
  const { t } = useI18n();

  if (state.kind === "idle" || state.kind === "checking") return null;

  // Downloading gets a richer layout: a progress bar + percent/byte counter.
  if (state.kind === "downloading") {
    const percent = Math.min(100, Math.max(0, state.percent));
    const bytesText =
      state.total > 0
        ? `${formatBytes(state.transferred)} / ${formatBytes(state.total)}`
        : formatBytes(state.transferred);
    return (
      <div
        className={cn(
          "mt-6 flex w-full max-w-md flex-col gap-2 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3",
        )}
      >
        <div className="flex items-center gap-2.5">
          <IconRefresh size={16} className="shrink-0 animate-spin text-accent" />
          <span className="truncate text-[0.8571em] text-content">
            {t("settings.about.downloading", { p: percent.toFixed(0) })}
          </span>
          <span className="ml-auto shrink-0 tabular-nums text-[0.7143em] text-content-muted">
            {bytesText}
          </span>
        </div>
        {/* Progress bar track + fill. */}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    );
  }

  let icon: React.ReactNode;
  let message: string;
  let action: { label: string; onClick: () => void; icon?: React.ReactNode } | null = null;
  let tone: "accent" | "muted" | "warning" = "muted";

  switch (state.kind) {
    case "up-to-date":
      icon = <IconCheck size={16} className="text-accent" />;
      message = t("settings.about.upToDate", { version: state.version });
      break;
    case "available":
      if (state.manualInstallRequired) {
        // macOS ad-hoc: downloads can never be auto-installed, so skip the
        // in-app download entirely and guide the user to the releases page.
        icon = <IconExternalLink size={16} className="text-accent" />;
        message = t("settings.about.available", { version: state.version });
        action = {
          label: t("settings.about.goToDownload"),
          onClick: onGoToDownload,
          icon: <IconExternalLink size={14} />,
        };
      } else {
        icon = <IconDownload size={16} className="text-accent" />;
        message = t("settings.about.available", { version: state.version });
        action = { label: t("settings.about.downloadNow"), onClick: onDownload, icon: <IconDownload size={14} /> };
      }
      tone = "accent";
      break;
    case "downloaded":
      if (state.manualInstallRequired) {
        // macOS ad-hoc: Squirrel.Mac can't apply the update. Guide the user to
        // the releases page for a manual download/install instead of offering
        // a no-op "restart & install".
        icon = <IconExternalLink size={16} className="text-accent" />;
        message = t("settings.about.manualInstall", { version: state.version });
        action = {
          label: t("settings.about.goToDownload"),
          onClick: onGoToDownload,
          icon: <IconExternalLink size={14} />,
        };
      } else {
        icon = <IconRocket size={16} className="text-accent" />;
        message = t("settings.about.readyToInstall", { version: state.version });
        action = { label: t("settings.about.restartInstall"), onClick: onInstall, icon: <IconRocket size={14} /> };
      }
      tone = "accent";
      break;
    case "error":
      icon = <IconAlertTriangle size={16} className="text-warning" />;
      message = t("settings.about.checkFailed", { message: state.message });
      tone = "warning";
      break;
  }

  return (
    <div
      className={cn(
        "mt-6 flex w-full max-w-md items-center justify-between gap-3 rounded-lg border px-4 py-3",
        tone === "accent" && "border-accent/30 bg-accent/5",
        tone === "muted" && "border-edge bg-surface",
        tone === "warning" && "border-warning/30 bg-warning/5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="shrink-0">{icon}</span>
        <span className="truncate text-[0.8571em] text-content">{message}</span>
      </div>
      {action && (
        <Button
          variant="ghost"
          size="sm"
          onClick={action.onClick}
          className="shrink-0 gap-1.5"
        >
          {action.icon}
          {action.label}
        </Button>
      )}
    </div>
  );
}
