/**
 * Plugins settings panel (docs/plugin-feasibility.md v1).
 *
 * Two sections:
 *  - Installed: one expandable row per plugin (component chips + enable
 *    switch + uninstall); the expanded area shows the component inventory
 *    (skills / commands / agents / MCP servers / hooks) and the per-provider
 *    support matrix, so "what actually works where" is never a guess.
 *  - Discover: user-added marketplaces (git URL or local dir) with their
 *    catalog entries, plus direct install sources (git URL / local dir / zip).
 *
 * Security posture (feasibility §3.4): installs land DISABLED; the
 * component-review dialog pops on success and enabling is an explicit click.
 * Plugins with hooks get an extra confirmation that states OPENLY that hooks
 * are parsed but never executed in v1 — 静默 no-op 比明示不完整更糟. The
 * same inventory component renders inside the review dialog and the row's
 * expanded area (one source of truth for what a plugin contains).
 *
 * Panel-local state throughout (like McpPanel): the data has no consumers
 * outside this panel, so nothing goes into the session store. Every mutation
 * RPC resolves when done and ends with a full re-list — no push channel.
 */
import { useCallback, useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, Input, Dialog, ConfirmDialog, Switch } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import type { PluginState, PluginMarketplaceState } from "@contracts/ipc";
import {
  IconPuzzle,
  IconLoader2,
  IconTrash,
  IconAlertTriangle,
  IconChevronRight,
  IconChevronDown,
  IconFolderOpen,
  IconFileZip,
  IconPlus,
  IconRefresh,
  IconGitBranch,
} from "@renderer/lib/icons.js";

const EMPTY_PLUGINS: PluginState[] = [];
const EMPTY_MARKETPLACES: PluginMarketplaceState[] = [];

