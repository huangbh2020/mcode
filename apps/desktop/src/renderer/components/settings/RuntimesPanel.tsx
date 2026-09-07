/**
 * Agent runtimes (download-on-demand) settings panel.
 *
 * One compact ROW per agent runtime (Claude Code / Codex CLI / Pi Coding
 * Agent): brand icon + name + status badge on the left, a single muted
 * detail line in the middle (active version, disk size, upstream news), and
 * install/update/remove actions on the right. The payloads themselves are
 * NOT bundled with the installer (~600MB per platform); the main-process
 * RuntimeInstaller downloads them from the npm registry into
 * userData/runtimes on demand (see main/runtimes/runtimeInstaller.ts).
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
import type { RuntimeAgentId, RuntimeAgentState } from "@contracts/ipc";
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
} from "@renderer/lib/icons.js";

/** Display names — proper nouns, untranslated. */
const AGENT_META: Record<RuntimeAgentId, { label: string }> = {
  claude: { label: "Claude Code" },
  codex: { label: "Codex CLI" },
  pi: { label: "Pi Coding Agent" },
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
      } else if (p.phase === "extracting") {
        setProgress((prev) => ({ ...prev, [p.agent]: -1 }));
      } else {
        setProgress((prev) => ({ ...prev, [p.agent]: undefined }));
        void reloadRuntimes();
      }
    });
    return unsub;
  }, [applyRuntimeProgress, reloadRuntimes]);

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader title={t("settings.runtimes.title")} icon={IconPackage} />

      <SettingsSection title={t("settings.runtimes.section")}>
        {runtimes.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-4 py-8 text-[0.85em] text-content-subtle">
            <IconLoader2 size={14} className="animate-spin" />
            {t("settings.runtimes.loading")}
          </div>
        ) : (
          runtimes.map((rt) => (
            <RuntimeRow key={rt.agent} state={rt} progress={progress[rt.agent]} onReload={reloadRuntimes} />
          ))
        )}
      </SettingsSection>
    </section>
  );
}

/* ───────────────────────── runtime row ───────────────────────── */

function RuntimeRow({
  state,
  progress,
  onReload,
}: {
  state: RuntimeAgentState;
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

  const doInstall = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.runtimes.install({ agent: state.agent });
      if (!res.ok) setActionError(t("settings.runtimes.installFailed", { error: res.error ?? "" }));
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  const doRemove = async () => {
    if (!confirm(t("settings.runtimes.removeConfirm", { name: meta.label }))) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.runtimes.remove({ agent: state.agent });
      if (!res.ok) setActionError(t("settings.runtimes.removeFailed", { error: res.error ?? "" }));
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
  if (state.latestVersion !== null && state.latestVersion !== state.expectedVersion) {
    details.push(t("settings.runtimes.detailLatest", { v: state.latestVersion }));
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
                  {t("settings.runtimes.update")}
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

      {/* Expanded details: source / versions / disk / load path */}
      {expanded && (
        <div className="ml-7 mt-1.5 space-y-1 rounded bg-surface-muted/30 px-3 py-2 text-[0.7857em]">
          <DetailRow label={t("settings.runtimes.field.source")}>
            {sourceLabel(state, t)}
          </DetailRow>
          <DetailRow label={t("settings.runtimes.field.expected")}>
            <span className="font-mono">v{state.expectedVersion}</span>
          </DetailRow>
          {state.activeVersion !== null && (
            <DetailRow label={t("settings.runtimes.field.active")}>
              <span className="font-mono">v{state.activeVersion}</span>
            </DetailRow>
          )}
          {state.latestVersion !== null && (
            <DetailRow label={t("settings.runtimes.field.latest")}>
              <span className="font-mono">v{state.latestVersion}</span>
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
