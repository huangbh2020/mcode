import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { Button, ConfirmDialog, Input, Select, Switch, Tooltip } from "@renderer/components/ui/index.js";
import {
  IconPlus,
  IconTrash,
  IconChevronDown,
  IconChevronRight,
  IconEye,
  IconEyeOff,
  IconLoader2,
  IconCheck,
  IconKey,
  IconHash,
  IconBookmark,
  IconBrandOpenai,
  IconAdjustmentsHorizontal,
  IconCircleOff,
  IconArrowsExchange,
} from "@renderer/lib/icons.js";
import { SiClaude, SiGoogle } from "@renderer/lib/icons.js";
import {
  CUSTOM_MODEL_ROLES,
  CUSTOM_MODEL_ROLE_LABELS,
} from "@contracts/customModel";
import type {
  CustomModelPublic,
  AuthMode,
  Protocol,
  RoleBindings,
  RoleBinding,
  CustomModelRoleKey,
} from "@contracts/customModel";
import type { EndpointPresetPublic } from "@contracts/endpointPreset";
import { PanelHeader } from "./PanelHeader.js";
import {
  PI_KNOWN_APIS,
  PI_THINKING_KEYS,
  PI_DEFAULT_CONTEXT_WINDOW,
  PI_1M_CONTEXT_WINDOW,
  type PiProviderConfig,
  type PiProviderPublic,
  type PiModelDefinition,
  type PiThinkingKey,
} from "@contracts/piModel";

/**
 * Unified model-config panel — the single "模型配置" settings surface.
 *
 * Both provider families live on ONE page and share a left list + right form
 * layout, distinguished by a type badge:
 *   - Claude (Anthropic-compatible gateways, encrypted-token customModel store)
 *   - Pi     (writes ~/.pi/agent/models.json, encrypted apiKey in settings map)
 *
 * Selecting an item loads a family-specific form (ClaudeProviderForm /
 * PiProviderForm) on the right. "+ Claude 端点" / "+ Pi Provider" at the list
 * foot create transient new entries that promote on save / discard on cancel.
 *
 * Credential viewing: Token / API Key fields default to masked (password). An
 * eye-icon button fetches the cleartext via customModel.getToken /
 * piModels.getApiKey and reveals it inline — a deliberate, user-initiated
 * carve-out of the usual "cleartext never crosses IPC" rule.
 *
 * Pi context window: the UI exposes a single "1M 上下文" toggle per model
 * (off → 200k default, on → 1M), mirroring the Claude side's 1M declaration —
 * the user no longer types a raw token count.
 */

/* ════════════════════════ shared option constants ════════════════════════ */
// Static Select option catalogs carrying a per-option icon, so every dropdown
// in this panel shows a visual cue alongside the label (and in the trigger).

const AUTH_MODE_OPTIONS: { value: AuthMode; label: string; icon: ReactNode }[] = [
  { value: "auth_token", label: "Bearer", icon: <IconKey size={14} className="text-content-muted" /> },
  { value: "api_key", label: "x-api-key", icon: <IconHash size={14} className="text-content-muted" /> },
];

const PROTOCOL_OPTIONS: { value: Protocol; label: string; icon: ReactNode }[] = [
  {
    value: "anthropic",
    label: "Anthropic(原生 /v1/messages)",
    icon: <SiClaude size={14} className="text-content-muted" />,
  },
  {
    value: "openai",
    label: "OpenAI(/v1/chat/completions,经本地协议翻译)",
    icon: <IconBrandOpenai size={14} className="text-content-muted" />,
  },
];

/** Per-API-type brand icon for the Pi "API 类型" select (label stays the raw
 *  api string, e.g. "openai-completions"). Unknown api strings get no icon. */
const PI_API_ICONS: Record<string, ReactNode> = {
  "openai-completions": <IconBrandOpenai size={14} className="text-content-muted" />,
  "openai-responses": <IconBrandOpenai size={14} className="text-content-muted" />,
  "anthropic-messages": <SiClaude size={14} className="text-content-muted" />,
  "google-generative-ai": <SiGoogle size={14} className="text-content-muted" />,
};

const THINKING_MODE_OPTIONS: { value: string; label: string; icon: ReactNode }[] = [
  { value: "default", label: "默认", icon: <IconAdjustmentsHorizontal size={14} className="text-content-muted" /> },
  { value: "null", label: "不支持", icon: <IconCircleOff size={14} className="text-content-muted" /> },
  { value: "value", label: "映射值", icon: <IconArrowsExchange size={14} className="text-content-muted" /> },
];

/* ════════════════════════ shared helpers ════════════════════════ */

/** Labeled form field wrapper. */
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[0.7857em] font-medium text-content-muted">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[0.6428em] leading-relaxed text-content-subtle">{hint}</span>}
    </label>
  );
}

/** A credential input that defaults to masked and reveals plaintext via an
 *  eye-icon button. `onReveal` is called once on first reveal and should
 *  return the cleartext (new mode: the form value; edit mode: fetched via
 *  IPC). Subsequent clicks just toggle the masked/text type. */
function SecretInput({
  value,
  onChange,
  placeholder,
  onReveal,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onReveal: () => Promise<string | null>;
}) {
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const toggle = async () => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    // First reveal of this mount: pull the plaintext in.
    setLoading(true);
    try {
      const plain = await onReveal();
      if (plain) {
        onChange(plain);
        setRevealed(true);
      }
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="relative">
      <Input
        type={revealed ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-7"
        spellCheck={false}
        autoComplete="off"
      />
      <Tooltip.Root>
        <Tooltip.Trigger
          type="button"
          onClick={() => void toggle()}
          disabled={loading}
          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-content-subtle outline-none hover:text-content"
          aria-label={revealed ? "隐藏明文" : "显示明文"}
        >
          {loading ? (
            <IconLoader2 size={13} className="animate-spin" />
          ) : revealed ? (
            <IconEyeOff size={13} />
          ) : (
            <IconEye size={13} />
          )}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner side="top">
            <Tooltip.Popup>{revealed ? "隐藏明文" : "显示明文"}</Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </div>
  );
}

/* ════════════════════════ Claude form ════════════════════════ */

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; detail: string }
  | { status: "fail"; error: string };