export function PluginsPanel() {
  const { t } = useI18n();
  const [plugins, setPlugins] = useState<PluginState[]>(EMPTY_PLUGINS);
  const [marketplaces, setMarketplaces] = useState<PluginMarketplaceState[]>(EMPTY_MARKETPLACES);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Key of the in-flight action (disables just that control).
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Post-install review dialog: shown for every successful install; enabling
  // is an explicit click inside it (installs land disabled).
  const [review, setReview] = useState<PluginState | null>(null);
  // Confirmation before enabling a plugin that declares hooks (the panel must
  // say the hooks won't run — never let the user assume they will).
  const [hookWarn, setHookWarn] = useState<PluginState | null>(null);
  const [pendingRemove, setPendingRemove] = useState<PluginState | null>(null);

  const reload = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([api.plugins.list(), api.plugins.marketplaceList()]);
      setPlugins(p.plugins ?? EMPTY_PLUGINS);
      setMarketplaces(m.marketplaces ?? EMPTY_MARKETPLACES);
    } catch (err) {
      console.error("PluginsPanel load failed:", err);
      setError((err as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Shared tail of every install RPC: surface errors, pop the review dialog
   *  on success, re-list so the row appears. */
  const afterInstall = async (
    res: { ok: boolean; error?: string; plugin?: PluginState },
    key: string,
  ) => {
    setBusyKey(null);
    if (!res.ok) {
      setError(t("settings.plugins.installFailed", { error: res.error ?? "" }));
      return;
    }
    setError(null);
    if (res.plugin) setReview(res.plugin);
    await reload();
  };

  const installFromDir = async () => {
    const { path } = await api.pickFolder();
    if (!path) return;
    setBusyKey("install:local");
    setError(null);
    try {
      await afterInstall(await api.plugins.installLocal({ localPath: path }), "install:local");
    } catch (err) {
      setBusyKey(null);
      setError((err as Error).message);
    }
  };

  const installFromZip = async () => {
    const { paths } = await api.pickFiles({ title: t("settings.plugins.pickZip") });
    const zip = paths?.[0];
    if (!zip) return;
    setBusyKey("install:zip");
    setError(null);
    try {
      await afterInstall(await api.plugins.installLocal({ localPath: zip }), "install:zip");
    } catch (err) {
      setBusyKey(null);
      setError((err as Error).message);
    }
  };

  /* ── enable / remove ── */

  const applyEnable = async (name: string, enabled: boolean) => {
    setBusyKey(`toggle:${name}`);
    setError(null);
    try {
      const res = await api.plugins.setEnabled({ name, enabled });
      if (!res.ok) setError(t("settings.plugins.enableFailed", { error: res.error ?? "" }));
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  /** Enable flow with the hooks gate: plugins declaring hooks get an explicit
   *  "these won't run" confirmation first. */
  const requestEnable = (p: PluginState) => {
    if (p.components.hooks.length > 0) setHookWarn(p);
    else void applyEnable(p.name, true);
  };

  const confirmRemove = async () => {
    const target = pendingRemove;
    if (!target) return;
    setBusyKey(`remove:${target.name}`);
    setError(null);
    try {
      const res = await api.plugins.remove({ name: target.name });
      if (!res.ok) setError(t("settings.plugins.removeFailed", { error: res.error ?? "" }));
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPendingRemove(null);
      setBusyKey(null);
    }
  };

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader title={t("settings.plugins.title")} icon={IconPuzzle} />

      {error && (
        <div className="flex items-start justify-between gap-2 rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[0.7857em] text-danger">
          <span className="break-all">{error}</span>
          <button className="shrink-0 text-content-subtle hover:text-content" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {/* ───────── 已安装 ───────── */}
      <SettingsSection
        title={t("settings.plugins.installedSection")}
        desc={t("settings.plugins.installedSectionDesc")}
      >
        {!loaded ? (
          <div className="flex items-center justify-center gap-2 px-4 py-8 text-[0.85em] text-content-subtle">
            <IconLoader2 size={14} className="animate-spin" />
            {t("settings.plugins.loading")}
          </div>
        ) : plugins.length === 0 ? (
          <div className="px-4 py-5 text-center text-[0.7143em] leading-relaxed text-content-subtle">
            {t("settings.plugins.empty")}
          </div>
        ) : (
          plugins.map((p) => (
            <PluginRow
              key={p.name}
              plugin={p}
              busy={busyKey}
              onToggle={p.enabled ? () => void applyEnable(p.name, false) : () => requestEnable(p)}
              onRemove={() => setPendingRemove(p)}
            />
          ))
        )}
        {/* Install sources: git URL form + local dir + zip pickers. */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          <GitInstallForm
            busy={busyKey === "install:git"}
            onBusy={() => setBusyKey("install:git")}
            onDone={(res) => void afterInstall(res, "install:git")}
            onError={(msg) => setError(msg)}
          />
          <Button variant="ghost" size="sm" onClick={() => void installFromDir()} className="gap-1" disabled={!!busyKey}>
            <IconFolderOpen size={12} />
            {t("settings.plugins.installDir")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void installFromZip()} className="gap-1" disabled={!!busyKey}>
            <IconFileZip size={12} />
            {t("settings.plugins.installZip")}
          </Button>
        </div>
      </SettingsSection>

      {/* ───────── 插件市场 ───────── */}
      <MarketplaceSection
        marketplaces={marketplaces}
        loaded={loaded}
        busyKey={busyKey}
        setBusyKey={setBusyKey}
        onError={(msg) => setError(msg)}
        reload={reload}
        afterInstall={afterInstall}
      />

      {/* ── Dialogs ── */}
      <PluginReviewDialog
        plugin={review}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
        onEnable={(p) => {
          setReview(null);
          requestEnable(p);
        }}
      />

      <ConfirmDialog
        open={hookWarn != null}
        title={t("settings.plugins.hooksWarnTitle")}
        description={
          hookWarn &&
          t("settings.plugins.hooksWarnDesc", {
            name: hookWarn.name,
            n: hookWarn.components.hooks.length,
          })
        }
        confirmText={t("common.confirm")}
        onOpenChange={(open) => {
          if (!open) setHookWarn(null);
        }}
        onConfirm={() => {
          const p = hookWarn;
          setHookWarn(null);
          if (p) void applyEnable(p.name, true);
        }}
      />

      <ConfirmDialog
        open={pendingRemove != null}
        title={t("settings.plugins.removeConfirmTitle")}
        danger
        description={
          pendingRemove &&
          t("settings.plugins.removeConfirmDesc", { name: pendingRemove.name })
        }
        confirmText={t("common.delete")}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        onConfirm={() => void confirmRemove()}
      />
    </section>
  );
}

/* ───────────────────────── plugin row ───────────────────────── */

function PluginRow({
  plugin,
  busy,
  onToggle,
  onRemove,
}: {
  plugin: PluginState;
  /** Global busy key — disables this row's controls while any action runs. */
  busy: string | null;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const rowBusy = busy === `toggle:${plugin.name}` || busy === `remove:${plugin.name}`;
  const c = plugin.components;

  const chips: Array<{ key: MessageId; n: number; warn?: boolean }> = [
    { key: "settings.plugins.cmpSkills", n: c.skills.length },
    { key: "settings.plugins.cmpCommands", n: c.commands.length },
    { key: "settings.plugins.cmpAgents", n: c.agents.length },
    { key: "settings.plugins.cmpMcp", n: c.mcpServers.length },
    { key: "settings.plugins.cmpHooks", n: c.hooks.length, warn: true },
  ];

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <IconChevronDown size={14} className="shrink-0 text-content-subtle" />
          ) : (
            <IconChevronRight size={14} className="shrink-0 text-content-subtle" />
          )}
          <span className="truncate text-[0.86em] font-medium text-content">{plugin.name}</span>
          <span className="shrink-0 rounded bg-surface-muted px-1 py-0.5 text-[0.66em] font-mono text-content-muted">
            v{plugin.version}
          </span>
          {plugin.enabled ? (
            <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[0.66em] text-accent">
              {t("settings.plugins.enabled")}
            </span>
          ) : (
            <span className="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-[0.66em] text-content-subtle">
              {t("settings.plugins.disabled")}
            </span>
          )}
        </button>
        <Switch
          checked={plugin.enabled}
          onCheckedChange={onToggle}
          disabled={rowBusy || !!busy?.startsWith("install:")}
          label={t(plugin.enabled ? "settings.plugins.disableAction" : "settings.plugins.enableAction", { name: plugin.name })}
        />
        <Button
          variant="ghost"
          size="icon"
          title={t("settings.plugins.remove")}
          onClick={onRemove}
          disabled={rowBusy}
        >
          <IconTrash size={13} className="text-content-subtle" />
        </Button>
      </div>

      {plugin.description && (
        <p className="mt-1 truncate pl-[22px] text-[0.7143em] text-content-muted">
          {plugin.description}
        </p>
      )}

      {/* Component chips — the at-a-glance inventory. Hooks render amber. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-[22px]">
        {chips.map(({ key, n, warn }) =>
          n > 0 ? (
            <span
              key={key}
              className={cn(
                "rounded px-1.5 py-0.5 text-[0.64em]",
                warn ? "bg-warning/10 text-warning" : "bg-surface-muted text-content-subtle",
              )}
            >
              {t(key)} {n}
            </span>
          ) : null,
        )}
        {chips.every(({ n }) => n === 0) && (
          <span className="text-[0.64em] text-content-subtle">{t("settings.plugins.noComponents")}</span>
        )}
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 rounded border border-edge bg-surface-muted/40 p-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.66em] text-content-subtle">
            <span>
              {t("settings.plugins.sourceLabel")}:{" "}
              {t(sourceLabelKey(plugin.source.kind))}
              {plugin.source.ref && (
                <span className="ml-1 font-mono break-all">{plugin.source.ref}</span>
              )}
            </span>
            {plugin.installedAt && (
              <span>
                {t("settings.plugins.installedAt", {
                  time: new Date(plugin.installedAt).toLocaleString(),
                })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.66em] text-content-subtle">
            <span>{t("settings.plugins.matrixSkills")}</span>
            <span>{t("settings.plugins.matrixMcp")}</span>
            <span>{t("settings.plugins.matrixCommands")}</span>
            <span className="text-warning">{t("settings.plugins.matrixHooks")}</span>
          </div>
          <div className="text-[0.66em] text-content-subtle">
            {t("settings.plugins.pathLabel")}: <span className="font-mono break-all">{plugin.rootDir}</span>
          </div>
          <ComponentDetails plugin={plugin} />
        </div>
      )}
    </div>
  );
}

function sourceLabelKey(kind: PluginState["source"]["kind"]): MessageId {
  switch (kind) {
    case "local-dir":
      return "settings.plugins.source.local-dir";
    case "local-zip":
      return "settings.plugins.source.local-zip";
    case "git":
      return "settings.plugins.source.git";
    case "marketplace":
      return "settings.plugins.source.marketplace";
    default:
      return "settings.plugins.source.unknown";
  }
}

/* ─────────────────── component inventory ─────────────────── */

/** The plugin's declarative inventory — rendered identically in the row's
 *  expanded area and the install-review dialog (one source of truth). MCP
 *  commands/urls and hook commands are exactly what would run, spelled out. */
function ComponentDetails({ plugin }: { plugin: PluginState }) {
  const { t } = useI18n();
  const c = plugin.components;

  const namedList = (
    title: string,
    items: Array<{ name: string; description: string }>,
    prefix = "",
  ) =>
    items.length > 0 && (
      <div>
        <div className="mb-1 text-[0.66em] font-semibold uppercase tracking-wide text-content-subtle">
          {title} · {items.length}
        </div>
        <ul className="space-y-1">
          {items.map((s) => (
            <li key={s.name} className="text-[0.66em] leading-relaxed">
              <span className="font-mono text-content">
                {prefix}
                {s.name}
              </span>
              {s.description && <span className="ml-1.5 text-content-subtle">— {s.description}</span>}
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <div className="space-y-3">
      {namedList(t("settings.plugins.cmpSkills"), c.skills)}
      {namedList(t("settings.plugins.cmpCommands"), c.commands, "/")}
      {namedList(t("settings.plugins.cmpAgents"), c.agents)}

      {c.mcpServers.length > 0 && (
        <div>
          <div className="mb-1 text-[0.66em] font-semibold uppercase tracking-wide text-content-subtle">
            {t("settings.plugins.cmpMcp")} · {c.mcpServers.length}
          </div>
          <ul className="space-y-1">
            {c.mcpServers.map((s) => (
              <li key={s.name} className="text-[0.66em] leading-relaxed">
                <span className="rounded bg-surface-muted px-1 py-0.5 font-mono text-[0.92em] text-content-muted">
                  {s.kind}
                </span>{" "}
                <span className="font-mono text-content">{s.name}</span>
                <span className="ml-1.5 break-all font-mono text-content-subtle">{s.detail}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[0.64em] text-content-subtle">
            {t("settings.plugins.reviewMcpNote")}
          </p>
        </div>
      )}

      {c.hooks.length > 0 && (
        <div className="rounded border border-warning/40 bg-warning/5 p-2">
          <div className="mb-1 flex items-center gap-1 text-[0.66em] font-semibold text-warning">
            <IconAlertTriangle size={12} />
            {t("settings.plugins.hooksNotExecuted", { n: c.hooks.length })}
          </div>
          <ul className="space-y-1">
            {c.hooks.map((h, i) => (
              <li key={i} className="break-all text-[0.64em] leading-relaxed text-content-muted">
                <span className="font-mono text-content">{h.event}</span>
                {h.matcher && <span className="font-mono"> ({h.matcher})</span>}:{" "}
                <span className="font-mono">{h.command}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ─────────────────── install-review dialog ─────────────────── */

function PluginReviewDialog({
  plugin,
  onOpenChange,
  onEnable,
}: {
  plugin: PluginState | null;
  onOpenChange: (open: boolean) => void;
  onEnable: (plugin: PluginState) => void;
}) {
  const { t } = useI18n();
  if (!plugin) return null;
  return (
    <Dialog.Root open={plugin != null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[80vh] w-[560px] flex-col p-0">
          <Dialog.Title className="px-4 pt-4">
            {t("settings.plugins.reviewTitle")} · {plugin.name}{" "}
            <span className="font-mono text-[0.85em] text-content-muted">v{plugin.version}</span>
          </Dialog.Title>
          <Dialog.Description className="px-4 pt-1">
            {t("settings.plugins.reviewDesc")}
          </Dialog.Description>
          <Dialog.Close />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {plugin.description && (
              <p className="mb-3 text-[0.7857em] text-content-muted">{plugin.description}</p>
            )}
            <ComponentDetails plugin={plugin} />
          </div>
          <div className="flex justify-end gap-2 border-t border-edge px-4 py-3">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("settings.plugins.reviewLater")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => onEnable(plugin)}>
              {t("settings.plugins.reviewEnable")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ─────────────────── git install form ─────────────────── */

function GitInstallForm({
  busy,
  onBusy,
  onDone,
  onError,
}: {
  busy: boolean;
  onBusy: () => void;
  onDone: (res: { ok: boolean; error?: string; plugin?: PluginState }) => void;
  onError: (msg: string) => void;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");

  const submit = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    onBusy();
    try {
      const res = await api.plugins.installGit({
        url: trimmed,
        ...(ref.trim() ? { ref: ref.trim() } : {}),
      });
      setUrl("");
      setRef("");
      onDone(res);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <div className="flex min-w-[260px] flex-1 items-center gap-1.5">
      <IconGitBranch size={12} className="shrink-0 text-content-subtle" />
      <Input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={t("settings.plugins.gitPlaceholder")}
        className="h-7 flex-1 text-[0.7857em]"
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      <Input
        value={ref}
        onChange={(e) => setRef(e.target.value)}
        placeholder={t("settings.plugins.gitRefPlaceholder")}
        className="h-7 w-24 text-[0.7857em]"
        spellCheck={false}
      />
      <Button variant="secondary" size="sm" onClick={() => void submit()} disabled={busy || !url.trim()}>
        {busy ? <IconLoader2 size={12} className="animate-spin" /> : <IconPlus size={12} />}
        {t("settings.plugins.installGitAction")}
      </Button>
    </div>
  );
}

/* ─────────────────── marketplace section ─────────────────── */

function MarketplaceSection({
  marketplaces,
  loaded,
  busyKey,
  setBusyKey,
  onError,
  reload,
  afterInstall,
}: {
  marketplaces: PluginMarketplaceState[];
  loaded: boolean;
  busyKey: string | null;
  setBusyKey: (k: string | null) => void;
  onError: (msg: string | null) => void;
  reload: () => Promise<void>;
  afterInstall: (
    res: { ok: boolean; error?: string; plugin?: PluginState },
    key: string,
  ) => Promise<void>;
}) {
  const { t } = useI18n();
  const [mpUrl, setMpUrl] = useState("");

  const addGit = async () => {
    const trimmed = mpUrl.trim();
    if (!trimmed) return;
    setBusyKey("mp:add");
    onError(null);
    try {
      const res = await api.plugins.marketplaceAdd({ kind: "git", ref: trimmed });
      if (!res.ok) onError(t("settings.plugins.mpAddFailed", { error: res.error ?? "" }));
      else setMpUrl("");
      await reload();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const addLocal = async () => {
    const { path } = await api.pickFolder();
    if (!path) return;
    setBusyKey("mp:add");
    onError(null);
    try {
      const res = await api.plugins.marketplaceAdd({ kind: "local", ref: path });
      if (!res.ok) onError(t("settings.plugins.mpAddFailed", { error: res.error ?? "" }));
      await reload();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const mpAction = async (name: string, action: "refresh" | "remove") => {
    setBusyKey(`mp:${action}:${name}`);
    onError(null);
    try {
      const res =
        action === "refresh"
          ? await api.plugins.marketplaceRefresh({ name })
          : await api.plugins.marketplaceRemove({ name });
      if (!res.ok) {
        onError(
          t(
            action === "refresh"
              ? "settings.plugins.mpRefreshFailed"
              : "settings.plugins.mpRemoveFailed",
            { error: res.error ?? "" },
          ),
        );
      }
      await reload();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const installEntry = async (marketplace: string, name: string) => {
    setBusyKey(`mpEntry:${marketplace}/${name}`);
    onError(null);
    try {
      const res = await api.plugins.installMarketplace({ marketplace, name });
      await afterInstall(res, `mpEntry:${marketplace}/${name}`);
    } catch (err) {
      onError((err as Error).message);
      setBusyKey(null);
    }
  };

  return (
    <SettingsSection
      title={t("settings.plugins.marketplaceSection")}
      desc={t("settings.plugins.marketplaceSectionDesc")}
    >
      {/* Add row: git URL form + local dir picker. */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <div className="flex min-w-[260px] flex-1 items-center gap-1.5">
          <IconPuzzle size={12} className="shrink-0 text-content-subtle" />
          <Input
            value={mpUrl}
            onChange={(e) => setMpUrl(e.target.value)}
            placeholder={t("settings.plugins.mpAddPlaceholder")}
            className="h-7 flex-1 text-[0.7857em]"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addGit();
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void addGit()}
            disabled={busyKey === "mp:add" || !mpUrl.trim()}
          >
            {busyKey === "mp:add" ? (
              <IconLoader2 size={12} className="animate-spin" />
            ) : (
              <IconPlus size={12} />
            )}
            {t("settings.plugins.mpAdd")}
          </Button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void addLocal()}
          className="gap-1"
          disabled={!!busyKey}
        >
          <IconFolderOpen size={12} />
          {t("settings.plugins.mpAddLocal")}
        </Button>
      </div>

      {loaded && marketplaces.length === 0 && (
        <div className="px-4 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.plugins.mpEmpty")}
        </div>
      )}

      {marketplaces.map((mp) => (
        <div key={mp.name} className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-[0.86em] font-medium text-content">{mp.name}</span>
            <span className="rounded bg-surface-muted px-1 py-0.5 text-[0.66em] text-content-subtle">
              {mp.sourceKind === "git" ? "git" : t("settings.plugins.source.local-dir")}
            </span>
            <span className="text-[0.66em] text-content-subtle">
              {t("settings.plugins.mpPluginCount", { n: mp.plugins.length })}
            </span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="icon"
              title={t("settings.plugins.mpRefresh")}
              onClick={() => void mpAction(mp.name, "refresh")}
              disabled={busyKey != null}
            >
              <IconRefresh size={13} className="text-content-subtle" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title={t("settings.plugins.mpRemove")}
              onClick={() => void mpAction(mp.name, "remove")}
              disabled={busyKey != null}
            >
              <IconTrash size={13} className="text-content-subtle" />
            </Button>
          </div>

          <div className="mt-2 space-y-1.5">
            {mp.plugins.length === 0 ? (
              <div className="text-[0.66em] text-content-subtle">{t("settings.plugins.mpNoEntries")}</div>
            ) : (
              mp.plugins.map((entry) => (
                <div key={entry.name} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[0.7857em] text-content">{entry.name}</span>
                      {entry.version && (
                        <span className="shrink-0 font-mono text-[0.64em] text-content-subtle">
                          v{entry.version}
                        </span>
                      )}
                    </div>
                    {entry.description && (
                      <p className="truncate text-[0.66em] text-content-subtle">{entry.description}</p>
                    )}
                  </div>
                  {entry.installed ? (
                    <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[0.64em] text-accent">
                      {t("settings.plugins.mpInstalled")}
                    </span>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void installEntry(mp.name, entry.name)}
                      disabled={busyKey != null}
                    >
                      {busyKey === `mpEntry:${mp.name}/${entry.name}` ? (
                        <IconLoader2 size={12} className="animate-spin" />
                      ) : (
                        t("settings.plugins.mpInstall")
                      )}
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}
