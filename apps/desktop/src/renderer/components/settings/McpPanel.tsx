/**
 * MCP 服务器管理面板 — Settings 页 "MCP" 菜单。
 *
 * 列出三类 MCP server 并提供开关 / 新增 / 删除 / 导入:
 *  - 用户级:`~/.mcode/.claude.json` 的 mcpServers(所有项目可用,由 claude
 *    binary 自动加载)。关闭 = 配置移出文件暂存到 settings 表;开启 = 移回。
 *  - 项目级:所选项目根的 `.mcp.json`(只读,不写项目文件)。默认关闭——
 *    面板开关替代 CLI 的首次审批弹窗;每轮 startTurn 由 provider 按允许名单
 *    传 enabled/disabledMcpjsonServers。
 *  - 内置:进程内 mcode-browser server(应用内浏览器工具)。
 *
 * 改动自下一轮对话起生效(startTurn 每轮重建 options);仅 Claude 会话生效,
 * Pi 会话使用扩展机制,不受此面板影响。
 */
import { useCallback, useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import {
  Button,
  ConfirmDialog,
  Dialog,
  Select,
  Switch,
} from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import {
  McpIcon,
  IconPlus,
  IconTrash,
  IconDownload,
  IconLoader2,
  IconFolder,
} from "@renderer/lib/icons.js";
import {
  MCP_RESERVED_NAME,
  type McpImportSource,
  type McpKind,
  type McpScope,
  type McpServerConfig,
  type McpServerEntry,
} from "@contracts/ipc";

/** MCP server name charset — mirrored from the zod schema in the contract. */
const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Stable empty array (avoids per-render new references — store convention). */
const EMPTY_SERVERS: McpServerEntry[] = [];

/** Row identity across reloads (a name can exist under multiple scopes). */
function rowKey(s: { scope: McpScope; name: string }): string {
  return `${s.scope}:${s.name}`;
}

/** Transport badge label + tint per kind (same badge family as SkillsPanel). */
const KIND_LABEL: Record<McpKind, string> = {
  stdio: "stdio",
  http: "http",
  sse: "sse",
  builtin: "内置",
};
const KIND_BADGE_CLS: Record<McpKind, string> = {
  stdio: "bg-accent/12 text-accent",
  http: "bg-purple-500/15 text-purple-500",
  sse: "bg-blue-500/15 text-blue-500",
  builtin: "bg-surface-hover text-content-subtle",
};

function KindBadge({ kind }: { kind: McpKind }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 text-[9px] leading-tight",
        KIND_BADGE_CLS[kind],
      )}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