interface ClaudeFormState {
  id?: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  protocol: Protocol;
  authToken: string;
  roles: RoleBindings;
  testRole: CustomModelRoleKey;
  disableNonEssentialTraffic: boolean;
  timeoutMs: string;
}

function emptyClaudeForm(): ClaudeFormState {
  return {
    name: "",
    baseUrl: "",
    authMode: "auth_token",
    protocol: "anthropic",
    authToken: "",
    roles: {},
    testRole: "sonnet",
    disableNonEssentialTraffic: true,
    timeoutMs: "",
  };
}

function claudeFormFromConfig(m: CustomModelPublic): ClaudeFormState {
  return {
    id: m.id,
    name: m.name,
    baseUrl: m.baseUrl,
    authMode: m.authMode,
    protocol: m.protocol,
    authToken: "",
    roles: { ...m.roles },
    testRole:
      (CUSTOM_MODEL_ROLES.find((r) => m.roles[r]?.requestModel?.trim()) as CustomModelRoleKey | undefined) ?? "sonnet",
    disableNonEssentialTraffic: m.disableNonEssentialTraffic ?? true,
    timeoutMs: m.timeoutMs ? String(m.timeoutMs) : "",
  };
}

/* ════════════════════════ Pi form ════════════════════════ */

interface PiModelFormState {
  id: string;
  name: string;
  enable1m: boolean;
  maxTokens: string;
  reasoning: boolean;
  thinking: Record<PiThinkingKey, "default" | "null" | "value">;
  thinkingValue: Record<PiThinkingKey, string>;
}

interface PiFormState {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  authHeader: boolean;
  models: PiModelFormState[];
}

function emptyPiModel(): PiModelFormState {
  return {
    id: "",
    name: "",
    enable1m: false,
    maxTokens: "",
    reasoning: false,
    thinking: {
      off: "default",
      minimal: "default",
      low: "default",
      medium: "default",
      high: "default",
      xhigh: "default",
    },
    thinkingValue: { off: "", minimal: "", low: "", medium: "", high: "", xhigh: "" },
  };
}

function emptyPiForm(): PiFormState {
  return { name: "", baseUrl: "", api: "openai-completions", apiKey: "", authHeader: false, models: [] };
}

function piModelFromDef(def: PiModelDefinition): PiModelFormState {
  const m = emptyPiModel();
  m.id = def.id ?? "";
  m.name = def.name ?? "";
  m.enable1m = typeof def.contextWindow === "number" && def.contextWindow >= PI_1M_CONTEXT_WINDOW;
  m.maxTokens = def.maxTokens ? String(def.maxTokens) : "";
  m.reasoning = def.reasoning ?? false;
  const tlm = def.thinkingLevelMap ?? {};
  for (const k of PI_THINKING_KEYS) {
    const v = tlm[k];
    if (v === null) m.thinking[k] = "null";
    else if (typeof v === "string") {
      m.thinking[k] = "value";
      m.thinkingValue[k] = v;
    } else m.thinking[k] = "default";
  }
  return m;
}

function piFormFromConfig(name: string, cfg: PiProviderConfig): PiFormState {
  return {
    name: cfg.name ?? name,
    baseUrl: cfg.baseUrl ?? "",
    api: cfg.api ?? "openai-completions",
    apiKey: "",
    authHeader: cfg.authHeader ?? false,
    models: (cfg.models ?? []).map(piModelFromDef),
  };
}

/** Build the PiProviderConfig from the form (apiKey passed separately on save). */
function piConfigFromForm(form: PiFormState): PiProviderConfig {
  const models: PiModelDefinition[] = form.models
    .filter((m) => m.id.trim())
    .map((m) => {
      const def: PiModelDefinition = {
        id: m.id.trim(),
        // 1M toggle picks the context-window preset; the user no longer types it.
        contextWindow: m.enable1m ? PI_1M_CONTEXT_WINDOW : PI_DEFAULT_CONTEXT_WINDOW,
      };
      if (m.name.trim()) def.name = m.name.trim();
      const mt = Number(m.maxTokens);
      if (m.maxTokens.trim() && Number.isFinite(mt) && mt > 0) def.maxTokens = mt;
      if (m.reasoning) def.reasoning = true;
      const tlm: NonNullable<PiModelDefinition["thinkingLevelMap"]> = {};
      let hasMap = false;
      for (const k of PI_THINKING_KEYS) {
        const mode = m.thinking[k];
        if (mode === "null") {
          tlm[k] = null;
          hasMap = true;
        } else if (mode === "value") {
          const v = m.thinkingValue[k].trim();
          if (v) {
            tlm[k] = v;
            hasMap = true;
          }
        }
      }
      if (hasMap) def.thinkingLevelMap = tlm;
      return def;
    });
  const cfg: PiProviderConfig = {};
  if (form.name.trim()) cfg.name = form.name.trim();
  if (form.baseUrl.trim()) cfg.baseUrl = form.baseUrl.trim();
  if (form.api) cfg.api = form.api;
  if (form.authHeader) cfg.authHeader = true;
  cfg.models = models;
  return cfg;
}

/* ════════════════════════ unified list ════════════════════════ */

type Selection = { kind: "claude"; id: string | "new" } | { kind: "pi"; id: string | "new" } | null;
type ListItem = { kind: "claude" | "pi"; id: string; name: string; sub: string };

/* ════════════════════════ main panel ════════════════════════ */

