/**
 * Agent 设置面板 (RuntimesPanel)。
 *
 * 核心架构包含两大板块:
 * 1. 核心 Agent 引擎运行时 (Claude / Codex / Pi SDK):
 *    应用内部驱动多回合对话与工具链的核心 Agent 框架。
 *    支持按需流式下载、版本生命周期隔离、兼容性检测、离线本地包安装与原子回滚。
 * 2. 终端 CLI 命令行环境 (Claude Code / Codex / Pi / Antigravity):
 *    用户操作系统全局安装的命令行工具，用于在 IDE 内置终端中直接启动 CLI 会话。
 */
import { useEffect, useState, useMemo, useCallback } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, Card, Switch } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import type {
  RuntimeAgentId,
  RuntimeAgentState,
  RuntimeCheckResult,
  TerminalCliStatus,
} from "@contracts/ipc";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { TERMINAL_CLI_FALLBACK_LABELS } from "@renderer/lib/terminalCli.js";
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
  IconServer,
  IconDatabase,
  IconTerminal2,
  IconTools,
} from "@renderer/lib/icons.js";

/** 引擎元数据与描述文案映射 */
const AGENT_META: Record<
  RuntimeAgentId,
  { label: string; descKey: MessageId }
> = {
  claude: {
    label: "Claude",
    descKey: "settings.runtimes.engineClaudeDesc",
  },
  codex: {
    label: "Codex",
    descKey: "settings.runtimes.engineCodexDesc",
  },
  pi: {
    label: "Pi",
    descKey: "settings.runtimes.enginePiDesc",
  },
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

  // 实时下载进度缓存 (0..1，-1 为解压/校验阶段)
  const [progress, setProgress] = useState<Partial<Record<RuntimeAgentId, number>>>({});

  // 手动检查更新状态
  const [checking, setChecking] = useState(false);
  const [checkResults, setCheckResults] = useState<Partial<Record<RuntimeAgentId, RuntimeCheckResult>>>({});
  const [lastCheckAt, setLastCheckAt] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  // 挂载时重新拉取最新状态
  useEffect(() => {
    void reloadRuntimes();
  }, [reloadRuntimes]);

  // 订阅主进程事件流推送
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

  // 全量检查 Agent 更新
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

  // 全局概览统计计算
  const summary = useMemo(() => {
    const total = runtimes.length;
    const ready = runtimes.filter((r) => r.installed || r.source === "dev" || r.source === "bundled").length;
    const totalBytes = runtimes.reduce((acc, r) => acc + (r.diskBytes || 0), 0);
    const hasIssues = runtimes.some((r) => !r.installed && r.source === null);
    return {
      total,
      ready,
      totalBytes,
      isAllHealthy: total > 0 && ready === total && !hasIssues,
    };
  }, [runtimes]);

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl min-h-0 flex-col">
      <PanelHeader
        className="mb-3"
        title={t("settings.runtimes.title")}
        icon={IconPackage}
      />

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pb-10">
        {/* ── 模块 1: 全局运行状态与统计看板 ── */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* 已就绪引擎 */}
          <div className="flex items-center gap-3 rounded-lg border border-edge bg-surface px-4 py-3 shadow-xs">
            <div
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                summary.isAllHealthy
                  ? "bg-accent/10 text-accent"
                  : "bg-warning/10 text-warning",
              )}
            >
              {summary.isAllHealthy ? <IconCheck size={18} /> : <IconAlertTriangle size={18} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[0.75em] font-medium text-content-subtle">
                {t("settings.runtimes.summaryEnginesReady")}
              </div>
              <div className="mt-0.5 text-base font-semibold text-content">
                {summary.ready} / {summary.total || 3}
              </div>
            </div>
          </div>

          {/* 磁盘空间占用 */}
          <div className="flex items-center gap-3 rounded-lg border border-edge bg-surface px-4 py-3 shadow-xs">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-content-muted">
              <IconDatabase size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[0.75em] font-medium text-content-subtle">
                {t("settings.runtimes.summaryDiskUsage")}
              </div>
              <div className="mt-0.5 text-base font-semibold text-content font-mono">
                {formatBytes(summary.totalBytes)}
              </div>
            </div>
          </div>

          {/* 环境状态与更新动作 */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-surface px-4 py-3 shadow-xs">
            <div className="min-w-0 flex-1">
              <div className="text-[0.75em] font-medium text-content-subtle">
                {t("settings.runtimes.summaryStatus")}
              </div>
              <div
                className={cn(
                  "mt-0.5 truncate text-xs font-semibold",
                  summary.isAllHealthy ? "text-accent" : "text-amber-500",
                )}
              >
                {summary.isAllHealthy
                  ? t("settings.runtimes.summaryStatusHealthy")
                  : t("settings.runtimes.summaryStatusActionNeeded")}
              </div>
              {lastCheckAt && !checkError && (
                <div className="text-[0.6875em] text-content-subtle">
                  {t("settings.runtimes.lastCheckAt", { time: lastCheckAt })}
                </div>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={doCheck}
              disabled={checking}
              className="shrink-0"
            >
              {checking ? (
                <IconLoader2 size={13} className="animate-spin" />
              ) : (
                <IconSearch size={13} />
              )}
              <span>{checking ? t("settings.runtimes.checking") : t("settings.runtimes.checkNow")}</span>
            </Button>
          </div>
        </div>

        {checkError && (
          <div className="flex items-center gap-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            <IconAlertTriangle size={14} className="shrink-0" />
            <span className="truncate">{t("settings.runtimes.checkFailed", { error: checkError })}</span>
          </div>
        )}

        {/* ── 模块 2: 核心 Agent 引擎卡片矩阵 ── */}
        <section className="space-y-2.5">
          <div className="px-1">
            <div className="flex items-center gap-1.5">
              <IconServer size={15} className="text-accent" />
              <h3 className="text-[0.9286em] font-semibold text-content">
                {t("settings.runtimes.section")}
              </h3>
            </div>
            <p className="mt-0.5 text-[0.7857em] text-content-subtle">
              {t("settings.runtimes.sectionDesc")}
            </p>
          </div>

          {runtimes.length === 0 ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-edge bg-surface py-12 text-xs text-content-subtle">
              <IconLoader2 size={15} className="animate-spin text-accent" />
              <span>{t("settings.runtimes.loading")}</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
              {runtimes.map((rt) => (
                <AgentEngineCard
                  key={rt.agent}
                  state={rt}
                  check={checkResults[rt.agent]}
                  progress={progress[rt.agent]}
                  onReload={reloadRuntimes}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── 模块 3: 终端命令行环境 ── */}
        <TerminalCliSection />
      </div>
    </div>
  );
}

/* ───────────────────────── 核心 Agent 独立卡片组件 ───────────────────────── */

function AgentEngineCard({
  state,
  check,
  progress,
  onReload,
}: {
  state: RuntimeAgentState;
  check: RuntimeCheckResult | undefined;
  progress: number | undefined;
  onReload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const meta = AGENT_META[state.agent];
  const brand = getProviderIcon(`${state.agent}-sdk`);
  const BrandIcon = brand.Icon;

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [gateBlockedVersion, setGateBlockedVersion] = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);

  // 高级折叠面板状态与路径复制反馈
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const markRestartIfPi = () => {
    if (state.agent === "pi") setNeedsRestart(true);
  };

  const doInstall = async () => {
    setBusy(true);
    setActionError(null);
    setGateBlockedVersion(null);
    try {
      const res = await api.runtimes.install({ agent: state.agent });
      if (!res.ok) {
        setActionError(t("settings.runtimes.installFailed", { error: res.error ?? "" }));
      } else {
        markRestartIfPi();
      }
      await onReload();
    } finally {
      setBusy(false);
    }
  };

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
      if (!res.ok) {
        setActionError(t("settings.runtimes.removeFailed", { error: res.error ?? "" }));
      }
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
      if (!res.ok) {
        setActionError(t("settings.runtimes.installFailed", { error: res.error ?? "" }));
      } else {
        markRestartIfPi();
        setActionError(t("settings.runtimes.rolledBack", { v: res.rolledBackTo ?? prev }));
      }
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  const doInstallLocal = async () => {
    const { path } = await api.pickFolder();
    if (!path) return;
    setBusy(true);
    setActionError(null);
    setGateBlockedVersion(null);
    try {
      const res = await api.runtimes.installLocal({ agent: state.agent, localPath: path });
      if (!res.ok) {
        setActionError(t("settings.runtimes.installFailed", { error: res.error ?? "" }));
      }
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  const doCopyPath = async () => {
    if (!state.activePath) return;
    try {
      await navigator.clipboard.writeText(state.activePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用静默忽略
    }
  };

  const installing = busy || state.installing;
  const showProgress = installing && progress !== undefined;
  const version = state.installedVersion ?? state.activeVersion ?? state.expectedVersion;

  return (
    <div
      className={cn(
        "relative flex flex-col justify-between rounded-xl border bg-surface p-4 transition-all duration-200",
        state.installed
          ? "border-edge shadow-xs hover:border-edge-strong"
          : "border-dashed border-edge/80 bg-surface/60",
      )}
    >
      {/* 头部：品牌图标 + 名称 + 描述 + 状态徽章 */}
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-edge bg-surface-muted/60 p-2">
              <BrandIcon size={22} className={brand.color} />
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-content leading-tight">
                {meta.label}
              </h4>
              <p className="mt-0.5 line-clamp-1 text-[0.7143em] text-content-subtle" title={t(meta.descKey)}>
                {t(meta.descKey)}
              </p>
            </div>
          </div>
          <StatusBadge state={state} />
        </div>

        {/* 关键指标与属性展示 */}
        <div className="mt-3.5 space-y-1.5 rounded-lg border border-edge/60 bg-surface-muted/30 p-2.5 text-xs">
          {/* 版本 */}
          <div className="flex items-center justify-between text-[0.7857em]">
            <span className="text-content-subtle">{t("settings.runtimes.field.version")}</span>
            <span className="font-mono font-medium text-content">
              {version ? `v${version}` : "—"}
            </span>
          </div>

          {/* 来源 */}
          <div className="flex items-center justify-between text-[0.7857em]">
            <span className="text-content-subtle">{t("settings.runtimes.field.source")}</span>
            <span className="text-content-muted">{sourceLabel(state, t)}</span>
          </div>

          {/* 磁盘占用 */}
          {state.installed && state.diskBytes > 0 && (
            <div className="flex items-center justify-between text-[0.7857em]">
              <span className="text-content-subtle">{t("settings.runtimes.field.size")}</span>
              <span className="font-mono text-content-muted">{formatBytes(state.diskBytes)}</span>
            </div>
          )}
        </div>

        {/* 检查结果横幅 */}
        {check && !installing && (
          <CheckVerdictBanner
            check={check}
            gateBlockedVersion={gateBlockedVersion}
            installing={installing}
            onUpdate={(v, force) => void doInstallVersion(v, force)}
          />
        )}

        {/* 安装过程实时进度条与阶段指示 */}
        {showProgress && (
          <div className="mt-3 space-y-1.5 rounded-lg border border-accent/20 bg-accent/5 p-2.5">
            <div className="flex items-center justify-between text-[0.75em] text-accent">
              <div className="flex items-center gap-1.5">
                <IconLoader2 size={12} className="animate-spin" />
                <span>
                  {progress !== undefined && progress >= 0
                    ? t("settings.runtimes.phaseDownloading", { pct: Math.round(progress * 100) })
                    : t("settings.runtimes.phaseExtracting")}
                </span>
              </div>
              {progress !== undefined && progress >= 0 && (
                <span className="font-mono font-medium">{Math.round(progress * 100)}%</span>
              )}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-accent/20">
              <div
                className={cn(
                  "h-full rounded-full bg-accent transition-[width] duration-150",
                  progress === -1 && "w-1/3 animate-pulse",
                )}
                style={
                  progress !== undefined && progress >= 0
                    ? { width: `${Math.round(progress * 100)}%` }
                    : undefined
                }
              />
            </div>
          </div>
        )}

        {/* 重启提示 */}
        {needsRestart && !installing && (
          <div className="mt-2.5 flex items-start gap-1.5 rounded-md bg-warning/10 px-2.5 py-1.5 text-[0.75em] text-warning">
            <IconAlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="leading-snug">{t("settings.runtimes.restartRequired")}</span>
          </div>
        )}

        {/* 异常错误提示 */}
        {(actionError || state.lastError) && (
          <div className="mt-2.5 flex items-start gap-1.5 rounded-md bg-danger/10 px-2.5 py-1.5 text-[0.75em] text-danger">
            <IconAlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="break-all leading-snug">{actionError ?? state.lastError}</span>
          </div>
        )}

        {/* 高级信息折叠区 */}
        {expanded && (
          <div className="mt-3 space-y-2 rounded-lg border border-edge bg-surface-muted/40 p-2.5 text-xs">
            {/* 上一版本 (可回滚) */}
            {state.previousVersion && (
              <div className="flex items-center justify-between">
                <span className="text-[0.75em] text-content-subtle">
                  {t("settings.runtimes.field.previousVersion")}
                </span>
                <div className="flex items-center gap-1 font-mono text-[0.7857em]">
                  <span>v{state.previousVersion}</span>
                  <button
                    type="button"
                    onClick={doRollback}
                    disabled={installing}
                    className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-accent hover:bg-accent/10 disabled:opacity-50"
                  >
                    <IconArrowBackUp size={11} />
                    <span>{t("settings.runtimes.rollbackTo", { v: state.previousVersion })}</span>
                  </button>
                </div>
              </div>
            )}

            {/* 路径详情 */}
            {state.activePath && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[0.75em] text-content-subtle">
                  <span>{t("settings.runtimes.field.path")}</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={doCopyPath}
                      className="rounded p-0.5 text-content-muted hover:text-content"
                      title={t("settings.runtimes.copy")}
                    >
                      {copied ? <IconCheck size={12} className="text-accent" /> : <IconCopy size={12} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => void api.shell.showItemInFolder({ path: state.activePath! })}
                      className="rounded p-0.5 text-content-muted hover:text-content"
                      title={t("settings.runtimes.openFolder")}
                    >
                      <IconFolderOpen size={12} />
                    </button>
                  </div>
                </div>
                <div className="truncate rounded border border-edge/60 bg-surface px-1.5 py-1 font-mono text-[0.7143em] text-content-muted" title={state.activePath}>
                  {state.activePath}
                </div>
              </div>
            )}

            {/* 离线本地包安装入口 */}
            <div className="pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={doInstallLocal}
                disabled={installing}
                className="w-full justify-center text-xs"
              >
                <IconFileImport size={12} />
                <span>{t("settings.runtimes.installLocal")}</span>
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* 底部操作工具栏 */}
      <div className="mt-4 pt-3 border-t border-edge/70 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-[0.75em] text-content-subtle hover:text-content transition-colors"
        >
          <span>{t("settings.runtimes.advancedOptions")}</span>
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </button>

        <div className="flex items-center gap-1.5">
          {!state.installed ? (
            <Button
              variant={state.source === null ? "primary" : "outline"}
              size="sm"
              onClick={doInstall}
              disabled={installing}
            >
              {installing ? (
                <IconLoader2 size={13} className="animate-spin" />
              ) : (
                <IconDownload size={13} />
              )}
              <span>{t("settings.runtimes.install")}</span>
            </Button>
          ) : (
            <>
              {state.updateAvailable && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={doInstall}
                  disabled={installing}
                >
                  {installing ? (
                    <IconLoader2 size={13} className="animate-spin" />
                  ) : (
                    <IconDownload size={13} />
                  )}
                  <span>{t("settings.runtimes.installExpected", { v: state.expectedVersion })}</span>
                </Button>
              )}

              <Button
                variant="ghost"
                size="sm"
                onClick={doInstall}
                disabled={installing}
                title={t("settings.runtimes.reinstall")}
              >
                {installing ? <IconLoader2 size={13} className="animate-spin" /> : <IconRefresh size={13} />}
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={doRemove}
                disabled={installing}
                className="text-danger hover:bg-danger/10 hover:text-danger"
                title={t("settings.runtimes.remove")}
              >
                <IconTrash size={13} />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── 检查结果横幅 ───────────────────────── */

function CheckVerdictBanner({
  check,
  gateBlockedVersion,
  installing,
  onUpdate,
}: {
  check: RuntimeCheckResult;
  gateBlockedVersion: string | null;
  installing: boolean;
  onUpdate: (version: string, force: boolean) => void;
}) {
  const { t } = useI18n();
  const v = check.latestVersion;

  let tone = "border-edge bg-surface-muted/40 text-content-subtle";
  let text = "";
  let hint: string | null = null;
  let action: { label: string; danger?: boolean; onClick: () => void } | null = null;

  switch (check.verdict) {
    case "up-to-date":
      text = v ? t("settings.runtimes.verdict.upToDate", { v }) : "";
      break;
    case "ok":
      tone = "border-accent/30 bg-accent/5 text-accent";
      text = v ? t("settings.runtimes.verdict.ok", { v }) : "";
      action = v
        ? { label: t("settings.runtimes.updateTo", { v }), onClick: () => onUpdate(v, false) }
        : null;
      break;
    case "untested":
      tone = "border-warning/30 bg-warning/5 text-warning";
      if (!v) {
        text = check.reasons.includes("registry-missing")
          ? t("settings.runtimes.verdict.registryMissing")
          : t("settings.runtimes.verdict.registryError");
      } else {
        text = t("settings.runtimes.verdict.untested", { v });
      }
      break;
    case "blocked": {
      tone = "border-danger/30 bg-danger/5 text-danger";
      const reason = check.reasons.find((r) => r.startsWith("broken:"))?.slice("broken:".length) ?? "";
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
    <div className={cn("mt-2 rounded-lg border p-2 text-xs", tone)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 leading-relaxed">
          <span className="block break-words font-medium">{text}</span>
          {hint && <span className="mt-0.5 block break-words opacity-80">{hint}</span>}
          {gateBlockedVersion && (
            <span className="mt-0.5 block break-words text-warning">
              {t("settings.runtimes.gateBlockedHint")}
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
            <Button
              variant={action.danger ? "outline" : "primary"}
              size="sm"
              disabled={installing}
              onClick={action.onClick}
              className={cn(action.danger && "text-danger hover:text-danger")}
            >
              {action.label}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

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

function StatusBadge({ state }: { state: RuntimeAgentState }) {
  const { t } = useI18n();
  if (state.installing) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[0.7143em] font-medium text-accent">
        <IconLoader2 size={10} className="animate-spin" />
        {t("settings.runtimes.statusInstalling")}
      </span>
    );
  }
  if (state.updateAvailable) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full bg-warning/10 px-2 py-0.5 text-[0.7143em] font-medium text-warning">
        {t("settings.runtimes.statusUpdate")}
      </span>
    );
  }
  if (state.installed) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[0.7143em] font-medium text-accent">
        <IconCheck size={10} />
        {t("settings.runtimes.statusInstalled")}
      </span>
    );
  }
  if (state.source === "dev" || state.source === "bundled") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 text-[0.7143em] font-medium text-content-muted">
        {state.source === "dev"
          ? t("settings.runtimes.statusDev")
          : t("settings.runtimes.statusBundled")}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 text-[0.7143em] font-medium text-content-subtle">
      <IconX size={10} />
      {t("settings.runtimes.statusNotInstalled")}
    </span>
  );
}

/* ───────────────────────── 终端命令行环境模块 ───────────────────────── */

function cliSemver(version: string | undefined): string | null {
  if (!version) return null;
  const m = version.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*/);
  return m ? m[0] : null;
}

function TerminalCliSection() {
  const { t } = useI18n();
  const [clis, setClis] = useState<TerminalCliStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = async (): Promise<void> => {
    try {
      const res = await api.terminal.cliList();
      setClis(res.clis);
    } catch (err) {
      console.error("terminal.cliList failed:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  return (
    <SettingsSection
      title={t("settings.terminalCli.section")}
      desc={t("settings.terminalCli.sectionDesc")}
      icon={IconTerminal2}
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 px-4 py-8 text-xs text-content-subtle">
          <IconLoader2 size={14} className="animate-spin text-accent" />
          <span>{t("settings.terminalCli.loading")}</span>
        </div>
      ) : (
        <div className="divide-y divide-edge">
          {clis.map((cli) => (
            <TerminalCliRow
              key={cli.providerId}
              cli={cli}
              onReload={reload}
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

function TerminalCliRow({
  cli,
  onReload,
}: {
  cli: TerminalCliStatus;
  onReload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const enabled = useSessionStore((s) => s.terminalCliEnabled[cli.providerId] !== false);
  const setTerminalCliEnabled = useSessionStore((s) => s.setTerminalCliEnabled);
  const brand = getProviderIcon(cli.providerId);
  const BrandIcon = brand.Icon;

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const label = TERMINAL_CLI_FALLBACK_LABELS[cli.providerId] ?? cli.providerId;
  const current = cliSemver(cli.version);

  const doInstall = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.terminal.cliInstall({ providerId: cli.providerId });
      if (!res.ok) {
        setActionError(
          res.error === "npm-removed"
            ? t("settings.terminalCli.npmRemovedHint")
            : t("settings.terminalCli.installFailed", { error: res.error ?? "" }),
        );
      }
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  const doUninstall = async () => {
    if (!confirm(t("settings.terminalCli.removeConfirm", { name: label }))) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.terminal.cliUninstall({ providerId: cli.providerId });
      if (!res.ok) {
        setActionError(
          res.error === "npm-removed"
            ? t("settings.terminalCli.npmRemovedHint")
            : t("settings.terminalCli.uninstallFailed", { error: res.error ?? "" }),
        );
      }
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  const detail = cli.installed
    ? [current ? `v${current}` : cli.version, cli.path].filter(Boolean).join(" · ")
    : cli.manageMode === "npm"
      ? (cli.packageName ?? "")
      : t("settings.terminalCli.externalHint");

  return (
    <div className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-surface-hover/30">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* 左侧：品牌图标 + 名称 + 状态徽章 */}
        <div className="flex items-center gap-2.5 min-w-44">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-edge bg-surface-muted/60 p-1.5">
            <BrandIcon size={16} className={brand.color} />
          </div>
          <div>
            <span className="text-xs font-semibold text-content">{label}</span>
          </div>
          {!enabled ? (
            <span className="inline-flex shrink-0 items-center rounded-full bg-surface-hover px-1.5 py-0.5 text-[0.6875em] text-content-subtle">
              {t("settings.terminalCli.statusDisabled")}
            </span>
          ) : cli.installed ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-1.5 py-0.5 text-[0.6875em] text-accent">
              <IconCheck size={9} />
              {t("settings.terminalCli.statusInstalled")}
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-hover px-1.5 py-0.5 text-[0.6875em] text-content-subtle">
              <IconX size={9} />
              {t("settings.terminalCli.statusNotInstalled")}
            </span>
          )}
        </div>

        {/* 中间：版本与路径 */}
        <div
          className="min-w-0 flex-1 truncate text-left text-xs text-content-subtle font-mono"
          title={cli.path ?? detail}
        >
          {detail}
        </div>

        {/* 右侧：开关与动作 */}
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={(v) => setTerminalCliEnabled(cli.providerId, v)}
            label={enabled ? t("settings.on") : t("settings.off")}
          />

          {cli.manageMode === "npm" ? (
            <>
              {!cli.installed ? (
                <Button variant="primary" size="sm" onClick={doInstall} disabled={busy}>
                  {busy ? <IconLoader2 size={12} className="animate-spin" /> : <IconDownload size={12} />}
                  <span>{t("settings.terminalCli.install")}</span>
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={doUninstall}
                  disabled={busy}
                  className="text-danger hover:bg-danger/10"
                >
                  <IconTrash size={12} />
                  <span>{t("settings.terminalCli.uninstall")}</span>
                </Button>
              )}
            </>
          ) : (
            !cli.installed && (
              <Button variant="primary" size="sm" onClick={doInstall} disabled={busy}>
                {busy ? <IconLoader2 size={12} className="animate-spin" /> : <IconDownload size={12} />}
                <span>{t("settings.terminalCli.download")}</span>
              </Button>
            )
          )}
        </div>
      </div>

      {/* 异常错误 */}
      {actionError && (
        <div className="flex items-start gap-1.5 rounded-md bg-danger/10 px-2.5 py-1 text-xs text-danger">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="break-all">{actionError}</span>
        </div>
      )}
    </div>
  );
}