export function McpPanel() {
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);

  // Panel-local project selection (SkillsPanel pattern): independent of the
  // workspace's activeProjectId, defaults to it, scopes the project group.
  const managedProjects = projects.filter((p) => !p.archived);
  const [managedProjectId, setManagedProjectId] = useState<string | null>(
    () => activeProjectId ?? managedProjects[0]?.id ?? null,
  );
  const managedProject = managedProjects.find((p) => p.id === managedProjectId);
  const projectPath = managedProject?.path ?? null;

  const [servers, setServers] = useState<McpServerEntry[]>(EMPTY_SERVERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Row key of an in-flight toggle (disables that row's switch only).
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<McpServerEntry | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { servers: list } = await api.mcp.list(
        projectPath ? { projectPath } : {},
      );
      setServers(list.length ? list : EMPTY_SERVERS);
    } catch (err) {
      console.error("McpPanel load failed:", err);
      setError((err as Error).message);
      setServers(EMPTY_SERVERS);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (s: McpServerEntry) => {
    setError(null);
    setBusyKey(rowKey(s));
    try {
      const res = await api.mcp.toggle({
        name: s.name,
        scope: s.scope,
        projectPath: s.scope === "project" ? projectPath ?? undefined : undefined,
        enabled: !s.enabled,
      });
      if (!res.ok) setError(res.error ?? "操作失败");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    if (!target) return;
    setError(null);
    try {
      const res = await api.mcp.remove({ name: target.name });
      if (!res.ok) setError(res.error ?? "删除失败");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPendingDelete(null);
    }
  };

  const userServers = servers.filter((s) => s.scope === "user");
  const projectServers = servers.filter((s) => s.scope === "project");
  const builtin = servers.find((s) => s.scope === "builtin");

  return (
    <section className="space-y-4">
      <PanelHeader
        title="MCP 服务器"
        icon={McpIcon}
        desc={
          <>
            管理 MCP(Model Context Protocol)server。改动自<strong>下一轮对话</strong>起生效;
            仅 Claude 会话生效(Pi 会话使用扩展机制)。用户级 server 保存在{" "}
            <code className="rounded bg-surface-muted px-0.5">~/.mcode/.claude.json</code>,对所有项目可用。
          </>
        }
      />

      {error && (
        <div className="rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[0.7857em] text-danger">
          {error}
        </div>
      )}

      {/* ───────── 用户级 ───────── */}
      <SettingsSection
        title="用户级"
        desc="保存在 Mcode 自己的 Claude 配置(~/.mcode/.claude.json)中,所有项目可用。关闭的 server 配置会被暂存,重新开启即可恢复。"
      >
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[0.7857em] text-content-subtle">
            <IconLoader2 size={14} className="animate-spin" />
            加载中…
          </div>
        ) : userServers.length === 0 ? (
          <div className="px-4 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
            暂无用户级 server。
            <br />
            点击下方「新增」或「从 Claude CLI 导入」。
          </div>
        ) : (
          userServers.map((s) => (
            <SettingRow
              key={rowKey(s)}
              title={
                <span className="flex items-center gap-1.5">
                  <span className="font-mono">{s.name}</span>
                  <KindBadge kind={s.kind} />
                </span>
              }
              desc={<span className="font-mono">{s.detail}</span>}
            >
              <Switch
                checked={s.enabled}
                onCheckedChange={() => void toggle(s)}
                disabled={busyKey === rowKey(s)}
                label={`${s.enabled ? "关闭" : "开启"} ${s.name}`}
              />
              <Button
                variant="ghost"
                size="icon"
                title="删除此 server"
                onClick={() => setPendingDelete(s)}
              >
                <IconTrash size={13} className="text-content-subtle" />
              </Button>
            </SettingRow>
          ))
        )}
        <div className="flex justify-end gap-2 px-4 py-2.5">
          <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)} className="gap-1">
            <IconDownload size={12} />
            从 Claude CLI 导入
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)} className="gap-1">
            <IconPlus size={12} />
            新增 MCP Server
          </Button>
        </div>
      </SettingsSection>

      {/* ───────── 项目级 ───────── */}
      <SettingsSection
        title="项目级"
        desc={
          <>
            来自所选项目根的 <code className="rounded bg-surface-muted px-0.5">.mcp.json</code>(只读,不会修改项目文件)。
            项目级 server <strong>默认关闭</strong>——开启等同于批准其在该项目的所有会话中加载。
          </>
        }
      >
        {managedProjects.length > 0 ? (
          <div className="flex items-center gap-2 px-4 py-2.5">
            <span className="text-[0.7857em] font-medium text-content-muted">项目:</span>
            <Select.Root
              value={managedProjectId ?? ""}
              onValueChange={(v) => setManagedProjectId(v as string)}
            >
              <Select.Trigger className="min-w-0 flex-1">
                <Select.Value>
                  {(val: string) => {
                    const p = managedProjects.find((x) => x.id === val) ?? managedProjects[0];
                    return (
                      <span className="flex items-center gap-1.5">
                        <IconFolder size={14} className="text-content-muted" />
                        {p ? `${p.name}${p.id === activeProjectId ? " (当前工作区)" : ""}` : ""}
                      </span>
                    );
                  }}
                </Select.Value>
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner>
                  <Select.Popup>
                    <Select.List>
                      {managedProjects.map((p) => (
                        <Select.Item key={p.id} value={p.id}>
                          <IconFolder size={14} className="text-content-muted" />
                          <Select.ItemText>
                            {p.name}
                            {p.id === activeProjectId ? " (当前工作区)" : ""}
                          </Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.List>
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          </div>
        ) : (
          <div className="px-4 py-4 text-center text-[0.7143em] text-content-subtle">
            暂无项目 — 打开项目后可在此管理其 .mcp.json
          </div>
        )}
        {projectPath &&
          (projectServers.length === 0 ? (
            <div className="px-4 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
              {loading ? "…" : "当前项目的 .mcp.json 中没有 MCP server。"}
            </div>
          ) : (
            projectServers.map((s) => (
              <SettingRow
                key={rowKey(s)}
                title={
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono">{s.name}</span>
                    <KindBadge kind={s.kind} />
                  </span>
                }
                desc={
                  <span className="font-mono">
                    {s.detail}
                    {!s.enabled && " · 默认关闭,确认来源后开启"}
                  </span>
                }
              >
                <Switch
                  checked={s.enabled}
                  onCheckedChange={() => void toggle(s)}
                  disabled={busyKey === rowKey(s)}
                  label={`${s.enabled ? "关闭" : "开启"} ${s.name}`}
                />
              </SettingRow>
            ))
          ))}
      </SettingsSection>

      {/* ───────── 内置 ───────── */}
      <SettingsSection title="内置" desc="随应用内置、运行在本进程内的 MCP server。">
        {builtin && (
          <SettingRow
            title={
              <span className="flex items-center gap-1.5">
                <span className="font-mono">{builtin.name}</span>
                <KindBadge kind={builtin.kind} />
              </span>
            }
            desc={builtin.detail}
          >
            <Switch
              checked={builtin.enabled}
              onCheckedChange={() => void toggle(builtin)}
              disabled={busyKey === rowKey(builtin)}
              label={`${builtin.enabled ? "关闭" : "开启"} ${builtin.name}`}
            />
          </SettingRow>
        )}
      </SettingsSection>

      <ConfirmDialog
        open={pendingDelete != null}
        title="删除 MCP server"
        danger
        description={
          <>
            确认删除用户级 server「{pendingDelete?.name}」?
            该配置将从 <code className="rounded bg-surface-muted px-0.5">~/.mcode/.claude.json</code> 中移除(含已关闭的暂存配置),此操作不可撤销。
          </>
        }
        confirmText="删除"
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => void confirmDelete()}
      />

      <AddServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={() => void load()}
      />
      <ImportMcpDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => void load()}
      />
    </section>
  );
}

