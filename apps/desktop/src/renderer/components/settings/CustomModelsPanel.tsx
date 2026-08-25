import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
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
  IconBrandOpenai,
  IconAdjustmentsHorizontal,
  IconCircleOff,
  IconArrowsExchange,
  IconPlugConnected,
} from "@renderer/lib/icons.js";
import { SiClaude, SiGoogle } from "@renderer/lib/icons.js";
import type {
  CustomModelPublic,
  CustomModelEntry,
  AuthMode,
  Protocol,
} from "@contracts/customModel";
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
 * Claude and Pi each get their own TAB at the top; within a tab the page is a
 * left provider list + right form:
 *   - Claude (Anthropic-compatible gateways, encrypted-token customModel store)
 *   - Pi     (writes ~/.pi/agent/models.json, encrypted apiKey in settings map)
 *
 * Selecting an item loads a family-specific form (ClaudeProviderForm /
 * PiProviderForm) on the right. The "+ Claude 端点" / "+ Pi Provider" button
 * at the list foot (of the matching tab) creates a transient new entry that
 * promotes on save / discards on cancel. Switching tabs discards any open
 * form/draft, same as the add buttons.
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

const PROTOCOL_OPTIONS: { value: Protocol; labelKey: MessageId; icon: ReactNode }[] = [
  {
    value: "anthropic",
    labelKey: "settings.customModels.protocolAnthropic",
    icon: <SiClaude size={14} className="text-content-muted" />,
  },
  {
    value: "openai",
    labelKey: "settings.customModels.protocolOpenai",
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

const THINKING_MODE_OPTIONS: { value: string; labelKey: MessageId; icon: ReactNode }[] = [
  { value: "default", labelKey: "settings.customModels.thinkingDefault", icon: <IconAdjustmentsHorizontal size={14} className="text-content-muted" /> },
  { value: "null", labelKey: "settings.customModels.thinkingNull", icon: <IconCircleOff size={14} className="text-content-muted" /> },
  { value: "value", labelKey: "settings.customModels.thinkingValue", icon: <IconArrowsExchange size={14} className="text-content-muted" /> },
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
  const { t } = useI18n();
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
          aria-label={revealed ? t("settings.customModels.hidePlain") : t("settings.customModels.showPlain")}
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
            <Tooltip.Popup>
              {revealed ? t("settings.customModels.hidePlain") : t("settings.customModels.showPlain")}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </div>
  );
}

/* ════════════════════════ Claude form ════════════════════════ */

type TestState =
  | { status: "idle" }
  | { status: "testing"; idx: number }
  | { status: "ok"; detail: string }
  | { status: "fail"; error: string };

interface ClaudeModelFormState {
  /** Gateway-side model id, e.g. "deepseek-v4-pro". */
  id: string;
  supports1m: boolean;
}

interface ClaudeFormState {
  id?: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  protocol: Protocol;
  authToken: string;
  /** Flat model list — mirrors the Pi form's models array. */
  models: ClaudeModelFormState[];
  disableNonEssentialTraffic: boolean;
  timeoutMs: string;
}

function emptyClaudeModel(): ClaudeModelFormState {
  return { id: "", supports1m: false };
}

function emptyClaudeForm(): ClaudeFormState {
  return {
    name: "",
    baseUrl: "",
    authMode: "auth_token",
    protocol: "anthropic",
    authToken: "",
    models: [],
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
    models: m.models.map((e) => ({ id: e.id, supports1m: Boolean(e.supports1m) })),
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
  /** Whether the model accepts image input. Written to models.json as
   *  `input: ["text","image"]` / `["text"]` — the SDK defaults undeclared
   *  models to TEXT-ONLY, which makes pi-ai swap user-attached images for an
   *  "(image omitted)" placeholder before the request leaves the process. */
  vision: boolean;
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
    vision: true,
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
  // Declared input wins; absent = the SDK's text-only default, but the form
  // still shows vision ON because the provider patches it in at turn time
  // whenever the user actually attaches an image (see PiAgentSdkProvider).
  m.vision = def.input ? def.input.includes("image") : true;
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
      // Always write `input` explicitly — the SDK's implicit default for
      // models.json models is text-only, which silently strips user-attached
      // images (replaced by an "(image omitted)" placeholder in the request).
      def.input = m.vision ? ["text", "image"] : ["text"];
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

type Family = "claude" | "pi";
type Selection = { kind: "claude"; id: string | "new" } | { kind: "pi"; id: string | "new" } | null;
type ListItem = { kind: Family; id: string; name: string; sub: string };

/* ════════════════════════ main panel ════════════════════════ */

export function CustomModelsPanel() {
  const { t } = useI18n();
  const customModels = useSessionStore((s) => s.customModels);
  const reloadCustomModels = useSessionStore((s) => s.reloadCustomModels);

  const [tab, setTab] = useState<Family>("claude");
  const [piProviders, setPiProviders] = useState<Record<string, PiProviderPublic>>({});
  const [selection, setSelection] = useState<Selection>(null);
  const [claudeForm, setClaudeForm] = useState<ClaudeFormState | null>(null);
  const [piForm, setPiForm] = useState<PiFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [pendingDelete, setPendingDelete] = useState<Selection & { id: string } | null>(null);

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
  }, []);

  const listItems = useMemo<ListItem[]>(() => {
    if (tab !== "claude") {
      return Object.entries(piProviders).map(([name, cfg]) => ({
        kind: "pi" as const,
        id: name,
        name,
        sub: [
          (cfg.models?.length ?? 0) > 0
            ? t("settings.customModels.modelCount", { n: cfg.models!.length })
            : t("settings.customModels.noModels"),
          cfg.api,
          cfg.hasApiKey
            ? t("settings.customModels.keyConfigured")
            : t("settings.customModels.keyNotConfigured"),
        ].join(" · "),
      }));
    }
    return customModels.map((m) => {
      const count = m.models.filter((e) => e.id.trim()).length;
      return {
        kind: "claude" as const,
        id: m.id,
        name: m.name,
        sub: count > 0
          ? `${t("settings.customModels.modelCount", { n: count })} · ${m.authMode === "api_key" ? "x-api-key" : "Bearer"}`
          : t("settings.customModels.noModels"),
      };
    });
  }, [tab, customModels, piProviders, t]);

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

  /** Switch the Claude/Pi tab. A form (or unsaved draft) open in the OTHER
   *  tab can't keep rendering here, so it's discarded — same semantics as
   *  the per-tab "新增" buttons, which also reset the transient draft. */
  const switchTab = (next: Family) => {
    if (next === tab) return;
    setTab(next);
    cancel();
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

  const saveClaude = async () => {
    if (!claudeForm) return;
    // Trim + dedupe: the same id twice in one config is always a typo.
    const seen = new Set<string>();
    const models: CustomModelEntry[] = [];
    for (const m of claudeForm.models) {
      const id = m.id.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push(m.supports1m ? { id, supports1m: true } : { id });
    }
    if (!claudeForm.name.trim() || !claudeForm.baseUrl.trim()) {
      setError(t("settings.customModels.errNameBaseUrl"));
      return;
    }
    if (models.length === 0) {
      setError(t("settings.customModels.errNeedModel"));
      return;
    }
    if (!claudeForm.id && !claudeForm.authToken.trim()) {
      setError(t("settings.customModels.errTokenRequired"));
      return;
    }
    const timeoutMs = claudeForm.timeoutMs.trim() ? Number(claudeForm.timeoutMs.trim()) : undefined;
    if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      setError(t("settings.customModels.errTimeout"));
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
        models,
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

  const runClaudeTest = async (idx: number) => {
    if (!claudeForm) return;
    const timeoutMs = claudeForm.timeoutMs.trim() ? Number(claudeForm.timeoutMs.trim()) : undefined;
    if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      setError(t("settings.customModels.errTimeout"));
      return;
    }
    const entry = claudeForm.models[idx];
    const model = entry?.id.trim() ?? "";
    if (!claudeForm.baseUrl.trim() || !model) {
      setTest({ status: "fail", error: t("settings.customModels.errTestFields") });
      return;
    }
    if (!claudeForm.authToken.trim()) {
      setTest({
        status: "fail",
        error: claudeForm.id
          ? t("settings.customModels.errTestTokenEdit")
          : t("settings.customModels.errTestToken"),
      });
      return;
    }
    setError(null);
    setTest({ status: "testing", idx });
    try {
      const result = await api.customModel.test({
        baseUrl: claudeForm.baseUrl.trim(),
        authToken: claudeForm.authToken.trim(),
        authMode: claudeForm.authMode,
        protocol: claudeForm.protocol,
        model,
        supports1m: entry?.supports1m ?? false,
        disableNonEssentialTraffic: claudeForm.disableNonEssentialTraffic,
        timeoutMs,
      });
      setTest(
        result.ok
          ? { status: "ok", detail: result.detail ?? t("settings.customModels.testOk") }
          : { status: "fail", error: result.error ?? t("settings.unknownError") },
      );
    } catch (err) {
      setTest({ status: "fail", error: (err as Error).message });
    }
  };

  const savePi = async () => {
    if (!piForm) return;
    if (!piForm.name.trim()) return setError(t("settings.customModels.errProviderName"));
    if (!piForm.baseUrl.trim()) return setError(t("settings.customModels.errBaseUrl"));
    if (!piForm.api) return setError(t("settings.customModels.errApiType"));
    if (selection?.id === "new" && !piForm.apiKey.trim()) return setError(t("settings.customModels.errApiKey"));
    const valid = piForm.models.filter((m) => m.id.trim());
    if (valid.length === 0) return setError(t("settings.customModels.errNeedModel"));
    for (const m of valid) {
      if (m.maxTokens.trim()) {
        const mt = Number(m.maxTokens);
        if (!Number.isFinite(mt) || mt <= 0)
          return setError(t("settings.customModels.errMaxTokens", { id: m.id }));
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
    <div className="mx-auto flex h-full w-full max-w-5xl min-h-0 flex-col">
      <PanelHeader
        className="mb-3"
        title={t("settings.customModels.title")}
      />

      {/* ───────── Claude / Pi family tabs ───────── */}
      <div className="mb-3 flex w-fit items-center gap-0.5 rounded-lg border border-edge bg-surface/40 p-0.5">
        {(["claude", "pi"] as const).map((k) => {
          const count = k === "claude" ? customModels.length : Object.keys(piProviders).length;
          return (
            <button
              key={k}
              type="button"
              onClick={() => switchTab(k)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1 text-[0.7857em] font-medium transition-colors",
                tab === k ? "bg-surface-hover text-content" : "text-content-muted hover:text-content",
              )}
            >
              {k === "claude" ? <SiClaude size={13} className={tab === k ? "text-accent" : "text-content-subtle"} /> : null}
              {k === "claude" ? "Claude" : "Pi"}
              <span className="tabular-nums text-[0.8571em] text-content-subtle">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[210px_1fr] gap-4">
        {/* ───────── Left: provider list (family of the active tab) ───────── */}
        <aside className="flex min-h-0 flex-col rounded-md border border-edge bg-surface/40">
          <div className="flex items-center justify-between px-2.5 py-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
            <span>{t("settings.customModels.providers")}</span>
            <span className="tabular-nums">{listItems.length}</span>
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
            {listItems.map((item) => {
              const active = isSelected(item);
              return (
                <button
                  key={item.id}
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
                  <div className="truncate text-[0.7857em] font-medium text-content">{item.name}</div>
                  <div className="mt-0.5 truncate pl-0.5 text-[0.7143em] text-content-subtle">{item.sub}</div>
                </button>
              );
            })}
            {selection?.id === "new" && selection.kind === tab && (
              <div className="relative block w-full rounded border border-dashed border-accent/60 bg-accent/5 px-2.5 py-1.5 text-left text-[0.7857em] italic text-accent">
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                {t(tab === "pi" ? "settings.customModels.newPi" : "settings.customModels.newClaude")}
              </div>
            )}
            {listItems.length === 0 && !(selection?.id === "new" && selection.kind === tab) && (
              <div className="px-2 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
                {t("settings.customModels.emptyProviders")}
              </div>
            )}
          </nav>
          <div className="border-t border-edge p-1.5">
            {tab === "claude" ? (
              <Button variant="outline" size="sm" onClick={startNewClaude} disabled={selection?.id === "new"} className="w-full justify-center gap-1">
                <IconPlus size={12} /> {t("settings.customModels.addClaude")}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={startNewPi} disabled={selection?.id === "new"} className="w-full justify-center gap-1">
                <IconPlus size={12} /> {t("settings.customModels.addPi")}
              </Button>
            )}
          </div>
        </aside>

        {/* ───────── Right: family-specific form ───────── */}
        <div className="min-h-0 overflow-y-auto rounded-md border border-edge bg-surface/40 p-3">
          {selection?.kind === "claude" && claudeForm ? (
            <ClaudeProviderForm
              key={`claude:${claudeForm.id ?? "new"}`}
              form={claudeForm}
              setForm={setClaudeForm}
              test={test}
              saving={saving}
              error={error}
              revealToken={revealToken}
              onTest={(idx) => void runClaudeTest(idx)}
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
        title={t(pendingDelete?.kind === "pi" ? "settings.customModels.deletePiTitle" : "settings.customModels.deleteClaudeTitle")}
        description={
          pendingDelete?.kind === "pi" ? (
            <>
              {t("settings.customModels.deleteConfirmPre")}
              <code className="rounded bg-surface-muted px-1">{pendingDelete.id}</code>
              {t("settings.customModels.deletePiPost")}
            </>
          ) : (
            <>
              {t("settings.customModels.deleteConfirmPre")}
              <code className="rounded bg-surface-muted px-1">{pendingDelete?.id}</code>
              {t("settings.customModels.deleteClaudePost")}
            </>
          )
        }
        confirmText={t("common.delete")}
        danger
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        onConfirm={() => void confirmRemove()}
      />
    </div>
  );
}

function EmptyDetail() {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-content-subtle">
        <IconKey size={18} />
      </span>
      <p className="max-w-[240px] text-[0.7857em] leading-relaxed text-content-subtle">
        {t("settings.customModels.emptyDetail")}
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
  revealToken: () => Promise<string | null>;
  onTest: (idx: number) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const isEdit = !!form.id;
  const isOpenAi = form.protocol === "openai";
  const { t } = useI18n();
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(form.timeoutMs));

  const update = <K extends keyof ClaudeFormState>(key: K, value: ClaudeFormState[K]) =>
    setForm({ ...form, [key]: value });

  const updateModel = (idx: number, patch: Partial<ClaudeModelFormState>) =>
    setForm({ ...form, models: form.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
  const addModel = () => setForm({ ...form, models: [...form.models, emptyClaudeModel()] });
  const removeModel = (idx: number) =>
    setForm({ ...form, models: form.models.filter((_, i) => i !== idx) });

  return (
    <div className="space-y-2.5">
      <Field label={t("settings.customModels.protocolLabel")}>
        <Select.Root value={form.protocol} onValueChange={(v) => update("protocol", v as Protocol)}>
          <Select.Trigger className="w-full">
            <Select.Value>
              {(val: Protocol) => {
                const o = PROTOCOL_OPTIONS.find((x) => x.value === val) ?? PROTOCOL_OPTIONS[0];
                return <span className="flex items-center gap-1.5">{o.icon}{t(o.labelKey)}</span>;
              }}
            </Select.Value>
          </Select.Trigger>
          <Select.Portal><Select.Positioner><Select.Popup><Select.List>
            {PROTOCOL_OPTIONS.map((o) => (
              <Select.Item key={o.value} value={o.value}>
                {o.icon}
                <Select.ItemText>{t(o.labelKey)}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.List></Select.Popup></Select.Positioner></Select.Portal>
        </Select.Root>
      </Field>
      {isOpenAi && (
        <p className="text-[0.6428em] leading-relaxed text-content-subtle">
          {t("settings.customModels.openaiNote")}
        </p>
      )}

      <Field label={t("settings.customModels.nameLabel")}>
        <Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder={t("settings.customModels.namePlaceholder")} />
      </Field>

      <Field label="Base URL">
        <Input value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} placeholder={isOpenAi ? "https://api.openai.com/v1" : "https://api.deepseek.com/anthropic"} />
      </Field>

      <div className="grid grid-cols-[1fr_120px] gap-2">
        <Field label="Token / API Key">
          <SecretInput
            value={form.authToken}
            onChange={(v) => update("authToken", v)}
            placeholder={isEdit ? t("settings.customModels.tokenKeepPlaceholder") : "sk-..."}
            onReveal={revealToken}
          />
        </Field>
        <Field label={t("settings.customModels.authLabel")}>
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

      {/* Models sub-list — flat rows mirroring the Pi form: model id + 1M
          toggle, with a per-row plug icon (next to delete) that fires the
          connection test for that specific model. */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[0.7857em] font-medium text-content-muted">
            {t("settings.customModels.modelListTitle", { n: form.models.filter((m) => m.id.trim()).length })}
          </span>
          <button type="button" onClick={addModel} className="flex items-center gap-1 text-[0.7857em] text-accent hover:text-accent/80">
            <IconPlus size={11} /> {t("settings.customModels.addModel")}
          </button>
        </div>
        {form.models.length === 0 && (
          <p className="rounded border border-dashed border-edge px-2 py-3 text-center text-[0.7143em] text-content-subtle">
            {t("settings.customModels.modelsEmpty")}
          </p>
        )}
        <div className="space-y-1.5">
          {form.models.map((m, idx) => {
            const testingThis = test.status === "testing" && test.idx === idx;
            return (
              <div
                key={idx}
                className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-1.5 rounded border border-edge bg-surface/40 px-1.5 py-1"
              >
                <Input
                  value={m.id}
                  onChange={(e) => updateModel(idx, { id: e.target.value })}
                  placeholder={t("settings.customModels.modelIdPlaceholder")}
                  spellCheck={false}
                />
                <label className="flex items-center gap-1 justify-self-center" title={t("settings.customModels.supports1mLabel")}>
                  <Switch checked={m.supports1m} onCheckedChange={(v) => updateModel(idx, { supports1m: v })} label={t("settings.customModels.supports1mLabel")} />
                  <span className="text-[0.6428em] text-content-muted">1M</span>
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onTest(idx)}
                  disabled={test.status === "testing"}
                  title={t("settings.customModels.testWithModel")}
                >
                  {testingThis ? <IconLoader2 size={12} className="animate-spin" /> : <IconPlugConnected size={12} />}
                </Button>
                <Button variant="ghost" size="icon" onClick={() => removeModel(idx)} title={t("settings.customModels.deleteModel")}>
                  <IconTrash size={12} />
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Advanced */}
      <button type="button" onClick={() => setAdvancedOpen((v) => !v)} className="flex items-center gap-1 pt-1 text-[0.7857em] text-content-subtle hover:text-content-muted">
        <IconChevronRight size={12} className={cn("transition-transform", advancedOpen && "rotate-90")} />
        {t("settings.customModels.advancedToggle")}
      </button>
      {advancedOpen && (
        <div className="space-y-2 rounded border border-edge bg-surface/50 p-2">
          <div className="grid grid-cols-[1fr_140px] gap-2">
            <Field label={t("settings.customModels.timeoutLabel")}>
              <Input value={form.timeoutMs} onChange={(e) => update("timeoutMs", e.target.value)} placeholder="3000000" />
            </Field>
            <label className="flex items-end gap-1.5 pb-1 text-[0.7857em] text-content-muted">
              <input type="checkbox" checked={form.disableNonEssentialTraffic} onChange={(e) => update("disableNonEssentialTraffic", e.target.checked)} className="accent-accent" />
              {t("settings.customModels.disableTelemetry")}
            </label>
          </div>
        </div>
      )}

      {error && <div className="text-[0.7857em] text-danger">{error}</div>}

      <FormActions
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

/* ════════════════════════ Pi provider form ════════════════════════ */

function PiProviderForm({
  form,
  setForm,
  saving,
  error,
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
  revealToken: () => Promise<string | null>;
  isEdit: boolean;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const [expandedModel, setExpandedModel] = useState<number | null>(null);

  const update = <K extends keyof PiFormState>(key: K, value: PiFormState[K]) => setForm({ ...form, [key]: value });
  const updateModel = (idx: number, patch: Partial<PiModelFormState>) =>
    setForm({ ...form, models: form.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
  const addModel = () => setForm({ ...form, models: [...form.models, emptyPiModel()] });
  const removeModel = (idx: number) => setForm({ ...form, models: form.models.filter((_, i) => i !== idx) });

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("settings.customModels.providerNameLabel")}>
          <Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="deepseek" />
        </Field>
        <Field label={t("settings.customModels.apiTypeLabel")}>
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

      <Field label="API Key" hint={t("settings.customModels.apiKeyHint")}>
        <SecretInput
          value={form.apiKey}
          onChange={(v) => update("apiKey", v)}
          placeholder={isEdit ? t("settings.customModels.apiKeyKeepPlaceholder") : "sk-..."}
          onReveal={revealToken}
        />
      </Field>

      <div className="flex items-center gap-2">
        <Switch checked={form.authHeader} onCheckedChange={(v) => update("authHeader", v)} label={t("settings.customModels.authHeaderLabel")} />
        <span className="text-[0.7857em] text-content-muted">{t("settings.customModels.authHeaderSpan")}</span>
      </div>

      {/* Models sub-table */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[0.7857em] font-medium text-content-muted">
            {t("settings.customModels.modelListTitle", { n: form.models.filter((m) => m.id.trim()).length })}
          </span>
          <button type="button" onClick={addModel} className="flex items-center gap-1 text-[0.7857em] text-accent hover:text-accent/80">
            <IconPlus size={11} /> {t("settings.customModels.addModel")}
          </button>
        </div>
        {form.models.length === 0 && (
          <p className="rounded border border-dashed border-edge px-2 py-3 text-center text-[0.7143em] text-content-subtle">
            {t("settings.customModels.modelsEmpty")}
          </p>
        )}
        <div className="space-y-1.5">
          {form.models.map((m, idx) => (
            <div key={idx} className="rounded border border-edge bg-surface/40 p-2">
              <div className="grid grid-cols-[1fr_90px_70px_auto] items-center gap-1.5">
                <Input value={m.id} onChange={(e) => updateModel(idx, { id: e.target.value })} placeholder={t("settings.customModels.modelIdPlaceholder")} />
                <Input value={m.maxTokens} onChange={(e) => updateModel(idx, { maxTokens: e.target.value })} placeholder={t("settings.customModels.maxTokensPlaceholder")} title={t("settings.customModels.maxTokensTitle")} />
                <label className="flex items-center gap-1 justify-self-center" title={t("settings.customModels.enable1m")}>
                  <Switch checked={m.enable1m} onCheckedChange={(v) => updateModel(idx, { enable1m: v })} label={t("settings.customModels.enable1m")} />
                  <span className="text-[0.6428em] text-content-muted">1M</span>
                </label>
                <span className="flex items-center gap-0.5">
                  <button type="button" onClick={() => setExpandedModel(expandedModel === idx ? null : idx)} className="rounded p-0.5 text-content-muted hover:bg-surface-hover" title={expandedModel === idx ? t("settings.customModels.collapse") : t("settings.customModels.expandModel")}>
                    {expandedModel === idx ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                  </button>
                  <Button variant="ghost" size="icon" onClick={() => removeModel(idx)} title={t("settings.customModels.deleteModel")}>
                    <IconTrash size={12} />
                  </Button>
                </span>
              </div>
              {expandedModel === idx && (
                <div className="mt-2 space-y-2 border-t border-edge/60 pt-1.5">
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5">
                      <Switch checked={m.reasoning} onCheckedChange={(v) => updateModel(idx, { reasoning: v })} label={t("settings.customModels.reasoningLabel")} />
                      <span className="text-[0.7143em] text-content-muted">{t("settings.customModels.reasoningSpan")}</span>
                    </label>
                    <label className="flex items-center gap-1.5" title={t("settings.customModels.visionLabel")}>
                      <Switch checked={m.vision} onCheckedChange={(v) => updateModel(idx, { vision: v })} label={t("settings.customModels.visionLabel")} />
                      <span className="text-[0.7143em] text-content-muted">{t("settings.customModels.visionSpan")}</span>
                    </label>
                    <Field label={t("settings.customModels.displayNameLabel")}>
                      <Input value={m.name} onChange={(e) => updateModel(idx, { name: e.target.value })} placeholder={t("settings.customModels.displayNamePlaceholder")} />
                    </Field>
                  </div>
                  <div>
                    <span className="mb-1 block text-[0.7143em] text-content-muted">{t("settings.customModels.thinkingMapHint")}</span>
                    <div className="grid grid-cols-2 gap-1.5">
                      {PI_THINKING_KEYS.map((k) => (
                        <label key={k} className="flex items-center gap-1.5">
                          <span className="w-14 shrink-0 text-[0.7143em] text-content-muted">{k}</span>
                          <Select.Root value={m.thinking[k]} onValueChange={(v) => updateModel(idx, { thinking: { ...m.thinking, [k]: v as PiModelFormState["thinking"][PiThinkingKey] } })}>
                            <Select.Trigger className="flex-1">
                              <Select.Value>
                                {(val: string) => {
                                  const o = THINKING_MODE_OPTIONS.find((x) => x.value === val) ?? THINKING_MODE_OPTIONS[0];
                                  return <span className="flex items-center gap-1.5">{o.icon}{t(o.labelKey)}</span>;
                                }}
                              </Select.Value>
                            </Select.Trigger>
                            <Select.Portal><Select.Positioner><Select.Popup><Select.List>
                              {THINKING_MODE_OPTIONS.map((o) => (
                                <Select.Item key={o.value} value={o.value}>
                                  {o.icon}
                                  <Select.ItemText>{t(o.labelKey)}</Select.ItemText>
                                </Select.Item>
                              ))}
                            </Select.List></Select.Popup></Select.Positioner></Select.Portal>
                          </Select.Root>
                          {m.thinking[k] === "value" && (
                            <Input value={m.thinkingValue[k]} onChange={(e) => updateModel(idx, { thinkingValue: { ...m.thinkingValue, [k]: e.target.value } })} placeholder={t("settings.customModels.thinkingValuePlaceholder")} className="flex-1" />
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
  testStatus,
  onDelete,
  onCancel,
  onSave,
  saving,
  isEdit,
}: {
  testStatus?: TestState;
  onDelete?: () => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  isEdit: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {testStatus?.status === "ok" && <span className="flex items-center gap-0.5 text-[0.7857em] text-accent"><IconCheck size={12} /> {testStatus.detail}</span>}
      {testStatus?.status === "fail" && <span className="truncate text-[0.7857em] text-danger">✗ {testStatus.error}</span>}
      <div className="flex-1" />
      {isEdit && onDelete && (
        <Button variant="danger" size="sm" onClick={onDelete} title={t("common.delete")}>
          <IconTrash size={12} /> {t("common.delete")}
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
      <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
        {saving ? t("settings.saving") : isEdit ? t("settings.customModels.update") : t("common.save")}
      </Button>
    </div>
  );
}