export function CustomModelsPanel() {
  const customModels = useSessionStore((s) => s.customModels);
  const reloadCustomModels = useSessionStore((s) => s.reloadCustomModels);

  const [piProviders, setPiProviders] = useState<Record<string, PiProviderPublic>>({});
  const [selection, setSelection] = useState<Selection>(null);
  const [claudeForm, setClaudeForm] = useState<ClaudeFormState | null>(null);
  const [piForm, setPiForm] = useState<PiFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [pendingDelete, setPendingDelete] = useState<Selection & { id: string } | null>(null);
  const [presets, setPresets] = useState<EndpointPresetPublic[]>([]);
  const [showPresetForm, setShowPresetForm] = useState(false);
  const [presetDraft, setPresetDraft] = useState({ name: "", baseUrl: "", authMode: "auth_token" as AuthMode });

  const reloadPi = async () => {
    try {
      const { providers } = await api.piModels.list();
      setPiProviders(providers);
    } catch (err) {
      console.error("piModels.list failed:", err);
    }
  };

  useEffect(() => {
    void reloadPi();
    void api.endpointPreset
      .list()
      .then(({ presets }) => setPresets(presets))
      .catch((err) => console.error("endpointPreset.list failed:", err));
  }, []);

  const listItems = useMemo<ListItem[]>(() => {
    const items: ListItem[] = customModels.map((m) => {
      const bound = CUSTOM_MODEL_ROLES.filter((r) => m.roles[r]?.requestModel?.trim()).length;
      return {
        kind: "claude",
        id: m.id,
        name: m.name,
        sub: bound > 0 ? `${bound} 角色 · ${m.authMode === "api_key" ? "x-api-key" : "Bearer"}` : "未绑定角色",
      };
    });
    for (const [name, cfg] of Object.entries(piProviders)) {
      items.push({
        kind: "pi",
        id: name,
        name,
        sub: [
          (cfg.models?.length ?? 0) > 0 ? `${cfg.models!.length} 模型` : "无模型",
          cfg.api,
          cfg.hasApiKey ? "已配置 Key" : "未配置 Key",
        ].join(" · "),
      });
    }
    return items;
  }, [customModels, piProviders]);

  const isSelected = (item: ListItem) =>
    selection?.kind === item.kind && selection.id === item.id;

  const startNewClaude = () => {
    setSelection({ kind: "claude", id: "new" });
    setClaudeForm(emptyClaudeForm());
    setPiForm(null);
    setTest({ status: "idle" });
    setError(null);
  };
  const startNewPi = () => {
    setSelection({ kind: "pi", id: "new" });
    setPiForm(emptyPiForm());
    setClaudeForm(null);
    setError(null);
  };
  const startEditClaude = (m: CustomModelPublic) => {
    setSelection({ kind: "claude", id: m.id });
    setClaudeForm(claudeFormFromConfig(m));
    setPiForm(null);
    setTest({ status: "idle" });
    setError(null);
  };
  const startEditPi = (name: string) => {
    const cfg = piProviders[name];
    if (!cfg) return;
    setSelection({ kind: "pi", id: name });
    setPiForm(piFormFromConfig(name, cfg));
    setClaudeForm(null);
    setError(null);
  };
  const cancel = () => {
    setSelection(null);
    setClaudeForm(null);
    setPiForm(null);
    setTest({ status: "idle" });
    setError(null);
  };

  /** Fetch cleartext credential for the currently-open form. New mode returns
   *  the form value (already plaintext in the field); edit mode calls IPC. */
  const revealToken = async (): Promise<string | null> => {
    if (!selection || selection.id === "new") {
      if (selection?.kind === "claude") return claudeForm?.authToken ?? null;
      if (selection?.kind === "pi") return piForm?.apiKey ?? null;
      return null;
    }
    if (selection.kind === "claude") return (await api.customModel.getToken({ id: selection.id })).token;
    return (await api.piModels.getApiKey({ name: selection.id })).apiKey;
  };

  /** Apply a preset's baseUrl (+ authMode for claude) to the open form. */
  const applyPreset = (presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    if (selection?.kind === "claude") {
      setClaudeForm((f) => (f ? { ...f, baseUrl: preset.baseUrl, authMode: preset.authMode } : f));
    } else if (selection?.kind === "pi") {
      setPiForm((f) => (f ? { ...f, baseUrl: preset.baseUrl } : f));
    }
    setTest({ status: "idle" });
  };

  const savePreset = async () => {
    if (!presetDraft.name.trim() || !presetDraft.baseUrl.trim()) return;
    try {
      const { presets: next } = await api.endpointPreset.save({
        name: presetDraft.name,
        baseUrl: presetDraft.baseUrl,
        authMode: presetDraft.authMode,
      });
      setPresets(next);
      setPresetDraft({ name: "", baseUrl: "", authMode: "auth_token" });
      setShowPresetForm(false);
    } catch (err) {
      console.error("endpointPreset.save failed:", err);
    }
  };
  const deletePreset = async (id: string) => {
    try {
      const { presets: next } = await api.endpointPreset.delete({ id });
      setPresets(next);
    } catch (err) {
      console.error("endpointPreset.delete failed:", err);
    }
  };

  const saveClaude = async () => {
    if (!claudeForm) return;
    const roles: RoleBindings = {};
    let anyBound = false;
    for (const role of CUSTOM_MODEL_ROLES) {
      const b = claudeForm.roles[role];
      const requestModel = b?.requestModel?.trim();
      if (!requestModel) continue;
      anyBound = true;
      const cleaned: RoleBinding = { requestModel };
      const dn = b?.displayName?.trim();
      if (dn) cleaned.displayName = dn;
      if (b?.supports1m) cleaned.supports1m = true;
      roles[role] = cleaned;
    }
    if (!claudeForm.name.trim() || !claudeForm.baseUrl.trim()) {
      setError("名称、Base URL 不能为空");
      return;
    }
    if (!anyBound) {
      setError("至少要为一个角色填写「实际请求模型」");
      return;
    }
    if (!claudeForm.id && !claudeForm.authToken.trim()) {
      setError("新建时必须填写 Token");
      return;
    }
    const timeoutMs = claudeForm.timeoutMs.trim() ? Number(claudeForm.timeoutMs.trim()) : undefined;
    if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      setError("超时必须是正整数(毫秒)");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { models: saved } = await api.customModel.save({
        id: claudeForm.id,
        name: claudeForm.name.trim(),
        baseUrl: claudeForm.baseUrl.trim(),
        authMode: claudeForm.authMode,
        protocol: claudeForm.protocol,
        authToken: claudeForm.authToken.trim() || undefined,
        roles,
        disableNonEssentialTraffic: claudeForm.disableNonEssentialTraffic,
        timeoutMs,
      });
      useSessionStore.setState({ customModels: saved });
      const landedId = claudeForm.id ?? saved[saved.length - 1]?.id ?? null;
      setSelection(landedId ? { kind: "claude", id: landedId } : null);
      setClaudeForm(null);
      setTest({ status: "idle" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
      void reloadCustomModels();
    }
  };

  const runClaudeTest = async () => {
    if (!claudeForm) return;
    const timeoutMs = claudeForm.timeoutMs.trim() ? Number(claudeForm.timeoutMs.trim()) : undefined;
    if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      setError("超时必须是正整数(毫秒)");
      return;
    }
    const binding = claudeForm.roles[claudeForm.testRole];
    const model = binding?.requestModel?.trim() ?? "";
    if (!claudeForm.baseUrl.trim() || !model) {
      setTest({
        status: "fail",
        error: `请填写 Base URL 和「${CUSTOM_MODEL_ROLE_LABELS[claudeForm.testRole]}」角色的「实际请求模型」`,
      });
      return;
    }
    if (!claudeForm.authToken.trim()) {
      setTest({
        status: "fail",
        error: claudeForm.id ? "编辑模式下测试需重新填入 Token(明文不回传)" : "请填写 Token",
      });
      return;
    }
    setError(null);
    setTest({ status: "testing" });
    try {
      const result = await api.customModel.test({
        baseUrl: claudeForm.baseUrl.trim(),
        authToken: claudeForm.authToken.trim(),
        authMode: claudeForm.authMode,
        protocol: claudeForm.protocol,
        model,
        supports1m: binding?.supports1m ?? false,
        disableNonEssentialTraffic: claudeForm.disableNonEssentialTraffic,
        timeoutMs,
      });
      setTest(result.ok ? { status: "ok", detail: result.detail ?? "连接成功" } : { status: "fail", error: result.error ?? "未知错误" });
    } catch (err) {
      setTest({ status: "fail", error: (err as Error).message });
    }
  };

  const savePi = async () => {
    if (!piForm) return;
    if (!piForm.name.trim()) return setError("Provider 名称不能为空");
    if (!piForm.baseUrl.trim()) return setError("Base URL 不能为空");
    if (!piForm.api) return setError("API 类型不能为空");
    if (selection?.id === "new" && !piForm.apiKey.trim()) return setError("请填写 API Key");
    const valid = piForm.models.filter((m) => m.id.trim());
    if (valid.length === 0) return setError("至少需要配置一个模型");
    for (const m of valid) {
      if (m.maxTokens.trim()) {
        const mt = Number(m.maxTokens);
        if (!Number.isFinite(mt) || mt <= 0) return setError(`模型 ${m.id}:maxTokens 必须大于 0`);
      }
    }
    setSaving(true);
    setError(null);
    try {
      const cfg = piConfigFromForm(piForm);
      const { providers: next } = await api.piModels.save({
        name: piForm.name.trim(),
        config: cfg,
        apiKey: piForm.apiKey,
      });
      setPiProviders(next);
      setSelection({ kind: "pi", id: piForm.name.trim() });
      void useSessionStore.getState().reloadPiAvailableModels();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const confirmRemove = async () => {
    const target = pendingDelete;
    if (!target) return;
    try {
      if (target.kind === "claude") {
        const { models } = await api.customModel.delete({ id: target.id });
        useSessionStore.setState({ customModels: models });
      } else {
        const { providers } = await api.piModels.delete({ name: target.id });
        setPiProviders(providers);
        void useSessionStore.getState().reloadPiAvailableModels();
      }
      if (selection?.kind === target.kind && selection.id === target.id) cancel();
    } catch (err) {
      setError((err as Error).message);
    }
    setPendingDelete(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        className="mb-3"
        title="模型配置"
        desc="统一管理 Claude(Anthropic 兼容端点)与 Pi Provider。Token / API Key 经系统钥匙串加密存储,点击右侧眼睛图标可临时查看明文。"
      />

      <div className="grid min-h-0 flex-1 grid-cols-[210px_1fr] gap-4">
        {/* ───────── Left: unified provider list ───────── */}
        <aside className="flex min-h-0 flex-col rounded-md border border-edge bg-surface/40">
          <div className="flex items-center justify-between px-2.5 py-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
            <span>供应商</span>
            <span className="tabular-nums">{listItems.length}</span>
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
            {listItems.map((item) => {
              const active = isSelected(item);
              const isPi = item.kind === "pi";
              return (
                <button
                  key={`${item.kind}:${item.id}`}
                  onClick={() =>
                    item.kind === "claude"
                      ? startEditClaude(customModels.find((m) => m.id === item.id)!)
                      : startEditPi(item.id)
                  }
                  className={cn(
                    "relative block w-full rounded px-2.5 py-1.5 text-left transition-colors",
                    active ? "bg-surface-hover" : "hover:bg-surface-hover/60",
                  )}
                >
                  {active && <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />}
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "shrink-0 rounded px-1 py-px text-[0.6428em] font-medium",
                        isPi ? "bg-accent/15 text-accent" : "bg-surface-muted text-content-muted",
                      )}
                    >
                      {isPi ? "Pi" : "Claude"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[0.7857em] font-medium text-content">{item.name}</span>
                  </div>
                  <div className="mt-0.5 truncate pl-0.5 text-[0.7143em] text-content-subtle">{item.sub}</div>
                </button>
              );
            })}
            {selection?.id === "new" && (
              <div className="relative block w-full rounded border border-dashed border-accent/60 bg-accent/5 px-2.5 py-1.5 text-left text-[0.7857em] italic text-accent">
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                新建 {selection.kind === "pi" ? "Pi Provider" : "Claude 端点"}
              </div>
            )}
            {listItems.length === 0 && selection?.id !== "new" && (
              <div className="px-2 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
                还没有供应商配置。
              </div>
            )}
          </nav>
          <div className="space-y-1 border-t border-edge p-1.5">
            <Button variant="outline" size="sm" onClick={startNewClaude} disabled={selection?.id === "new"} className="w-full justify-center gap-1">
              <IconPlus size={12} /> Claude 端点
            </Button>
            <Button variant="outline" size="sm" onClick={startNewPi} disabled={selection?.id === "new"} className="w-full justify-center gap-1">
              <IconPlus size={12} /> Pi Provider
            </Button>
          </div>

          {/* ───── Endpoint presets (credential-free, shared) ───── */}
          <div className="border-t border-edge/60 p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">端点预设</span>
              <button type="button" onClick={() => setShowPresetForm((v) => !v)} className="text-[0.7143em] text-accent hover:text-accent/80">
                {showPresetForm ? "收起" : "+ 添加"}
              </button>
            </div>
            {showPresetForm && (
              <div className="mb-1.5 space-y-1">
                <Input value={presetDraft.name} onChange={(e) => setPresetDraft((d) => ({ ...d, name: e.target.value }))} placeholder="名称,如 DeepSeek 官方" />
                <Input value={presetDraft.baseUrl} onChange={(e) => setPresetDraft((d) => ({ ...d, baseUrl: e.target.value }))} placeholder="https://api.deepseek.com" />
                <div className="flex gap-1">
                  <Select.Root value={presetDraft.authMode} onValueChange={(v) => setPresetDraft((d) => ({ ...d, authMode: v as AuthMode }))}>
                    <Select.Trigger className="flex-1">
                      <Select.Value>
                        {(val: AuthMode) => {
                          const o = AUTH_MODE_OPTIONS.find((x) => x.value === val) ?? AUTH_MODE_OPTIONS[0];
                          return <span className="flex items-center gap-1.5">{o.icon}{o.label}</span>;
                        }}
                      </Select.Value>
                    </Select.Trigger>
                    <Select.Portal><Select.Positioner><Select.Popup><Select.List>
                      {AUTH_MODE_OPTIONS.map((o) => (
                        <Select.Item key={o.value} value={o.value}>
                          {o.icon}
                          <Select.ItemText>{o.label}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.List></Select.Popup></Select.Positioner></Select.Portal>
                  </Select.Root>
                  <Button variant="primary" size="sm" onClick={() => void savePreset()} disabled={!presetDraft.name.trim() || !presetDraft.baseUrl.trim()}>
                    保存
                  </Button>
                </div>
              </div>
            )}
            <ul className="space-y-0.5">
              {presets.map((p) => (
                <li key={p.id} className="group flex items-center gap-1 rounded px-1 py-0.5 text-[0.7143em] text-content-muted">
                  <span className="min-w-0 flex-1 truncate" title={`${p.baseUrl} (${p.authMode})`}>{p.name}</span>
                  <button type="button" onClick={() => void deletePreset(p.id)} className="shrink-0 text-content-subtle opacity-0 transition-opacity hover:text-danger group-hover:opacity-100" title="删除预设">
                    <IconTrash size={11} />
                  </button>
                </li>
              ))}
              {presets.length === 0 && !showPresetForm && <li className="text-[0.7143em] text-content-subtle">暂无预设</li>}
            </ul>
          </div>
        </aside>

        {/* ───────── Right: family-specific form ───────── */}
        <div className="min-h-0 overflow-y-auto pr-1">
          {selection?.kind === "claude" && claudeForm ? (
            <ClaudeProviderForm
              key={`claude:${claudeForm.id ?? "new"}`}
              form={claudeForm}
              setForm={setClaudeForm}
              test={test}
              saving={saving}
              error={error}
              presets={presets}
              applyPreset={applyPreset}
              revealToken={revealToken}
              onTest={() => void runClaudeTest()}
              onSave={() => void saveClaude()}
              onCancel={cancel}
              onDelete={claudeForm.id ? () => setPendingDelete({ kind: "claude", id: claudeForm.id! }) : undefined}
            />
          ) : selection?.kind === "pi" && piForm ? (
            <PiProviderForm
              key={`pi:${selection.id}`}
              form={piForm}
              setForm={setPiForm}
              saving={saving}
              error={error}
              presets={presets}
              applyPreset={applyPreset}
              revealToken={revealToken}
              isEdit={selection.id !== "new"}
              onSave={() => void savePi()}
              onCancel={cancel}
              onDelete={selection.id !== "new" ? () => setPendingDelete({ kind: "pi", id: selection.id }) : undefined}
            />
          ) : (
            <EmptyDetail />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete != null}
        title={`删除${pendingDelete?.kind === "pi" ? " Provider" : "供应商"}`}
        description={
          pendingDelete?.kind === "pi" ? (
            <>确定删除 <code className="rounded bg-surface-muted px-1">{pendingDelete.id}</code> 吗?将从 models.json 移除该 Provider 及其模型。</>
          ) : (
            <>确认删除「{pendingDelete?.id}」?此操作不可撤销,关联的 Token 也会一并清除。</>
          )
        }
        confirmText="删除"
        danger
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        onConfirm={() => void confirmRemove()}
      />
    </div>
  );
}

function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-content-subtle">
        <IconKey size={18} />
      </span>
      <p className="max-w-[240px] text-[0.7857em] leading-relaxed text-content-subtle">
        从左侧选择一个供应商查看或修改配置,或点击「Claude 端点」「Pi Provider」新增。
      </p>
    </div>
  );
}

/* ════════════════════════ Claude provider form ════════════════════════ */

function ClaudeProviderForm({
  form,
  setForm,
  test,
  saving,
  error,
  presets,
  applyPreset,
  revealToken,
  onTest,
  onSave,
  onCancel,
  onDelete,
}: {
  form: ClaudeFormState;
  setForm: (f: ClaudeFormState | null) => void;
  test: TestState;
  saving: boolean;
  error: string | null;
  presets: EndpointPresetPublic[];
  applyPreset: (id: string) => void;
  revealToken: () => Promise<string | null>;
  onTest: () => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const isEdit = !!form.id;
  const isOpenAi = form.protocol === "openai";
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(form.timeoutMs));

  const update = <K extends keyof ClaudeFormState>(key: K, value: ClaudeFormState[K]) =>
    setForm({ ...form, [key]: value });

  const updateRole = (role: CustomModelRoleKey, patch: Partial<RoleBinding>) => {
    const current = form.roles[role] ?? {};
    const merged: RoleBinding = { ...current, ...patch };
    const cleaned: RoleBinding = {};
    if (merged.displayName) cleaned.displayName = merged.displayName;
    if (merged.requestModel) cleaned.requestModel = merged.requestModel;
    if (merged.supports1m) cleaned.supports1m = merged.supports1m;
    setForm({ ...form, roles: { ...form.roles, [role]: Object.keys(cleaned).length > 0 ? cleaned : undefined } });
  };

  const fillAllRoles = () => {
    const src = form.roles[form.testRole]?.requestModel?.trim();
    if (!src) return;
    const filled: RoleBindings = {};
    for (const r of CUSTOM_MODEL_ROLES) filled[r] = { requestModel: src };
    update("roles", filled);
  };

  return (
    <div className="space-y-2.5">
      <Field label="API 格式">
        <Select.Root value={form.protocol} onValueChange={(v) => update("protocol", v as Protocol)}>
          <Select.Trigger className="w-full">
            <Select.Value>
              {(val: Protocol) => {
                const o = PROTOCOL_OPTIONS.find((x) => x.value === val) ?? PROTOCOL_OPTIONS[0];
                return <span className="flex items-center gap-1.5">{o.icon}{o.label}</span>;
              }}
            </Select.Value>
          </Select.Trigger>
          <Select.Portal><Select.Positioner><Select.Popup><Select.List>
            {PROTOCOL_OPTIONS.map((o) => (
              <Select.Item key={o.value} value={o.value}>
                {o.icon}
                <Select.ItemText>{o.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.List></Select.Popup></Select.Positioner></Select.Portal>
        </Select.Root>
      </Field>
      {isOpenAi && (
        <p className="text-[0.6428em] leading-relaxed text-content-subtle">
          OpenAI 格式端点(OpenAI 官方 / Azure / vLLM / Ollama / one-api 等)会启用内置协议翻译层:Claude 仍按 Anthropic 协议运行,应用在本地把请求/响应实时翻译成 OpenAI 格式转发。建议把所有角色填成同一个模型。
        </p>
      )}

      <Field label="名称">
        <Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="DeepSeek 中转" />
      </Field>

      {presets.length > 0 && (
        <Field label="从预设导入">
          <Select.Root value="" onValueChange={(v) => { const id = String(v); if (id) applyPreset(id); }}>
            <Select.Trigger className="w-full">
              <Select.Value placeholder={<span className="flex items-center gap-1.5"><IconBookmark size={14} className="text-content-muted" />选择端点预设(Base URL / 认证方式自动填充)</span>} />
            </Select.Trigger>
            <Select.Portal><Select.Positioner><Select.Popup><Select.List>
              {presets.map((p) => (
                <Select.Item key={p.id} value={p.id}>
                  <IconBookmark size={14} className="text-content-muted" />
                  <Select.ItemText>{p.name} · {p.baseUrl}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List></Select.Popup></Select.Positioner></Select.Portal>
          </Select.Root>
        </Field>
      )}

      <Field label="Base URL">
        <Input value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} placeholder={isOpenAi ? "https://api.openai.com/v1" : "https://api.deepseek.com/anthropic"} />
      </Field>

      <div className="grid grid-cols-[1fr_120px] gap-2">
        <Field label="Token / API Key">
          <SecretInput
            value={form.authToken}
            onChange={(v) => update("authToken", v)}
            placeholder={isEdit ? "留空 = 保持现有 token 不变" : "sk-..."}
            onReveal={revealToken}
          />
        </Field>
        <Field label="认证方式">
          <Select.Root value={form.authMode} onValueChange={(v) => update("authMode", v as AuthMode)}>
            <Select.Trigger className="w-full">
              <Select.Value>
                {(val: AuthMode) => {
                  const o = AUTH_MODE_OPTIONS.find((x) => x.value === val) ?? AUTH_MODE_OPTIONS[0];
                  return <span className="flex items-center gap-1.5">{o.icon}{o.label}</span>;
                }}
              </Select.Value>
            </Select.Trigger>
            <Select.Portal><Select.Positioner><Select.Popup><Select.List>
              {AUTH_MODE_OPTIONS.map((o) => (
                <Select.Item key={o.value} value={o.value}>
                  {o.icon}
                  <Select.ItemText>{o.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List></Select.Popup></Select.Positioner></Select.Portal>
          </Select.Root>
        </Field>
      </div>

      {/* Role-binding table */}
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[0.7857em] font-medium text-content-muted">角色绑定</span>
          {isOpenAi && (
            <button type="button" onClick={fillAllRoles} className="text-[0.7143em] text-accent hover:text-accent/80">
              一键填充主模型
            </button>
          )}
        </div>
        <p className="mb-1.5 text-[0.7143em] leading-relaxed text-content-subtle">
          填了「实际请求模型」的角色才会出现在下拉框。点左侧圆点选择测试连接用哪个角色。
        </p>
        <div className="overflow-hidden rounded border border-edge">
          <div className="grid grid-cols-[20px_56px_1fr_1fr_44px] items-center gap-1.5 border-b border-edge bg-surface-muted px-1.5 py-1 text-[0.6428em] font-medium uppercase tracking-wide text-content-subtle">
            <span /><span>角色</span><span>显示名称</span><span>实际请求模型</span><span className="text-center">1M</span>
          </div>
          {CUSTOM_MODEL_ROLES.map((role) => {
            const binding = form.roles[role] ?? {};
            const isTest = form.testRole === role;
            return (
              <div key={role} className="grid grid-cols-[20px_56px_1fr_1fr_44px] items-center gap-1.5 border-b border-edge px-1.5 py-1 last:border-b-0">
                <Tooltip.Root>
                  <Tooltip.Trigger
                    type="button"
                    onClick={() => update("testRole", role)}
                    className={cn(
                      "flex h-3.5 w-3.5 items-center justify-center rounded-full text-[0.6428em] outline-none",
                      isTest ? "bg-accent text-surface" : "bg-surface-hover text-content-subtle hover:bg-surface-muted",
                    )}
                  >
                    <IconCheck size={8} className={isTest ? "opacity-100" : "opacity-0"} />
                  </Tooltip.Trigger>
                  <Tooltip.Portal><Tooltip.Positioner side="top"><Tooltip.Popup>用「{CUSTOM_MODEL_ROLE_LABELS[role]}」角色测试连接</Tooltip.Popup></Tooltip.Positioner></Tooltip.Portal>
                </Tooltip.Root>
                <span className="text-[0.7857em] font-medium text-content">{CUSTOM_MODEL_ROLE_LABELS[role]}</span>
                <Input value={binding.displayName ?? ""} onChange={(e) => updateRole(role, { displayName: e.target.value || undefined })} placeholder="可选" />
                <Input value={binding.requestModel ?? ""} onChange={(e) => updateRole(role, { requestModel: e.target.value || undefined })} placeholder={roleHint(role)} />
                <div className="flex justify-center">
                  <Switch checked={Boolean(binding.supports1m)} onCheckedChange={(v) => updateRole(role, { supports1m: v || undefined })} label="声明 1M 上下文" />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Advanced */}
      <button type="button" onClick={() => setAdvancedOpen((v) => !v)} className="flex items-center gap-1 pt-1 text-[0.7857em] text-content-subtle hover:text-content-muted">
        <IconChevronRight size={12} className={cn("transition-transform", advancedOpen && "rotate-90")} />
        高级选项(超时 / 禁用遥测)
      </button>
      {advancedOpen && (
        <div className="space-y-2 rounded border border-edge bg-surface/50 p-2">
          <div className="grid grid-cols-[1fr_140px] gap-2">
            <Field label="超时 (ms, 可选)">
              <Input value={form.timeoutMs} onChange={(e) => update("timeoutMs", e.target.value)} placeholder="3000000" />
            </Field>
            <label className="flex items-end gap-1.5 pb-1 text-[0.7857em] text-content-muted">
              <input type="checkbox" checked={form.disableNonEssentialTraffic} onChange={(e) => update("disableNonEssentialTraffic", e.target.checked)} className="accent-accent" />
              禁用遥测
            </label>
          </div>
        </div>
      )}

      {error && <div className="text-[0.7857em] text-danger">{error}</div>}

      <FormActions
        left={
          <Button variant="secondary" size="sm" onClick={onTest} disabled={test.status === "testing"}>
            {test.status === "testing" ? "测试中…" : "测试连接"}
          </Button>
        }
        testInfo={
          <span className="truncate text-[0.7143em] text-content-subtle">
            测:{CUSTOM_MODEL_ROLE_LABELS[form.testRole]} · {form.roles[form.testRole]?.requestModel?.trim() || "(空)"}
          </span>
        }
        testStatus={test}
        onDelete={onDelete}
        onCancel={onCancel}
        onSave={onSave}
        saving={saving}
        isEdit={isEdit}
      />
    </div>
  );
}

function roleHint(role: CustomModelRoleKey): string {
  switch (role) {
    case "haiku": return "deepseek-v4-flash";
    case "sonnet": return "deepseek-v4-pro";
    case "opus": return "deepseek-v4-pro-max";
    case "fable": return "claude-fable-5";
    case "subagent": return "(Task 工具用,可留空)";
  }
}

/* ════════════════════════ Pi provider form ════════════════════════ */

function PiProviderForm({
  form,
  setForm,
  saving,
  error,
  presets,
  applyPreset,
  revealToken,
  isEdit,
  onSave,
  onCancel,
  onDelete,
}: {
  form: PiFormState;
  setForm: (f: PiFormState | null) => void;
  saving: boolean;
  error: string | null;
  presets: EndpointPresetPublic[];
  applyPreset: (id: string) => void;
  revealToken: () => Promise<string | null>;
  isEdit: boolean;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [expandedModel, setExpandedModel] = useState<number | null>(null);

  const update = <K extends keyof PiFormState>(key: K, value: PiFormState[K]) => setForm({ ...form, [key]: value });
  const updateModel = (idx: number, patch: Partial<PiModelFormState>) =>
    setForm({ ...form, models: form.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
  const addModel = () => setForm({ ...form, models: [...form.models, emptyPiModel()] });
  const removeModel = (idx: number) => setForm({ ...form, models: form.models.filter((_, i) => i !== idx) });

  return (
    <div className="space-y-2.5">
      {presets.length > 0 && (
        <Field label="从预设导入">
          <Select.Root value="" onValueChange={(v) => { const id = String(v); if (id) applyPreset(id); }}>
            <Select.Trigger className="w-full">
              <Select.Value placeholder={<span className="flex items-center gap-1.5"><IconBookmark size={14} className="text-content-muted" />选择端点预设(填 Base URL)</span>} />
            </Select.Trigger>
            <Select.Portal><Select.Positioner><Select.Popup><Select.List>
              {presets.map((p) => (
                <Select.Item key={p.id} value={p.id}>
                  <IconBookmark size={14} className="text-content-muted" />
                  <Select.ItemText>{p.name} · {p.baseUrl}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List></Select.Popup></Select.Positioner></Select.Portal>
          </Select.Root>
        </Field>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Provider 名称">
          <Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="deepseek" />
        </Field>
        <Field label="API 类型">
          <Select.Root value={form.api} onValueChange={(v) => update("api", String(v))}>
            <Select.Trigger className="w-full">
              <Select.Value>
                {(val: string) => (
                  <span className="flex items-center gap-1.5">
                    {PI_API_ICONS[val]}
                    {val}
                  </span>
                )}
              </Select.Value>
            </Select.Trigger>
            <Select.Portal><Select.Positioner><Select.Popup><Select.List>
              {PI_KNOWN_APIS.map((a) => (
                <Select.Item key={a} value={a}>
                  {PI_API_ICONS[a]}
                  <Select.ItemText>{a}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List></Select.Popup></Select.Positioner></Select.Portal>
          </Select.Root>
        </Field>
      </div>

      <Field label="Base URL">
        <Input value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} placeholder="https://api.deepseek.com" />
      </Field>

      <Field label="API Key" hint="密钥经 safeStorage 加密存于设置表,turn 开始时注入到 Pi。">
        <SecretInput
          value={form.apiKey}
          onChange={(v) => update("apiKey", v)}
          placeholder={isEdit ? "留空 = 保持现有 Key" : "sk-..."}
          onReveal={revealToken}
        />
      </Field>

      <div className="flex items-center gap-2">
        <Switch checked={form.authHeader} onCheckedChange={(v) => update("authHeader", v)} label="自动添加 Authorization: Bearer 请求头" />
        <span className="text-[0.7857em] text-content-muted">自动添加 Bearer 请求头</span>
      </div>

      {/* Models sub-table */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[0.7857em] font-medium text-content-muted">模型列表({form.models.filter((m) => m.id.trim()).length})</span>
          <button type="button" onClick={addModel} className="flex items-center gap-1 text-[0.7857em] text-accent hover:text-accent/80">
            <IconPlus size={11} /> 添加模型
          </button>
        </div>
        {form.models.length === 0 && (
          <p className="rounded border border-dashed border-edge px-2 py-3 text-center text-[0.7143em] text-content-subtle">
            尚未添加模型,至少需要一个模型才能保存。
          </p>
        )}
        <div className="space-y-1.5">
          {form.models.map((m, idx) => (
            <div key={idx} className="rounded border border-edge bg-surface/40 p-2">
              <div className="grid grid-cols-[1fr_90px_70px_auto] items-center gap-1.5">
                <Input value={m.id} onChange={(e) => updateModel(idx, { id: e.target.value })} placeholder="模型 id,如 deepseek-v4-pro" />
                <Input value={m.maxTokens} onChange={(e) => updateModel(idx, { maxTokens: e.target.value })} placeholder="最大输出" title="最大输出 token" />
                <label className="flex items-center gap-1 justify-self-center" title="启用 1M 上下文(关闭=200k)">
                  <Switch checked={m.enable1m} onCheckedChange={(v) => updateModel(idx, { enable1m: v })} label="启用 1M 上下文(关闭=200k)" />
                  <span className="text-[0.6428em] text-content-muted">1M</span>
                </label>
                <span className="flex items-center gap-0.5">
                  <button type="button" onClick={() => setExpandedModel(expandedModel === idx ? null : idx)} className="rounded p-0.5 text-content-muted hover:bg-surface-hover" title={expandedModel === idx ? "收起" : "展开思考级别 / 推理 / 显示名"}>
                    {expandedModel === idx ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                  </button>
                  <Button variant="ghost" size="icon" onClick={() => removeModel(idx)} title="删除模型">
                    <IconTrash size={12} />
                  </Button>
                </span>
              </div>
              {expandedModel === idx && (
                <div className="mt-2 space-y-2 border-t border-edge/60 pt-1.5">
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5">
                      <Switch checked={m.reasoning} onCheckedChange={(v) => updateModel(idx, { reasoning: v })} label="支持推理" />
                      <span className="text-[0.7143em] text-content-muted">推理</span>
                    </label>
                    <Field label="显示名(可选)">
                      <Input value={m.name} onChange={(e) => updateModel(idx, { name: e.target.value })} placeholder="如 DeepSeek V4 Pro" />
                    </Field>
                  </div>
                  <div>
                    <span className="mb-1 block text-[0.7143em] text-content-muted">思考级别映射(默认=用模型默认;不支持=UI 隐藏该档;映射值=发送给 provider 的具体字符串)</span>
                    <div className="grid grid-cols-2 gap-1.5">
                      {PI_THINKING_KEYS.map((k) => (
                        <label key={k} className="flex items-center gap-1.5">
                          <span className="w-14 shrink-0 text-[0.7143em] text-content-muted">{k}</span>
                          <Select.Root value={m.thinking[k]} onValueChange={(v) => updateModel(idx, { thinking: { ...m.thinking, [k]: v as PiModelFormState["thinking"][PiThinkingKey] } })}>
                            <Select.Trigger className="flex-1">
                              <Select.Value>
                                {(val: string) => {
                                  const o = THINKING_MODE_OPTIONS.find((x) => x.value === val) ?? THINKING_MODE_OPTIONS[0];
                                  return <span className="flex items-center gap-1.5">{o.icon}{o.label}</span>;
                                }}
                              </Select.Value>
                            </Select.Trigger>
                            <Select.Portal><Select.Positioner><Select.Popup><Select.List>
                              {THINKING_MODE_OPTIONS.map((o) => (
                                <Select.Item key={o.value} value={o.value}>
                                  {o.icon}
                                  <Select.ItemText>{o.label}</Select.ItemText>
                                </Select.Item>
                              ))}
                            </Select.List></Select.Popup></Select.Positioner></Select.Portal>
                          </Select.Root>
                          {m.thinking[k] === "value" && (
                            <Input value={m.thinkingValue[k]} onChange={(e) => updateModel(idx, { thinkingValue: { ...m.thinkingValue, [k]: e.target.value } })} placeholder="如 max / high" className="flex-1" />
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {error && <div className="rounded border border-danger/30 bg-danger/5 px-2 py-1.5 text-[0.7857em] text-danger">{error}</div>}

      <FormActions
        onDelete={onDelete}
        onCancel={onCancel}
        onSave={onSave}
        saving={saving}
        isEdit={isEdit}
      />
    </div>
  );
}

/* ════════════════════════ shared action bar ════════════════════════ */

function FormActions({
  left,
  testInfo,
  testStatus,
  onDelete,
  onCancel,
  onSave,
  saving,
  isEdit,
}: {
  left?: React.ReactNode;
  testInfo?: React.ReactNode;
  testStatus?: TestState;
  onDelete?: () => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  isEdit: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {left}
      {testInfo}
      {testStatus?.status === "ok" && <span className="flex items-center gap-0.5 text-[0.7857em] text-accent"><IconCheck size={12} /> {testStatus.detail}</span>}
      {testStatus?.status === "fail" && <span className="truncate text-[0.7857em] text-danger">✗ {testStatus.error}</span>}
      <div className="flex-1" />
      {isEdit && onDelete && (
        <Button variant="danger" size="sm" onClick={onDelete} title="删除">
          <IconTrash size={12} /> 删除
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
      <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
        {saving ? "保存中…" : isEdit ? "更新" : "保存"}
      </Button>
    </div>
  );
}