/* ───────── Add server dialog ───────── */

const inputCls =
  "min-w-0 w-full rounded border border-edge bg-surface px-2 py-1 font-mono text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";

const textareaCls =
  "min-h-[64px] w-full resize-y rounded border border-edge bg-surface px-2 py-1.5 font-mono text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block w-full">
      <span className="mb-0.5 block text-[0.7857em] font-medium text-content-muted">{label}</span>
      {children}
      {hint && <p className="mt-0.5 text-[10px] text-content-subtle">{hint}</p>}
    </label>
  );
}

/** Parse a JSON object of string→string (env / headers). Returns an error
 *  message on invalid input, else the record (undefined when text is empty). */
function parseStringRecordJson(text: string, what: string): { error?: string; value?: Record<string, string> } {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: `${what} 不是合法 JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `${what} 需要是 JSON 对象` };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") return { error: `${what} 的值必须是字符串` };
    out[k] = v;
  }
  return { value: out };
}

function AddServerDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envJson, setEnvJson] = useState("");
  const [url, setUrl] = useState("");
  const [headersJson, setHeadersJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName("");
    setType("stdio");
    setCommand("");
    setArgs("");
    setEnvJson("");
    setUrl("");
    setHeadersJson("");
    setError(null);
  }, [open]);

  const save = async () => {
    setError(null);
    const trimmedName = name.trim();
    if (!MCP_NAME_RE.test(trimmedName)) {
      setError("名称只能包含字母、数字、下划线和连字符");
      return;
    }
    if (trimmedName === MCP_RESERVED_NAME) {
      setError(`「${MCP_RESERVED_NAME}」是内置 server 的保留名`);
      return;
    }
    let config: McpServerConfig;
    if (type === "stdio") {
      if (!command.trim()) {
        setError("请填写启动命令");
        return;
      }
      const envRes = parseStringRecordJson(envJson, "环境变量");
      if (envRes.error) {
        setError(envRes.error);
        return;
      }
      const argList = args.trim() ? args.trim().split(/\s+/) : undefined;
      config = {
        type: "stdio",
        command: command.trim(),
        ...(argList ? { args: argList } : {}),
        ...(envRes.value ? { env: envRes.value } : {}),
      };
    } else {
      if (!url.trim()) {
        setError("请填写 URL");
        return;
      }
      const headersRes = parseStringRecordJson(headersJson, "请求头");
      if (headersRes.error) {
        setError(headersRes.error);
        return;
      }
      config = {
        type,
        url: url.trim(),
        ...(headersRes.value ? { headers: headersRes.value } : {}),
      };
    }
    setSaving(true);
    try {
      const res = await api.mcp.save({ name: trimmedName, config });
      if (!res.ok) {
        setError(res.error ?? "保存失败");
        return;
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[80vh] w-[520px] flex-col p-0">
          <Dialog.Title className="px-4 pt-4">新增 MCP Server</Dialog.Title>
          <Dialog.Description className="px-4 pt-1">
            添加到 <code className="rounded bg-surface-muted px-0.5">~/.mcode/.claude.json</code>(用户级,所有项目可用)
          </Dialog.Description>
          <Dialog.Close />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <Field label="名称" hint="仅字母、数字、下划线、连字符;工具将以 mcp__名称__工具 形式呈现">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-server"
                className={inputCls}
                spellCheck={false}
                autoFocus
              />
            </Field>
            <Field label="类型">
              <Select.Root value={type} onValueChange={(v) => setType(v as "stdio" | "http" | "sse")}>
                <Select.Trigger className="w-full">
                  <Select.Value>{(val: string) => val}</Select.Value>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner>
                    <Select.Popup>
                      <Select.List>
                        <Select.Item value="stdio">
                          <Select.ItemText>stdio(本地进程)</Select.ItemText>
                        </Select.Item>
                        <Select.Item value="http">
                          <Select.ItemText>http(远程服务)</Select.ItemText>
                        </Select.Item>
                        <Select.Item value="sse">
                          <Select.ItemText>sse(远程服务,旧协议)</Select.ItemText>
                        </Select.Item>
                      </Select.List>
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
            </Field>
            {type === "stdio" ? (
              <>
                <Field label="启动命令" hint="可执行文件,如 npx / node / uvx;找不到时写完整路径">
                  <input
                    type="text"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="npx -y @modelcontextprotocol/server-filesystem"
                    className={inputCls}
                    spellCheck={false}
                  />
                </Field>
                <Field label="参数(可选)" hint="空格分隔,如:-y @modelcontextprotocol/server-filesystem /data">
                  <input
                    type="text"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder="--port 3000"
                    className={inputCls}
                    spellCheck={false}
                  />
                </Field>
                <Field label="环境变量(可选,JSON)" hint='如 {"API_KEY": "xxx"} 的 JSON 对象'>
                  <textarea
                    value={envJson}
                    onChange={(e) => setEnvJson(e.target.value)}
                    className={textareaCls}
                    spellCheck={false}
                    placeholder='{"API_KEY": "xxx"}'
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL" hint="远程 MCP 端点,如 https://example.com/mcp">
                  <input
                    type="text"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com/mcp"
                    className={inputCls}
                    spellCheck={false}
                  />
                </Field>
                <Field label="请求头(可选,JSON)" hint='如 {"Authorization": "Bearer xxx"} 的 JSON 对象'>
                  <textarea
                    value={headersJson}
                    onChange={(e) => setHeadersJson(e.target.value)}
                    className={textareaCls}
                    spellCheck={false}
                    placeholder='{"Authorization": "Bearer xxx"}'
                  />
                </Field>
              </>
            )}
            {error && <div className="mt-1 text-[0.7857em] text-danger">{error}</div>}
          </div>
          <div className="flex items-center gap-2 border-t border-edge px-4 py-3">
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? "保存中…" : "添加"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ───────── Import dialog ───────── */

/** Modal dialog for importing MCP servers from the local Claude CLI config
 *  (~/.claude.json — global + per-project entries). On open, scans the CLI
 *  config and the current user-scope list (to mark already-present names);
 *  presents a grouped, checkbox-selectable list; copies the selected configs
 *  on confirm. Mirrors ImportSkillsDialog. */
function ImportMcpDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const [sources, setSources] = useState<McpImportSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    imported: string[];
    skipped: string[];
    errors: Array<{ name: string; error: string }>;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    setSelected(new Set());
    setExisting(new Set());
    void (async () => {
      try {
        const [scanRes, listRes] = await Promise.all([
          api.mcp.scanImport({}),
          api.mcp.list({}),
        ]);
        if (cancelled) return;
        setSources(scanRes.sources);
        setExisting(
          new Set(listRes.servers.filter((s) => s.scope === "user").map((s) => s.name)),
        );
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Selection key is `origin:name` (the same name can exist globally and in
  // several projects; both are offered, first import wins the name).
  const sourceKey = (s: McpImportSource) => `${s.origin}:${s.name}`;
  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Group by origin — global scope first, then project paths.
  const groups = sources.reduce<Record<string, McpImportSource[]>>((acc, s) => {
    (acc[s.origin] ??= []).push(s);
    return acc;
  }, {});
  const groupKeys = Object.keys(groups).sort((a, b) =>
    a === "全局" ? -1 : b === "全局" ? 1 : a.localeCompare(b),
  );

  const selectedCount = selected.size;

  const doImport = async () => {
    if (selectedCount === 0) return;
    setImporting(true);
    setError(null);
    try {
      const items = sources
        .filter((s) => selected.has(sourceKey(s)))
        .map((s) => ({ name: s.name, config: s.config }));
      const res = await api.mcp.import({ servers: items });
      setResult(res);
      setSelected(new Set());
      setExisting((prev) => {
        const next = new Set(prev);
        for (const name of res.imported) next.add(name);
        return next;
      });
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[80vh] w-[560px] flex-col p-0">
          <Dialog.Title className="px-4 pt-4">导入 MCP Server</Dialog.Title>
          <Dialog.Description className="px-4 pt-1">
            从本机 Claude CLI 配置(<code className="rounded bg-surface-muted px-0.5">~/.claude.json</code>)导入到 Mcode 的用户级配置。Mcode 不读取该文件,导入是唯一的复用方式。
          </Dialog.Description>
          <Dialog.Close />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-[0.7857em] text-content-subtle">
                <IconLoader2 size={14} className="animate-spin" />
                扫描中…
              </div>
            ) : sources.length === 0 ? (
              <div className="py-8 text-center text-[0.7857em] leading-relaxed text-content-subtle">
                未在 ~/.claude.json 中发现 MCP server。
                <br />
                可先用 claude mcp add 命令配置,再回到此处导入。
              </div>
            ) : (
              <div className="space-y-3">
                {groupKeys.map((origin) => (
                  <div key={origin}>
                    <div className="mb-1 flex items-center gap-1.5">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium",
                          origin === "全局"
                            ? "bg-accent/12 text-accent"
                            : "bg-surface-hover text-content-subtle",
                        )}
                        title={origin === "全局" ? undefined : origin}
                      >
                        {origin === "全局" ? "全局" : origin}
                      </span>
                      <span className="text-[0.7143em] text-content-subtle">
                        {groups[origin].length} 个
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {groups[origin].map((s) => {
                        const key = sourceKey(s);
                        const isExisting = existing.has(s.name);
                        const isChecked = selected.has(key);
                        return (
                          <label
                            key={key}
                            className={cn(
                              "flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 transition-colors",
                              isExisting
                                ? "opacity-50"
                                : isChecked
                                  ? "bg-accent/8"
                                  : "hover:bg-surface-hover/60",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              disabled={isExisting}
                              onChange={() => toggle(key)}
                              className="mt-0.5 shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1">
                                <span className="truncate text-[0.7857em] font-medium text-content">
                                  {s.name}
                                </span>
                                <KindBadge kind={s.kind} />
                                {isExisting && (
                                  <span className="shrink-0 rounded bg-surface-hover px-1 text-[9px] text-content-subtle">
                                    已存在
                                  </span>
                                )}
                              </div>
                              <p className="truncate font-mono text-[0.7143em] text-content-subtle" title={s.detail}>
                                {s.detail}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {result && (
              <div className="mt-3 rounded border border-edge bg-surface/40 p-2 text-[0.7143em]">
                {result.imported.length > 0 && (
                  <p className="text-accent">
                    已导入 {result.imported.length} 个: {result.imported.join(", ")}
                  </p>
                )}
                {result.skipped.length > 0 && (
                  <p className="text-content-subtle">
                    跳过 {result.skipped.length} 个(已存在): {result.skipped.join(", ")}
                  </p>
                )}
                {result.errors.length > 0 && (
                  <p className="text-danger">
                    失败 {result.errors.length} 个:{" "}
                    {result.errors.map((e) => `${e.name}(${e.error})`).join("; ")}
                  </p>
                )}
              </div>
            )}

            {error && <div className="mt-2 text-[0.7857em] text-danger">{error}</div>}
          </div>
          <div className="flex items-center gap-2 border-t border-edge px-4 py-3">
            <span className="text-[0.7143em] text-content-subtle">
              {selectedCount > 0 ? `已选 ${selectedCount} 个` : ""}
            </span>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={importing}>
              {result ? "关闭" : "取消"}
            </Button>
            {!result && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void doImport()}
                disabled={importing || selectedCount === 0}
              >
                {importing ? "导入中…" : `导入${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
              </Button>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
