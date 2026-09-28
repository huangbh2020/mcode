/**
 * Agent runtimes (download-on-demand) settings panel.
 *
 * One compact ROW per agent runtime (Claude / Codex / Pi): brand icon + name
 * + status badge on the left, a single muted detail line in the middle (the
 * one effective version, disk size), and install/update/remove actions on
 * the right. The payloads themselves are
 * NOT bundled with the installer (~600MB per platform); the main-process
 * RuntimeInstaller downloads them from the npm registry into
 * userData/runtimes on demand (see main/runtimes/runtimeInstaller.ts).
 *
 * "检查更新" is a user-clicked RPC (never scheduled): it force-refreshes the
 * registry latest for all three agents and classifies each against Mcode's
 * compat list (docs/agent-runtime-update.md). The verdict banner under each
 * row offers the update-to-latest action — green installs directly, yellow
 * confirms and then goes through the main-side compat gates (a gate rejection
 * offers "install anyway"), red requires the strong confirm up front.
 * Rollback lives in the expanded details: it deletes the newest managed
 * version so the resolvers fall back to the previous one.
 *
 * State lives in the session store (`runtimes`, hydrated at startup and
 * refreshed when the panel mounts). Live download/extract progress arrives
 * over the `runtimes:event` push channel; a done/error event triggers a full
 * re-list so versions/disk bytes converge to the main-side truth.
 */
import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import type { RuntimeAgentId, RuntimeAgentState, RuntimeCheckResult } from "@contracts/ipc";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import {
  IconCheck,
  IconCopy,
  IconX,
  IconRefresh,
  IconTrash,
  IconLoader2,
  IconAlertTriangle,
  IconDownload,
  IconPackage,
  IconFileImport,
  IconChevronRight,
  IconChevronDown,
  IconFolderOpen,
  IconSearch,
  IconArrowBackUp,
} from "@renderer/lib/icons.js";

/** Display names — proper nouns, untranslated. */
const AGENT_META: Record<RuntimeAgentId, { label: string }> = {
  claude: { label: "Claude" },
  codex: { label: "Codex" },
  pi: { label: "Pi" },
};

function formatBytes(n: number): string {
  if (n <= 0) return "—";
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}

export function RuntimesPanel() {
  const { t } = useI18n();
  const runtimes = useSessionStore((s) => s.runtimes);
  const reloadRuntimes = useSessionStore((s) => s.reloadRuntimes);
  const applyRuntimeProgress = useSessionStore((s) => s.applyRuntimeProgress);
  // Latest download fraction per agent (0..1, or -1 = indeterminate). Lives
  // here rather than the store — it's transient render state.
  const [progress, setProgress] = useState<Partial<Record<RuntimeAgentId, number>>>({});

  // Manual "check for updates" state — component-local by design: verdicts
  // are point-in-time, never persisted, and a fresh click re-computes them.
  const [checking, setChecking] = useState(false);
  const [checkResults, setCheckResults] = useState<Partial<Record<RuntimeAgentId, RuntimeCheckResult>>>({});
  const [lastCheckAt, setLastCheckAt] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  // Re-list on mount (fresh versions / disk bytes / upstream latest).
  useEffect(() => {
    void reloadRuntimes();
  }, [reloadRuntimes]);

  // Progress pushes: merge into the store, keep the fraction locally, and
  // re-list on done/error so versions + disk bytes converge.
  useEffect(() => {
    const unsub = api.on.runtimesEvent((msg) => {
      const p = msg.payload;
      applyRuntimeProgress(p);
      if (p.phase === "downloading") {
        setProgress((prev) => ({ ...prev, [p.agent]: p.progress }));
      } else if (p.phase === "extracting" || p.phase === "verifying") {
        setProgress((prev) => ({ ...prev, [p.agent]: -1 }));
      } else {
        setProgress((prev) => ({ ...prev, [p.agent]: undefined }));
        void reloadRuntimes();
      }
    });
    return unsub;
  }, [applyRuntimeProgress, reloadRuntimes]);

  const doCheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const res = await api.runtimes.checkUpdates({});
      const map: Partial<Record<RuntimeAgentId, RuntimeCheckResult>> = {};
      for (const r of res.results) map[r.agent] = r;
      setCheckResults(map);
      setLastCheckAt(new Date().toLocaleTimeString());
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader title={t("settings.runtimes.title")} icon={IconPackage} />

      {/* Manual check-for-updates row — the ONLY trigger; nothing scheduled. */}
      <div className="flex items-center justify-end gap-2">
        {checkError && (
          <span className="min-w-0 flex-1 truncate text-[0.7857em] text-danger" title={checkError}>
            {t("settings.runtimes.checkFailed", { error: checkError })}
          </span>
        )}
        {lastCheckAt && !checkError && (
          <span className="min-w-0 flex-1 truncate text-[0.7857em] text-content-subtle">
            {t("settings.runtimes.lastCheckAt", { time: lastCheckAt })}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={doCheck} disabled={checking}>
          {checking ? <IconLoader2 size={12} className="animate-spin" /> : <IconSearch size={12} />}
          {checking ? t("settings.runtimes.checking") : t("settings.runtimes.checkNow")}
        </Button>
      </div>

      <SettingsSection title={t("settings.runtimes.section")}>
        {runtimes.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-4 py-8 text-[0.85em] text-content-subtle">
            <IconLoader2 size={14} className="animate-spin" />
            {t("settings.runtimes.loading")}
          </div>
        ) : (
          runtimes.map((rt) => (
            <RuntimeRow
              key={rt.agent}
              state={rt}
              check={checkResults[rt.agent]}
              progress={progress[rt.agent]}
              onReload={reloadRuntimes}
            />
          ))
        )}
      </SettingsSection>
    </section>
  );
}

/* ───────────────────────── runtime row ───────────────────────── */

function RuntimeRow({
  state,
  check,
  progress,
  onReload,
}: {
  state: RuntimeAgentState;
  /** Verdict from the last manual check, when one has run. */
  check: RuntimeCheckResult | undefined;
  /** 0..1 download fraction, -1 indeterminate, undefined when idle. */
  progress: number | undefined;
  onReload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const meta = AGENT_META[state.agent];
  const brand = getProviderIcon(`${state.agent}-sdk`);
  const BrandIcon = brand.Icon;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Set when an install-to-version was rejected by the main-side compat
   *  gates — offers the force retry. */
  const [gateBlockedVersion, setGateBlockedVersion] = useState<string | null>(null);
  /** pi is imported once per process — an update/rollback lands only after
   *  an app restart (claude/codex binaries take effect on the next turn). */
  const [needsRestart, setNeedsRestart] = useState(false);

  const markRestartIfPi = () => {
    if (state.agent === "pi") setNeedsRestart(true);
  };

  const doInstall = async () => {
    setBusy(true);
    setActionError(null);
    setGateBlockedVersion(null);
    try {
      const res = await api.runtimes.install({ agent: state.agent });
      if (!res.ok) setActionError(t("settings.runtimes.installFailed", { error: res.error ?? "" }));
      else markRestartIfPi();
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  /** Install a specific upstream version — the "update to latest" path.
   *  force=false lets the main-side compat gates decide; a gate rejection
   *  surfaces the force retry. */
  const doInstallVersion = async (v: string, force: boolean) => {
    setBusy(true);
    setActionError(null);
    setGateBlockedVersion(null);
    try {
      const res = await api.runtimes.install({ agent: state.agent, version: v, force });
      if (!res.ok) {
        setActionError(t("settings.runtimes.installFailed", { error: res.error ?? "" }));
        if (res.gateBlocked) setGateBlockedVersion(v);
      } else {
        markRestartIfPi();
      }
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  const doRemove = async () => {
    if (!confirm(t("settings.runtimes.removeConfirm", { name: meta.label }))) return;
    setBusy(true);
    setActionError(null);
    setGateBlockedVersion(null);
    try {
      const res = await api.runtimes.remove({ agent: state.agent });
      if (!res.ok) setActionError(t("settings.runtimes.removeFailed", { error: res.error ?? "" }));
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  const doRollback = async () => {
    const prev = state.previousVersion;
    if (!prev) return;
    if (!confirm(t("settings.runtimes.rollbackConfirm", { name: meta.label, v: prev }))) return;
    setBusy(true);
    setActionError(null);
    setGateBlockedVersion(null);
    try {
      const res = await api.runtimes.rollback({ agent: state.agent });
      if (!res.ok) setActionError(t("settings.runtimes.installFailed", { error: res.error ?? "" }));
      else {
        markRestartIfPi();
        setActionError(t("settings.runtimes.rolledBack", { v: res.rolledBackTo ?? prev }));
      }
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  /** Escape hatch for when the registry path fails: @mcode/runtime-pi not
   *  published yet / stale mirror / offline. Pick the agent's LOCAL path —
   *  an install directory (claude: dir with claude.exe; codex: dir with
   *  vendor/; pi: dir with node_modules/, i.e. what `pnpm pack:pi-runtime`
   *  stages) or a .tgz. */
  const doInstallLocal = async () => {
    const { path } = await api.pickFolder();
    if (!path) return;
    setBusy(true);
    setActionError(null);
    setGateBlockedVersion(null);
    try {
      const res = await api.runtimes.installLocal({ agent: state.agent, localPath: path });
      if (!res.ok) setActionError(t("settings.runtimes.installFailed", { error: res.error ?? "" }));
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  const installing = busy || state.installing;
  const showProgress = installing && progress !== undefined;
  // Local snapshot so the closures below keep the narrowed non-null type.
  const activePath = state.activePath;
  // The ONE version this row shows (collapsed line + expanded field): the
  // copy actually in use, falling back to the expected version before any
  // install exists. Upstream latest shows up in the verdict banner after a
  // manual check, not here.
  const version = state.installedVersion ?? state.activeVersion ?? state.expectedVersion;
  // Expanded detail (path + versions + source). Collapsed by default — the
  // row itself stays the single-line summary.
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const doCopyPath = async () => {
    if (!state.activePath) return;
    try {
      await navigator.clipboard.writeText(state.activePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  // Single muted detail line: active version · size · upstream news.
  // Truthy guards everywhere — a stale main process (older list shape) must
  // degrade to "no version shown", never render "vundefined".
  const details: string[] = [];
  if (state.installedVersion) {
    details.push(t("settings.runtimes.detailInstalled", { v: state.installedVersion }));
    if (state.diskBytes > 0) details.push(formatBytes(state.diskBytes));
  } else if (state.source === "dev" || state.source === "bundled") {
    details.push(
      state.activeVersion
        ? state.source === "dev"
          ? t("settings.runtimes.detailDev", { v: state.activeVersion })
          : t("settings.runtimes.detailBundled", { v: state.activeVersion })
        : state.source === "dev"
          ? t("settings.runtimes.statusDev")
          : t("settings.runtimes.statusBundled"),
    );
  } else if (state.expectedVersion) {
    details.push(t("settings.runtimes.detailExpected", { v: state.expectedVersion }));
  }

  return (
    <div className="px-4 py-2">
      <div className="flex items-center gap-3">
        {/* Expand toggle */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className={cn(
            "flex shrink-0 items-center justify-center rounded p-0.5 text-content-subtle transition-colors",
            "hover:bg-surface-hover hover:text-content",
          )}
          title={t("settings.runtimes.toggleDetails")}
        >
          {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        </button>

        {/* Name column: brand icon + name + status badge */}
        <div className="flex w-44 shrink-0 items-center gap-2">
          <BrandIcon size={15} className={cn("shrink-0", brand.color)} />
          <span className="min-w-0 truncate text-[13px] font-medium text-content">{meta.label}</span>
          <StatusBadge state={state} />
        </div>

        {/* Detail line (click also expands; full path on hover) */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="min-w-0 flex-1 truncate text-left text-[0.7857em] text-content-subtle hover:text-content-muted"
          title={state.activePath ?? undefined}
        >
          {details.join("  ·  ")}
        </button>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          {!state.installed ? (
            <Button variant={state.source === null ? "primary" : "outline"} size="sm" onClick={doInstall} disabled={installing}>
              {installing ? (
                <IconLoader2 size={12} className="animate-spin" />
              ) : (
                <IconDownload size={12} />
              )}
              {t("settings.runtimes.install")}
            </Button>
          ) : (
            <>
              {state.updateAvailable && (
                <Button variant="primary" size="sm" onClick={doInstall} disabled={installing}>
                  {installing ? <IconLoader2 size={12} className="animate-spin" /> : <IconDownload size={12} />}
                  {t("settings.runtimes.installExpected", { v: state.expectedVersion })}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={doInstall} disabled={installing} title={t("settings.runtimes.reinstall")}>
                {installing ? <IconLoader2 size={12} className="animate-spin" /> : <IconRefresh size={12} />}
              </Button>
              <Button variant="outline" size="sm" onClick={doRemove} disabled={installing}>
                <IconTrash size={12} />
                {t("settings.runtimes.remove")}
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={doInstallLocal}
            disabled={installing}
            title={t("settings.runtimes.installLocalHint")}
          >
            <IconFileImport size={12} />
          </Button>
        </div>
      </div>

      {/* Verdict banner from the last manual check. Hidden while installing —
          the download/extract progress + fresh re-list will supersede it. */}
      {check && !installing && (
        <CheckVerdictBanner check={check} gateBlockedVersion={gateBlockedVersion} installing={installing} onUpdate={(v, force) => void doInstallVersion(v, force)} />
      )}

      {/* Expanded details: source / versions / disk / load path / rollback */}
      {expanded && (
        <div className="ml-7 mt-1.5 space-y-1 rounded bg-surface-muted/30 px-3 py-2 text-[0.7857em]">
          <DetailRow label={t("settings.runtimes.field.source")}>
            {sourceLabel(state, t)}
          </DetailRow>
          {version && (
            <DetailRow label={t("settings.runtimes.field.version")}>
              <span className="font-mono">v{version}</span>
            </DetailRow>
          )}
          {state.previousVersion && (
            <DetailRow label={t("settings.runtimes.field.previousVersion")}>
              <span className="font-mono">v{state.previousVersion}</span>
              <button
                type="button"
                onClick={doRollback}
                disabled={installing}
                className="ml-2 flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[0.92em] text-content-subtle hover:bg-surface-hover hover:text-content disabled:opacity-50"
                title={t("settings.runtimes.rollbackTo", { v: state.previousVersion })}
              >
                <IconArrowBackUp size={11} />
                {t("settings.runtimes.rollbackTo", { v: state.previousVersion })}
              </button>
            </DetailRow>
          )}
          {state.installed && state.diskBytes > 0 && (
            <DetailRow label={t("settings.runtimes.field.size")}>
              {formatBytes(state.diskBytes)}
            </DetailRow>
          )}
          {activePath !== null && (
            <DetailRow label={t("settings.runtimes.field.path")}>
              <span className="block min-w-0 flex-1 truncate font-mono text-content-muted" title={activePath}>
                {activePath}
              </span>
              <button
                type="button"
                onClick={doCopyPath}
                className="ml-2 flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[0.92em] text-content-subtle hover:bg-surface-hover hover:text-content"
                title={t("settings.runtimes.copy")}
              >
                {copied ? <IconCheck size={11} className="text-accent" /> : <IconCopy size={11} />}
                {copied ? t("settings.runtimes.copied") : t("settings.runtimes.copy")}
              </button>
              <button
                type="button"
                onClick={() => void api.shell.showItemInFolder({ path: activePath })}
                className="ml-1 flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[0.92em] text-content-subtle hover:bg-surface-hover hover:text-content"
                title={t("settings.runtimes.reveal")}
              >
                <IconFolderOpen size={11} />
              </button>
            </DetailRow>
          )}
        </div>
      )}

      {/* Download/extract progress bar (only while installing) */}
      {showProgress && (
        <div className="mt-1.5">
          <div className="h-1 overflow-hidden rounded-full bg-surface-hover">
            <div
              className={cn(
                "h-full rounded-full bg-accent transition-[width] duration-150",
                progress === -1 && "w-1/3 animate-pulse",
              )}
              style={progress !== undefined && progress >= 0 ? { width: `${Math.round(progress * 100)}%` } : undefined}
            />
          </div>
        </div>
      )}

      {/* Restart hint (pi module is process-cached) */}
      {needsRestart && !installing && (
        <div className="mt-1.5 flex items-start gap-1.5 rounded bg-warning/10 px-2 py-1 text-[0.7857em] text-warning">
          <IconAlertTriangle size={11} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{t("settings.runtimes.restartRequired")}</span>
        </div>
      )}

      {/* Error (action failure or last failed attempt) */}
      {(actionError || state.lastError) && (
        <div className="mt-1.5 flex items-start gap-1.5 rounded bg-danger/10 px-2 py-1 text-[0.7857em] text-danger">
          <IconAlertTriangle size={11} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{actionError ?? state.lastError}</span>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── check verdict banner ───────────────────────── */

function CheckVerdictBanner({
  check,
  gateBlockedVersion,
  installing,
  onUpdate,
}: {
  check: RuntimeCheckResult;
  /** Version whose install was rejected by the compat gates — shows the
   *  force retry. */
  gateBlockedVersion: string | null;
  installing: boolean;
  onUpdate: (version: string, force: boolean) => void;
}) {
  const { t } = useI18n();
  const v = check.latestVersion;

  let tone = "bg-surface-muted/30 text-content-subtle";
  let text = "";
  let hint: string | null = null;
  let action: { label: string; danger?: boolean; onClick: () => void } | null = null;

  switch (check.verdict) {
    case "up-to-date":
      text = v ? t("settings.runtimes.verdict.upToDate", { v }) : "";
      break;
    case "ok":
      tone = "bg-accent/10 text-accent";
      text = v ? t("settings.runtimes.verdict.ok", { v }) : "";
      action = v
        ? { label: t("settings.runtimes.updateTo", { v }), onClick: () => onUpdate(v, false) }
        : null;
      break;
    case "untested":
      tone = "bg-warning/10 text-warning";
      if (!v) {
        // Registry answered "no such package" vs. couldn't reach it at all —
        // different advice for the user.
        text = check.reasons.includes("registry-missing")
          ? t("settings.runtimes.verdict.registryMissing")
          : t("settings.runtimes.verdict.registryError");
      } else {
        text = t("settings.runtimes.verdict.untested", { v });
        action = {
          label: t("settings.runtimes.updateTo", { v }),
          // First attempt runs the main-side compat gates; only a gate
          // rejection offers the force retry below.
          onClick: () => {
            if (confirm(t("settings.runtimes.untestedConfirm", { v }))) onUpdate(v, false);
          },
        };
      }
      break;
    case "blocked": {
      tone = "bg-danger/10 text-danger";
      const reason = check.reasons.find((r) => r.startsWith("broken:"))?.slice("broken:".length) ?? "";
      // The broken version is the ACTIVE one (nothing newer to install) —
      // re-installing the same version is pointless; recovery is the
      // rollback button in the expanded details.
      const activeBroken = check.reasons.includes("active-version-broken");
      text = v ? t("settings.runtimes.verdict.blocked", { v, reason }) : "";
      if (activeBroken) {
        hint = t("settings.runtimes.verdict.activeBrokenHint");
      }
      action = v && !activeBroken
        ? {
            label: t("settings.runtimes.forceInstall", { v }),
            danger: true,
            onClick: () => {
              if (confirm(t("settings.runtimes.blockedConfirm", { v, reason }))) onUpdate(v, true);
            },
          }
        : null;
      break;
    }
    case "not-installed":
      text = t("settings.runtimes.verdict.notInstalled");
      break;
  }

  if (!text && !gateBlockedVersion) return null;

  return (
    <div className={cn("mt-1.5 flex items-start justify-between gap-2 rounded px-2 py-1 text-[0.7857em]", tone)}>
      <div className="min-w-0 flex-1">
        <span className="block break-words">{text}</span>
        {hint && <span className="mt-0.5 block break-words opacity-80">{hint}</span>}
        {gateBlockedVersion && (
          <span className="mt-0.5 block break-words text-warning">
            {t("settings.runtimes.gateBlockedHint")}
          </span>
        )}
        {check.compatListStale && (
          <span className="mt-0.5 block break-words opacity-80">
            {t("settings.runtimes.compatStale")}
          </span>
        )}
      </div>
      <div className="flex shrink-0 gap-1">
        {gateBlockedVersion && (
          <Button
            variant="outline"
            size="sm"
            disabled={installing}
            onClick={() => onUpdate(gateBlockedVersion, true)}
          >
            {t("settings.runtimes.forceInstall", { v: gateBlockedVersion })}
          </Button>
        )}
        {action && (
          <Button variant={action.danger ? "outline" : "primary"} size="sm" disabled={installing} onClick={action.onClick}
            className={cn(action.danger && "text-danger hover:text-danger")}>
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Human label for the active source (detail panel). */
function sourceLabel(state: RuntimeAgentState, t: (key: MessageId) => string): string {
  switch (state.source) {
    case "managed":
      return t("settings.runtimes.source.managed");
    case "dev":
      return t("settings.runtimes.source.dev");
    case "bundled":
      return t("settings.runtimes.source.bundled");
    default:
      return t("settings.runtimes.statusNotInstalled");
  }
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-content-subtle">{label}</span>
      <div className="flex min-w-0 flex-1 items-center text-content-muted">{children}</div>
    </div>
  );
}

function StatusBadge({ state }: { state: RuntimeAgentState }) {
  const { t } = useI18n();
  if (state.installing) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-1.5 py-0.5 text-[0.72em] text-accent">
        <IconLoader2 size={9} className="animate-spin" />
        {t("settings.runtimes.statusInstalling")}
      </span>
    );
  }
  if (state.updateAvailable) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full bg-warning/10 px-1.5 py-0.5 text-[0.72em] text-warning">
        {t("settings.runtimes.statusUpdate")}
      </span>
    );
  }
  if (state.installed) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-1.5 py-0.5 text-[0.72em] text-accent">
        <IconCheck size={9} />
        {t("settings.runtimes.statusInstalled")}
      </span>
    );
  }
  if (state.source === "dev" || state.source === "bundled") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-hover px-1.5 py-0.5 text-[0.72em] text-content-muted">
        {state.source === "dev"
          ? t("settings.runtimes.statusDev")
          : t("settings.runtimes.statusBundled")}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-hover px-1.5 py-0.5 text-[0.72em] text-content-subtle">
      <IconX size={9} />
      {t("settings.runtimes.statusNotInstalled")}
    </span>
  );
}
