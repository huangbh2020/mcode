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
  IconDownload,
  IconCopy,
  IconCode,
  IconRefresh,
  IconSparkles,
} from "@renderer/lib/icons.js";
import { SiClaude, OpenAIBrandIcon, SiGoogle } from "@renderer/lib/icons.js";
import { OpenCodeBrandIcon } from "@renderer/lib/opencodeBrandIcon.js";
import { OpenCodeLoginPanel } from "./OpenCodeLoginPanel.js";
import type {
  CustomModelPublic,
  CustomModelEntry,
  CustomModelThinkingMode,
  ClaudeTierModels,
  ClaudeTierRoleMetaMap,
  ClaudeSettingsSyncState,
  ClaudeSettingsSyncTarget,
  AuthMode,
  Protocol,
} from "@contracts/customModel";
import { inferModelThinking, isValidHeaderName, isValidHeaderValue, REASONING_EFFORT_LEVELS } from "@contracts/customModel";
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
import type { CodexProviderPublic } from "@contracts/codexModel";

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

/** Thinking-mode Select options for a model row (label keys — i18n at render
 *  time, per the module convention for static option catalogs). */
const THINKING_MODE_KEYS: readonly [CustomModelThinkingMode, MessageId][] = [
  ["reasoning_effort", "settings.customModels.thinkingModeEffort"],
  ["enable_thinking", "settings.customModels.thinkingModeToggle"],
  ["none", "settings.customModels.thinkingModeNone"],
];

const AUTH_MODE_OPTIONS: { value: AuthMode; label: string; icon: ReactNode }[] = [
  { value: "auth_token", label: "Bearer", icon: <IconKey size={14} className="text-content-muted" /> },  { value: "api_key", label: "x-api-key", icon: <IconHash size={14} className="text-content-muted" /> },
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

type ClaudeRoleKey = "sonnet" | "opus" | "fable" | "haiku" | "subagent";

type TestState =
  | { status: "idle" }
  | { status: "testing"; role: ClaudeRoleKey }
  | { status: "ok"; detail: string }
  | { status: "fail"; error: string };

interface ClaudeRoleRowState {
  /** Gateway-side request model id, e.g. "glm-5.4". */
  model: string;
  /** Optional display name shown in the model picker (unused for subagent). */
  displayName: string;
  /** Declare 1M-token context window (`[1m]`). */
  supports1m: boolean;
  /** Thinking control for OpenAI-protocol endpoints. */
  thinkingMode: CustomModelThinkingMode;
  thinkingDefault: string;
}

const CLAUDE_ROLE_KEYS: readonly ClaudeRoleKey[] = [
  "sonnet",
  "opus",
  "fable",
  "haiku",
  "subagent",
];

/** Static descriptor for the 5 Claude Code model-mapping rows (mirrors cc-switch). */
const CLAUDE_ROLE_ROWS: readonly {
  key: ClaudeRoleKey;
  labelKey: MessageId;
  envKey: string;
  hasDisplayName: boolean;
}[] = [
  {
    key: "sonnet",
    labelKey: "settings.customModels.tierRoleSonnet",
    envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    hasDisplayName: true,
  },
  {
    key: "opus",
    labelKey: "settings.customModels.tierRoleOpus",
    envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    hasDisplayName: true,
  },
  {
    key: "fable",
    labelKey: "settings.customModels.tierRoleFable",
    envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL",
    hasDisplayName: true,
  },
  {
    key: "haiku",
    labelKey: "settings.customModels.tierRoleHaiku",
    envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    hasDisplayName: true,
  },
  {
    key: "subagent",
    labelKey: "settings.customModels.tierRoleSubagent",
    envKey: "CLAUDE_CODE_SUBAGENT_MODEL",
    hasDisplayName: false,
  },
];

interface ClaudeProviderPreset {
  id: string;
  label: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  protocol: Protocol;
  roles: Partial<Record<ClaudeRoleKey, { model: string; displayName?: string; supports1m?: boolean }>>;
}

/** Built-in quick presets modeled after cc-switch's claudeProviderPresets so
 *  users only need to paste their API key for common endpoints. */
const CLAUDE_PROVIDER_PRESETS: readonly ClaudeProviderPreset[] = [
  {
    id: "zhipu",
    label: "智谱 GLM",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    authMode: "auth_token",
    protocol: "anthropic",
    roles: {
      sonnet: { model: "glm-4.7" },
      opus: { model: "glm-4.7" },
      fable: { model: "glm-4.7" },
      haiku: { model: "glm-4.5-air" },
    },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    authMode: "auth_token",
    protocol: "anthropic",
    roles: {
      sonnet: { model: "deepseek-chat" },
      opus: { model: "deepseek-reasoner" },
      fable: { model: "deepseek-reasoner" },
      haiku: { model: "deepseek-chat" },
    },
  },
  {
    id: "kimi",
    label: "Kimi",
    name: "Kimi",
    baseUrl: "https://api.moonshot.cn/anthropic",
    authMode: "auth_token",
    protocol: "anthropic",
    roles: {
      sonnet: { model: "kimi-k2-0905-preview" },
      opus: { model: "kimi-k2-0905-preview" },
      fable: { model: "kimi-k2-0905-preview" },
      haiku: { model: "kimi-k2-0905-preview" },
    },
  },
  {
    id: "minimax",
    label: "MiniMax",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/anthropic",
    authMode: "auth_token",
    protocol: "anthropic",
    roles: {
      sonnet: { model: "MiniMax-M2.5" },
      opus: { model: "MiniMax-M2.5" },
      fable: { model: "MiniMax-M2.5" },
      haiku: { model: "MiniMax-M2.5" },
    },
  },
  {
    id: "qwen",
    label: "通义千问",
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    authMode: "auth_token",
    protocol: "anthropic",
    roles: {
      sonnet: { model: "qwen3-coder-plus" },
      opus: { model: "qwen3-coder-plus" },
      fable: { model: "qwen3-coder-plus" },
      haiku: { model: "qwen3-coder-plus" },
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    authMode: "auth_token",
    protocol: "anthropic",
    roles: {
      sonnet: { model: "anthropic/claude-sonnet-4.5" },
      opus: { model: "anthropic/claude-opus-4.5" },
      fable: { model: "anthropic/claude-opus-4.5" },
      haiku: { model: "anthropic/claude-haiku-4.5" },
    },
  },
  {
    id: "official",
    label: "Anthropic",
    name: "Claude 官方",
    baseUrl: "https://api.anthropic.com",
    authMode: "api_key",
    protocol: "anthropic",
    roles: {
      sonnet: { model: "claude-sonnet-4-5" },
      opus: { model: "claude-opus-4-5" },
      fable: { model: "claude-opus-4-5" },
      haiku: { model: "claude-haiku-4-5" },
    },
  },
  {
    id: "openai",
    label: "OpenAI 兼容",
    name: "OpenAI 兼容",
    baseUrl: "https://api.openai.com/v1",
    authMode: "auth_token",
    protocol: "openai",
    roles: {
      sonnet: { model: "gpt-4.1" },
      opus: { model: "gpt-4.1" },
      fable: { model: "gpt-4.1" },
      haiku: { model: "gpt-4.1-mini" },
    },
  },
];

const SYNC_TARGET_OPTIONS: readonly { value: ClaudeSettingsSyncTarget; labelKey: MessageId }[] = [
  { value: "mcode", labelKey: "settings.customModels.syncTargetMcode" },
  { value: "claude", labelKey: "settings.customModels.syncTargetClaude" },
  { value: "both", labelKey: "settings.customModels.syncTargetBoth" },
  { value: "none", labelKey: "settings.customModels.syncTargetNone" },
];

/** One editable row of the custom-headers list. Held as rows rather than a
 *  record so a half-typed row can sit in the form while the user is editing
 *  it; {@link customHeadersFromRows} converts on save. */
interface CustomHeaderRow {
  name: string;
  value: string;
}

/** Rows → the persisted record. Rows that are entirely empty are dropped (they
 *  are just unused UI slots); a partially filled or malformed row is a hard
 *  error rather than a silent skip, so a typo can't quietly fail to be sent.
 *  Validation uses the same rule the main process applies at request time. */
function customHeadersFromRows(
  rows: CustomHeaderRow[],
): { ok: true; headers: Record<string, string> | undefined } | { ok: false } {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name && !value) continue;
    if (!isValidHeaderName(name) || !isValidHeaderValue(value)) return { ok: false };
    out[name] = value;
  }
  return { ok: true, headers: Object.keys(out).length > 0 ? out : undefined };
}

interface ClaudeFormState {
  id?: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  protocol: Protocol;
  authToken: string;
  /** Single-table role-based model mappings (Sonnet/Opus/Fable/Haiku/Subagent). */
  roles: Record<ClaudeRoleKey, ClaudeRoleRowState>;
  disableNonEssentialTraffic: boolean;
  timeoutMs: string;
  /** Extra request headers for the endpoint. See CustomHeaders in contracts. */
  customHeaders: CustomHeaderRow[];
}

function emptyClaudeRoleRow(): ClaudeRoleRowState {
  return {
    model: "",
    displayName: "",
    supports1m: false,
    thinkingMode: "none",
    thinkingDefault: "medium",
  };
}

function emptyClaudeForm(): ClaudeFormState {
  return {
    name: "",
    baseUrl: "",
    authMode: "auth_token",
    protocol: "anthropic",
    authToken: "",
    roles: {
      sonnet: emptyClaudeRoleRow(),
      opus: emptyClaudeRoleRow(),
      fable: emptyClaudeRoleRow(),
      haiku: emptyClaudeRoleRow(),
      subagent: emptyClaudeRoleRow(),
    },
    disableNonEssentialTraffic: true,
    timeoutMs: "",
    customHeaders: [],
  };
}

const strip1mTag = (s: string): string => s.replace(/(\[1m\])+$/i, "").trim();

function claudeFormFromConfig(m: CustomModelPublic): ClaudeFormState {
  const entryMap = new Map<string, CustomModelEntry>();
  for (const e of m.models) {
    const bare = strip1mTag(e.id);
    if (bare && !entryMap.has(bare)) entryMap.set(bare, e);
  }
  const firstId = m.models[0] ? strip1mTag(m.models[0].id) : "";
  const secondId = m.models[1] ? strip1mTag(m.models[1].id) : firstId;

  const sonnetId = strip1mTag(m.tierModels?.sonnet || m.tierModels?.defaultModel || firstId);
  const opusId = strip1mTag(m.tierModels?.opus || secondId);
  const fableId = strip1mTag(m.tierModels?.fable || opusId);
  const haikuId = strip1mTag(m.tierModels?.haiku || secondId);
  const subagentId = strip1mTag(m.tierModels?.subagent || m.subagentModel || "");

  const rowFor = (role: ClaudeRoleKey, rawId: string, hasDisplayName: boolean): ClaudeRoleRowState => {
    const id = strip1mTag(rawId);
    const meta = m.tierModels?.roleMeta?.[role];
    const entry = id ? entryMap.get(id) : undefined;
    return {
      model: id,
      displayName: hasDisplayName ? (meta?.displayName ?? entry?.displayName ?? "") : "",
      supports1m: meta?.supports1m !== undefined ? meta.supports1m : Boolean(entry?.supports1m),
      thinkingMode: entry?.thinking?.mode ?? (id ? inferModelThinking(m.baseUrl, id).mode : "none"),
      thinkingDefault: entry?.thinking?.defaultLevel ?? "medium",
    };
  };

  return {
    id: m.id,
    name: m.name,
    baseUrl: m.baseUrl,
    authMode: m.authMode,
    protocol: m.protocol,
    authToken: "",
    roles: {
      sonnet: rowFor("sonnet", sonnetId, true),
      opus: rowFor("opus", opusId, true),
      fable: rowFor("fable", fableId, true),
      haiku: rowFor("haiku", haikuId, true),
      subagent: rowFor("subagent", subagentId, false),
    },
    disableNonEssentialTraffic: m.disableNonEssentialTraffic ?? true,
    timeoutMs: m.timeoutMs ? String(m.timeoutMs) : "",
    customHeaders: Object.entries(m.customHeaders ?? {}).map(([name, value]) => ({ name, value })),
  };
}

/** Deduplicate role rows (Sonnet → Opus → Fable → Haiku, falling back to
 *  Subagent only if all four menu roles are empty) into the flat `models[]`
 *  array consumed by `ModelDropdown` and `CustomModelStore`. */
function buildModelsFromRoles(roles: Record<ClaudeRoleKey, ClaudeRoleRowState>): CustomModelEntry[] {
  const menuRoles: ClaudeRoleKey[] = ["sonnet", "opus", "fable", "haiku"];
  const hasMenuModel = menuRoles.some((k) => strip1mTag(roles[k].model));
  const scanOrder: ClaudeRoleKey[] = hasMenuModel ? menuRoles : ["subagent"];

  const byId = new Map<string, CustomModelEntry>();
  const out: CustomModelEntry[] = [];

  for (const key of scanOrder) {
    const row = roles[key];
    const id = strip1mTag(row.model);
    if (!id) continue;
    const supports1m = row.supports1m || /\[1m\]$/i.test(row.model.trim());
    const displayName = key !== "subagent" ? row.displayName.trim() : "";

    const existing = byId.get(id);
    if (existing) {
      if (supports1m) existing.supports1m = true;
      if (!existing.displayName && displayName) existing.displayName = displayName;
      continue;
    }

    const entry: CustomModelEntry = {
      id,
      ...(displayName ? { displayName } : {}),
      ...(supports1m ? { supports1m: true } : {}),
      thinking: {
        mode: row.thinkingMode,
        ...(row.thinkingMode === "reasoning_effort" && row.thinkingDefault
          ? { defaultLevel: row.thinkingDefault }
          : {}),
      },
    };
    byId.set(id, entry);
    out.push(entry);
  }
  return out;
}

/** Build a sanitized preview of the `settings.json` `env` block for the
 *  current form state (token masked unless currently typed in cleartext). */
function buildClaudeEnvPreview(form: ClaudeFormState): Record<string, string> {
  const roleVal = (k: ClaudeRoleKey) => strip1mTag(form.roles[k].model);
  const sonnet = roleVal("sonnet");
  const opus = roleVal("opus");
  const fable = roleVal("fable");
  const haiku = roleVal("haiku");
  const subagent = roleVal("subagent");

  const defaultKey =
    (["sonnet", "opus", "fable", "haiku", "subagent"] as const).find((k) => roleVal(k)) ?? "sonnet";
  const defaultBare = roleVal(defaultKey);
  const mainModel = defaultBare
    ? form.roles[defaultKey].supports1m
      ? `${defaultBare}[1m]`
      : defaultBare
    : "";

  const env: Record<string, string> = {};
  if (form.baseUrl.trim()) env.ANTHROPIC_BASE_URL = form.baseUrl.trim();
  const maskedToken = form.authToken.trim()
    ? `${form.authToken.trim().slice(0, 4)}***`
    : form.id
      ? "<saved-encrypted-token>"
      : "<token>";
  if (form.authMode === "api_key") env.ANTHROPIC_API_KEY = maskedToken;
  else env.ANTHROPIC_AUTH_TOKEN = maskedToken;

  if (mainModel) env.ANTHROPIC_MODEL = mainModel;
  if (sonnet || defaultBare) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet || defaultBare;
  if (opus || defaultBare) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus || defaultBare;
  if (fable || opus || defaultBare) env.ANTHROPIC_DEFAULT_FABLE_MODEL = fable || opus || defaultBare;
  if (haiku || defaultBare) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku || defaultBare;
    env.ANTHROPIC_SMALL_FAST_MODEL = haiku || defaultBare;
  }
  if (subagent || defaultBare) env.CLAUDE_CODE_SUBAGENT_MODEL = subagent || defaultBare;
  if (form.disableNonEssentialTraffic) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  if (form.timeoutMs.trim()) env.API_TIMEOUT_MS = form.timeoutMs.trim();
  return env;
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
      max: "default",
    },
    thinkingValue: { off: "", minimal: "", low: "", medium: "", high: "", xhigh: "", max: "" },
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


/* ════════════════════════ Codex form state ════════════════════════ */

interface CodexModelFormState {
  id: string;
  /** 1M context toggle (Pi-style): on → contextWindow 1,000,000, spawned as
   *  a process-local `-c model_context_window` override. */
  context1m: boolean;
}

interface CodexFormState {
  /** Slug id (TOML table key + env suffix). Locked after creation. */
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Opt-in unlock for codex's imagegen tool (actor-header injection into
   *  the provider's config.toml table). Requires a gateway backing the
   *  OpenAI images API (gpt-image-2). */
  imageGeneration: boolean;
  models: CodexModelFormState[];
}

const emptyCodexForm = (): CodexFormState => ({
  id: "",
  name: "",
  baseUrl: "",
  apiKey: "",
  imageGeneration: false,
  models: [{ id: "", context1m: false }],
});

const codexFormFromConfig = (cfg: CodexProviderPublic): CodexFormState => ({
  id: cfg.id,
  name: cfg.name,
  baseUrl: cfg.baseUrl,
  apiKey: "",
  imageGeneration: Boolean(cfg.imageGeneration),
  models: cfg.models.map((m) => ({ id: m.id, context1m: m.contextWindow === 1_000_000 })),
});

/* ════════════════════════ unified list ════════════════════════ */

type Family = "claude" | "pi" | "codex" | "opencode";
type Selection =
  | { kind: "claude"; id: string | "new" }
  | { kind: "pi"; id: string | "new" }
  | { kind: "codex"; id: string | "new" }
  | null;
type ListItem = { kind: Family; id: string; name: string; sub: string };

/* ════════════════════════ main panel ════════════════════════ */

export function CustomModelsPanel() {
  const { t } = useI18n();
  const customModels = useSessionStore((s) => s.customModels);
  const activeClaudeProviderId = useSessionStore((s) => s.activeClaudeProviderId);
  const syncClaudeConfigUpdated = useSessionStore((s) => s.syncClaudeConfigUpdated);

  const [tab, setTab] = useState<Family>("claude");
  const [piProviders, setPiProviders] = useState<Record<string, PiProviderPublic>>({});
  const [codexProviders, setCodexProviders] = useState<CodexProviderPublic[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [claudeForm, setClaudeForm] = useState<ClaudeFormState | null>(null);
  const [piForm, setPiForm] = useState<PiFormState | null>(null);
  const [codexForm, setCodexForm] = useState<CodexFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [pendingDelete, setPendingDelete] = useState<Selection & { id: string } | null>(null);
  const [syncState, setSyncState] = useState<ClaudeSettingsSyncState>({
    activeProviderId: null,
    syncTarget: "mcode",
  });
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  const reloadPi = async () => {
    try {
      const { providers } = await api.piModels.list();
      setPiProviders(providers);
    } catch (err) {
      console.error("piModels.list failed:", err);
    }
  };

  const reloadCodex = async () => {
    try {
      const { providers } = await api.codexModels.list();
      setCodexProviders(providers);
    } catch (err) {
      console.error("codexModels.list failed:", err);
    }
  };

  const reloadSyncState = async () => {
    try {
      const next = await api.customModel.getSyncState();
      setSyncState(next);
    } catch (err) {
      console.error("customModel.getSyncState failed:", err);
    }
  };

  useEffect(() => {
    void reloadPi();
    void reloadCodex();
    void reloadSyncState();
  }, []);

  const listItems = useMemo<ListItem[]>(() => {
    if (tab === "codex") {
      return codexProviders.map((p) => ({
        kind: "codex" as const,
        id: p.id,
        name: p.name,
        sub: [
          p.models.length > 0
            ? t("settings.customModels.modelCount", { n: p.models.length })
            : t("settings.customModels.noModels"),
          p.hasApiKey
            ? t("settings.customModels.keyConfigured")
            : t("settings.customModels.keyNotConfigured"),
        ].join(" · "),
      }));
    }
    if (tab === "pi") {
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
  }, [tab, customModels, piProviders, codexProviders, t]);

  const isSelected = (item: ListItem) =>
    selection?.kind === item.kind && selection.id === item.id;

  const startNewClaude = () => {
    setSelection({ kind: "claude", id: "new" });
    setClaudeForm(emptyClaudeForm());
    setPiForm(null);
    setCodexForm(null);
    setTest({ status: "idle" });
    setError(null);
  };
  const startNewPi = () => {
    setSelection({ kind: "pi", id: "new" });
    setPiForm(emptyPiForm());
    setClaudeForm(null);
    setError(null);
  };
  const startNewCodex = () => {
    setSelection({ kind: "codex", id: "new" });
    setCodexForm(emptyCodexForm());
    setClaudeForm(null);
    setPiForm(null);
    setError(null);
  };
  const startEditCodex = (id: string) => {
    const cfg = codexProviders.find((p) => p.id === id);
    if (!cfg) return;
    setSelection({ kind: "codex", id });
    setCodexForm(codexFormFromConfig(cfg));
    setClaudeForm(null);
    setPiForm(null);
    setError(null);
  };
  const startEditClaude = (m: CustomModelPublic) => {
    setSelection({ kind: "claude", id: m.id });
    setClaudeForm(claudeFormFromConfig(m));
    setPiForm(null);
    setCodexForm(null);
    setTest({ status: "idle" });
    setError(null);
  };
  const startEditPi = (name: string) => {
    const cfg = piProviders[name];
    if (!cfg) return;
    setSelection({ kind: "pi", id: name });
    setPiForm(piFormFromConfig(name, cfg));
    setClaudeForm(null);
    setCodexForm(null);
    setError(null);
  };
  const cancel = () => {
    setSelection(null);
    setClaudeForm(null);
    setPiForm(null);
    setCodexForm(null);
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
      if (selection?.kind === "codex") return codexForm?.apiKey ?? null;
      return null;
    }
    if (selection.kind === "claude") return (await api.customModel.getToken({ id: selection.id })).token;
    if (selection.kind === "codex") return (await api.codexModels.getApiKey({ id: selection.id })).apiKey;
    return (await api.piModels.getApiKey({ name: selection.id })).apiKey;
  };

  const saveClaude = async () => {
    if (!claudeForm) return;
    if (!claudeForm.name.trim() || !claudeForm.baseUrl.trim()) {
      setError(t("settings.customModels.errNameBaseUrl"));
      return;
    }
    const models = buildModelsFromRoles(claudeForm.roles);
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
    const roleMeta: ClaudeTierRoleMetaMap = {};
    for (const key of CLAUDE_ROLE_KEYS) {
      const row = claudeForm.roles[key];
      const id = strip1mTag(row.model);
      if (!id) continue;
      const displayName = key !== "subagent" ? row.displayName.trim() : "";
      const supports1m = row.supports1m || /\[1m\]$/i.test(row.model.trim());
      roleMeta[key] = {
        ...(displayName ? { displayName } : {}),
        supports1m,
      };
    }

    const tierModels: ClaudeTierModels = {};
    const roleVal = (k: ClaudeRoleKey) => strip1mTag(claudeForm.roles[k].model);
    const sonnet = roleVal("sonnet");
    const opus = roleVal("opus");
    const fable = roleVal("fable");
    const haiku = roleVal("haiku");
    const subagent = roleVal("subagent");
    const defaultModel = sonnet || opus || fable || haiku || subagent;
    if (defaultModel) tierModels.defaultModel = defaultModel;
    if (sonnet) tierModels.sonnet = sonnet;
    if (opus) tierModels.opus = opus;
    if (fable) tierModels.fable = fable;
    if (haiku) tierModels.haiku = haiku;
    if (subagent) tierModels.subagent = subagent;
    if (Object.keys(roleMeta).length > 0) tierModels.roleMeta = roleMeta;

    const headersResult = customHeadersFromRows(claudeForm.customHeaders);
    if (!headersResult.ok) {
      setError(t("settings.customModels.errHeader"));
      return;
    }
    setSaving(true);
    setError(null);
    setSyncNotice(null);
    try {
      const { models: saved, activeProviderId, syncWarning } = await api.customModel.save({
        id: claudeForm.id,
        name: claudeForm.name.trim(),
        baseUrl: claudeForm.baseUrl.trim(),
        authMode: claudeForm.authMode,
        protocol: claudeForm.protocol,
        authToken: claudeForm.authToken.trim() || undefined,
        models,
        tierModels: Object.keys(tierModels).length > 0 ? tierModels : undefined,
        subagentModel: tierModels.subagent,
        disableNonEssentialTraffic: claudeForm.disableNonEssentialTraffic,
        timeoutMs,
        customHeaders: headersResult.headers,
      });
      if (syncWarning) setSyncNotice(syncWarning);
      const landedId = claudeForm.id ?? saved[saved.length - 1]?.id ?? null;
      syncClaudeConfigUpdated(saved, {
        editedId: landedId,
        activeProviderId,
        ...(activeProviderId && activeProviderId === landedId && !claudeForm.id ? { activatedId: landedId } : {}),
      });
      setSelection(landedId ? { kind: "claude", id: landedId } : null);
      setClaudeForm(null);
      setTest({ status: "idle" });
      void reloadSyncState();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const activateClaudeProvider = async (id: string) => {
    setSyncNotice(null);
    try {
      const { state, warning } = await api.customModel.setActive({ id });
      setSyncState(state);
      syncClaudeConfigUpdated(customModels, { activatedId: id, activeProviderId: state.activeProviderId });
      if (warning) setSyncNotice(warning);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const changeSyncTarget = async (target: ClaudeSettingsSyncTarget) => {
    setSyncNotice(null);
    try {
      const { state, warning } = await api.customModel.setSyncTarget({ target });
      setSyncState(state);
      if (warning) setSyncNotice(warning);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const importClaudeFromSettings = async () => {
    setSyncNotice(null);
    setError(null);
    try {
      const { candidate } = await api.customModel.importSettings();
      if (!candidate) {
        setSyncNotice(t("settings.customModels.importEmpty"));
        return;
      }
      setSelection({ kind: "claude", id: "new" });
      setPiForm(null);
      setCodexForm(null);
      setTest({ status: "idle" });
      const entryMap = new Map(candidate.models.map((m) => [strip1mTag(m.id), m]));
      const firstId = candidate.models[0] ? strip1mTag(candidate.models[0].id) : "";
      const rowFromId = (raw?: string): ClaudeRoleRowState => {
        const id = strip1mTag(raw || "");
        const entry = id ? entryMap.get(id) : undefined;
        return {
          model: id,
          displayName: entry?.displayName ?? "",
          supports1m: Boolean(entry?.supports1m),
          thinkingMode: "none",
          thinkingDefault: "medium",
        };
      };
      const sonnetId = candidate.tierModels?.sonnet || candidate.tierModels?.defaultModel || firstId;
      const opusId = candidate.tierModels?.opus || sonnetId;
      const fableId = candidate.tierModels?.fable || opusId;
      const haikuId = candidate.tierModels?.haiku || sonnetId;
      setClaudeForm({
        name: candidate.source === "claude" ? "Claude CLI" : "Mcode",
        baseUrl: candidate.baseUrl,
        authMode: candidate.authMode,
        protocol: "anthropic",
        authToken: candidate.authToken,
        roles: {
          sonnet: rowFromId(sonnetId),
          opus: rowFromId(opusId),
          fable: rowFromId(fableId),
          haiku: rowFromId(haikuId),
          subagent: { ...rowFromId(candidate.tierModels?.subagent), displayName: "" },
        },
        disableNonEssentialTraffic: candidate.disableNonEssentialTraffic,
        timeoutMs: candidate.timeoutMs ? String(candidate.timeoutMs) : "",
        customHeaders: Object.entries(candidate.customHeaders ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
      });
      setSyncNotice(
        t("settings.customModels.importSuccess", {
          source: candidate.source === "claude" ? "~/.claude/settings.json" : "~/.mcode/settings.json",
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const runClaudeTest = async (role: ClaudeRoleKey) => {
    if (!claudeForm) return;
    const timeoutMs = claudeForm.timeoutMs.trim() ? Number(claudeForm.timeoutMs.trim()) : undefined;
    if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      setError(t("settings.customModels.errTimeout"));
      return;
    }
    const row = claudeForm.roles[role];
    const model = strip1mTag(row.model);
    if (!claudeForm.baseUrl.trim() || !model) {
      setTest({ status: "fail", error: t("settings.customModels.errTestFields") });
      return;
    }
    if (!claudeForm.id && !claudeForm.authToken.trim()) {
      setTest({
        status: "fail",
        error: t("settings.customModels.errTestToken"),
      });
      return;
    }
    const headersResult = customHeadersFromRows(claudeForm.customHeaders);
    if (!headersResult.ok) {
      setTest({ status: "fail", error: t("settings.customModels.errHeader") });
      return;
    }
    setError(null);
    setTest({ status: "testing", role });
    try {
      const result = await api.customModel.test({
        id: claudeForm.id,
        baseUrl: claudeForm.baseUrl.trim(),
        authToken: claudeForm.authToken.trim() || undefined,
        authMode: claudeForm.authMode,
        protocol: claudeForm.protocol,
        model,
        supports1m: row.supports1m,
        disableNonEssentialTraffic: claudeForm.disableNonEssentialTraffic,
        timeoutMs,
        customHeaders: headersResult.headers,
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

  const saveCodex = async () => {
    if (!codexForm) return;
    if (!codexForm.id.trim()) return setError(t("settings.customModels.errCodexId"));
    if (!/^[a-zA-Z0-9_-]+$/.test(codexForm.id.trim()))
      return setError(t("settings.customModels.errCodexIdFormat"));
    if (!codexForm.name.trim()) return setError(t("settings.customModels.errProviderName"));
    if (!codexForm.baseUrl.trim()) return setError(t("settings.customModels.errBaseUrl"));
    const valid = codexForm.models.filter((m) => m.id.trim());
    if (valid.length === 0) return setError(t("settings.customModels.errNeedModel"));
    if (selection?.id === "new" && !codexForm.apiKey.trim())
      return setError(t("settings.customModels.errApiKey"));
    setSaving(true);
    setError(null);
    try {
      const { providers } = await api.codexModels.save({
        id: codexForm.id.trim(),
        name: codexForm.name.trim(),
        baseUrl: codexForm.baseUrl.trim(),
        ...(codexForm.imageGeneration ? { imageGeneration: true } : {}),
        models: valid.map((m) => ({
          id: m.id.trim(),
          ...(m.context1m ? { contextWindow: 1_000_000 } : {}),
        })),
        apiKey: codexForm.apiKey,
      });
      setCodexProviders(providers);
      setSelection({ kind: "codex", id: codexForm.id.trim() });
      setCodexForm(null);
      void useSessionStore.getState().reloadCodexAvailableModels();
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
        const { models, activeProviderId } = await api.customModel.delete({ id: target.id });
        syncClaudeConfigUpdated(models, { activeProviderId });
        void reloadSyncState();
      } else if (target.kind === "codex") {
        const { providers } = await api.codexModels.delete({ id: target.id });
        setCodexProviders(providers);
        void useSessionStore.getState().reloadCodexAvailableModels();
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

      {/* ───────── Claude / Pi / Codex / OpenCode family tabs ───────── */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex w-fit items-center gap-0.5 rounded-lg border border-edge bg-surface/40 p-0.5">
          {(["claude", "pi", "codex", "opencode"] as const).map((k) => {
            const count =
              k === "claude"
                ? customModels.length
                : k === "codex"
                  ? codexProviders.length
                  : k === "opencode"
                    ? null
                    : Object.keys(piProviders).length;
            const label =
              k === "claude" ? "Claude" : k === "codex" ? "Codex" : k === "opencode" ? "OpenCode" : "Pi";
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
                {k === "codex" ? <OpenAIBrandIcon size={13} className={tab === k ? "text-accent" : "text-content-subtle"} /> : null}
                {k === "opencode" ? <OpenCodeBrandIcon size={13} className={tab === k ? "text-accent" : "text-content-subtle"} /> : null}
                {label}
                {count !== null && <span className="tabular-nums text-[0.8571em] text-content-subtle">{count}</span>}
              </button>
            );
          })}
        </div>
        {tab === "claude" && (
          <div className="flex items-center gap-2">
            <span className="text-[0.7143em] text-content-subtle">{t("settings.customModels.syncTargetLabel")}</span>
            <Select.Root value={syncState.syncTarget} onValueChange={(v) => void changeSyncTarget(v as ClaudeSettingsSyncTarget)}>
              <Select.Trigger className="h-7 min-w-[140px] text-[0.7857em]">
                <Select.Value>
                  {(val: ClaudeSettingsSyncTarget) => {
                    const o = SYNC_TARGET_OPTIONS.find((x) => x.value === val) ?? SYNC_TARGET_OPTIONS[0];
                    return t(o.labelKey);
                  }}
                </Select.Value>
              </Select.Trigger>
              <Select.Portal><Select.Positioner><Select.Popup><Select.List>
                {SYNC_TARGET_OPTIONS.map((o) => (
                  <Select.Item key={o.value} value={o.value}>
                    <Select.ItemText>{t(o.labelKey)}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.List></Select.Popup></Select.Positioner></Select.Portal>
            </Select.Root>
          </div>
        )}
      </div>

      {tab === "claude" && syncNotice && (
        <div className="mb-2 rounded border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-[0.7857em] text-content">
          {syncNotice}
        </div>
      )}

      {/* OpenCode is a different SHAPE from the other three: no endpoint
          configs — an official-login surface (CLI health, connected
          integrations, Zen API-key connect, model preview). It gets the full
          width and never participates in the Selection/form machinery. */}
      {tab === "opencode" ? (
        <OpenCodeLoginPanel />
      ) : (
      <div className="grid min-h-0 flex-1 grid-cols-[225px_1fr] gap-4">
        {/* ───────── Left: provider list (family of the active tab) ───────── */}
        <aside className="flex min-h-0 flex-col rounded-md border border-edge bg-surface/40">
          <div className="flex items-center justify-between px-2.5 py-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
            <span>{t("settings.customModels.providers")}</span>
            <div className="flex items-center gap-1.5">
              {tab === "claude" && (
                <button
                  type="button"
                  onClick={() => void importClaudeFromSettings()}
                  title={t("settings.customModels.importTitle")}
                  className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[0.95em] font-normal normal-case tracking-normal text-accent hover:bg-surface-hover"
                >
                  <IconDownload size={11} />
                  {t("settings.customModels.importBtn")}
                </button>
              )}
              <span className="tabular-nums">{listItems.length}</span>
            </div>
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
            {listItems.map((item) => {
              const active = isSelected(item);
              const isActivatedClaude =
                item.kind === "claude" && (activeClaudeProviderId ?? syncState.activeProviderId) === item.id;
              return (
                <div
                  key={item.id}
                  onClick={() =>
                    item.kind === "claude"
                      ? startEditClaude(customModels.find((m) => m.id === item.id)!)
                      : item.kind === "codex"
                        ? startEditCodex(item.id)
                        : startEditPi(item.id)
                  }
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (item.kind === "claude") startEditClaude(customModels.find((m) => m.id === item.id)!);
                      else if (item.kind === "codex") startEditCodex(item.id);
                      else startEditPi(item.id);
                    }
                  }}
                  className={cn(
                    "relative flex w-full cursor-pointer items-center justify-between gap-1.5 rounded px-2.5 py-1.5 text-left transition-colors",
                    active ? "bg-surface-hover" : "hover:bg-surface-hover/60",
                  )}
                >
                  {active && <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[0.7857em] font-medium text-content">{item.name}</div>
                    <div className="mt-0.5 truncate pl-0.5 text-[0.7143em] text-content-subtle">{item.sub}</div>
                  </div>
                  {item.kind === "claude" && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void activateClaudeProvider(item.id);
                      }}
                      title={t("settings.customModels.activateTitle")}
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[0.6428em] font-medium transition-colors",
                        isActivatedClaude
                          ? "bg-accent/15 text-accent"
                          : "border border-edge text-content-subtle hover:border-accent/40 hover:text-content",
                      )}
                    >
                      {isActivatedClaude ? t("settings.customModels.activeBadge") : "✓"}
                    </button>
                  )}
                </div>
              );
            })}
            {selection?.id === "new" && selection.kind === tab && (
              <div className="relative block w-full rounded border border-dashed border-accent/60 bg-accent/5 px-2.5 py-1.5 text-left text-[0.7857em] italic text-accent">
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                {t(
                  tab === "pi"
                    ? "settings.customModels.newPi"
                    : tab === "codex"
                      ? "settings.customModels.newCodex"
                      : "settings.customModels.newClaude",
                )}
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
            ) : tab === "codex" ? (
              <Button variant="outline" size="sm" onClick={startNewCodex} disabled={selection?.id === "new"} className="w-full justify-center gap-1">
                <IconPlus size={12} /> {t("settings.customModels.addCodex")}
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
              syncTarget={syncState.syncTarget}
              test={test}
              saving={saving}
              error={error}
              revealToken={revealToken}
              onTest={(role) => void runClaudeTest(role)}
              onSave={() => void saveClaude()}
              onCancel={cancel}
              onDelete={claudeForm.id ? () => setPendingDelete({ kind: "claude", id: claudeForm.id! }) : undefined}
            />
          ) : selection?.kind === "codex" && codexForm ? (
            <CodexProviderForm
              key={`codex:${selection.id}`}
              form={codexForm}
              setForm={setCodexForm}
              saving={saving}
              error={error}
              revealToken={revealToken}
              isEdit={selection.id !== "new"}
              onSave={() => void saveCodex()}
              onCancel={cancel}
              onDelete={selection.id !== "new" ? () => setPendingDelete({ kind: "codex", id: selection.id }) : undefined}
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
      )}

      <ConfirmDialog
        open={pendingDelete != null}
        title={t(
          pendingDelete?.kind === "pi"
            ? "settings.customModels.deletePiTitle"
            : pendingDelete?.kind === "codex"
              ? "settings.customModels.deleteCodexTitle"
              : "settings.customModels.deleteClaudeTitle",
        )}
        description={
          pendingDelete?.kind === "codex" ? (
            <>
              {t("settings.customModels.deleteConfirmPre")}
              <code className="rounded bg-surface-muted px-1">{pendingDelete.id}</code>
              {t("settings.customModels.deleteCodexPost")}
            </>
          ) : pendingDelete?.kind === "pi" ? (
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


/* ════════════════════════ Codex provider form ════════════════════════ */

function CodexProviderForm({
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
  form: CodexFormState;
  setForm: (f: CodexFormState | null) => void;
  saving: boolean;
  error: string | null;
  revealToken: () => Promise<string | null>;
  isEdit: boolean;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const update = <K extends keyof CodexFormState>(key: K, value: CodexFormState[K]) =>
    setForm({ ...form, [key]: value });
  const updateModel = (idx: number, patch: Partial<CodexModelFormState>) =>
    setForm({ ...form, models: form.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
  const addModel = () => setForm({ ...form, models: [...form.models, { id: "", context1m: false }] });
  const removeModel = (idx: number) => setForm({ ...form, models: form.models.filter((_, i) => i !== idx) });

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("settings.customModels.codexIdLabel")} hint={t("settings.customModels.codexIdHint")}>
          <Input
            value={form.id}
            onChange={(e) => update("id", e.target.value)}
            disabled={isEdit}
            placeholder="deepseek"
          />
        </Field>
        <Field label={t("settings.customModels.providerNameLabel")}>
          <Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="DeepSeek" />
        </Field>
      </div>

      <Field label="Base URL" hint={t("settings.customModels.codexResponsesNote")}>
        <Input value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} placeholder="https://api.deepseek.com/v1" />
      </Field>

      <Field label="API Key" hint={t("settings.customModels.apiKeyHint")}>
        <SecretInput
          value={form.apiKey}
          onChange={(v) => update("apiKey", v)}
          placeholder={isEdit ? t("settings.customModels.apiKeyKeepPlaceholder") : "sk-..."}
          onReveal={revealToken}
        />
      </Field>

      <div className="flex items-start justify-between gap-3 rounded border border-edge bg-surface/40 p-2.5">
        <span className="flex flex-col gap-0.5">
          <span className="text-[0.7857em] font-medium text-content">{t("settings.customModels.imageGen")}</span>
          <span className="text-[0.7143em] leading-relaxed text-content-subtle">{t("settings.customModels.imageGenHint")}</span>
        </span>
        <Switch
          checked={form.imageGeneration}
          onCheckedChange={(v) => update("imageGeneration", v)}
          label={t("settings.customModels.imageGen")}
        />
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
            <div key={idx} className="grid grid-cols-[1fr_auto_auto] items-center gap-1.5 rounded border border-edge bg-surface/40 p-2">
              <Input value={m.id} onChange={(e) => updateModel(idx, { id: e.target.value })} placeholder={t("settings.customModels.modelIdPlaceholder")} />
              <label className="flex items-center gap-1 justify-self-center" title={t("settings.customModels.enable1m")}>
                <Switch checked={m.context1m} onCheckedChange={(v) => updateModel(idx, { context1m: v })} label={t("settings.customModels.enable1m")} />
                <span className="text-[0.6428em] text-content-muted">1M</span>
              </label>
              <Button variant="ghost" size="icon" onClick={() => removeModel(idx)} title={t("settings.customModels.deleteModel")}>
                <IconTrash size={12} />
              </Button>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <p className="rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-[0.7857em] text-danger">{error}</p>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        {onDelete && (
          <Button variant="ghost" size="sm" onClick={onDelete} className="mr-auto text-danger hover:text-danger">
            <IconTrash size={12} /> {t("common.delete")}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving ? t("settings.saving") : isEdit ? t("settings.customModels.update") : t("common.save")}
        </Button>
      </div>
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

const TIER_FOLLOW_SENTINEL = "__tier_follow__";

/** Reusable model input: free-form text box paired with a single-chevron
 *  quick-pick dropdown (`Select.Trigger` already renders its own chevron). */
function TierModelInput({
  value,
  onChange,
  placeholder,
  optionIds,
  pickTitle,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  optionIds: string[];
  pickTitle: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="flex-1"
      />
      {optionIds.length > 0 && (
        <Select.Root
          value={optionIds.includes(value.trim()) ? value.trim() : TIER_FOLLOW_SENTINEL}
          onValueChange={(v) => {
            if (v && v !== TIER_FOLLOW_SENTINEL) onChange(v as string);
          }}
        >
          {/* Trigger already includes Select.Icon -> IconChevronDown; pass no extra icon child. */}
          <Select.Trigger className="w-7 shrink-0 justify-center px-1" title={pickTitle} />
          <Select.Portal><Select.Positioner><Select.Popup><Select.List>
            {optionIds.map((id) => (
              <Select.Item key={id} value={id}>
                <Select.ItemText>{id}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.List></Select.Popup></Select.Positioner></Select.Portal>
        </Select.Root>
      )}
    </div>
  );
}

function ClaudeProviderForm({
  form,
  setForm,
  syncTarget,
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
  syncTarget: ClaudeSettingsSyncTarget;
  test: TestState;
  saving: boolean;
  error: string | null;
  revealToken: () => Promise<string | null>;
  onTest: (role: ClaudeRoleKey) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const isEdit = !!form.id;
  const isOpenAi = form.protocol === "openai";
  const { t } = useI18n();
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(form.timeoutMs) || form.customHeaders.length > 0,
  );
  const [envPreviewOpen, setEnvPreviewOpen] = useState(false);
  const [copiedEnv, setCopiedEnv] = useState(false);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [quickSetNote, setQuickSetNote] = useState<string | null>(null);

  const update = <K extends keyof ClaudeFormState>(key: K, value: ClaudeFormState[K]) =>
    setForm({ ...form, [key]: value });

  const updateRole = (role: ClaudeRoleKey, patch: Partial<ClaudeRoleRowState>) => {
    setForm({
      ...form,
      roles: {
        ...form.roles,
        [role]: { ...form.roles[role], ...patch },
      },
    });
  };

  const updateHeader = (idx: number, patch: Partial<CustomHeaderRow>) =>
    update(
      "customHeaders",
      form.customHeaders.map((h, i) => (i === idx ? { ...h, ...patch } : h)),
    );
  const addHeader = () =>
    update("customHeaders", [...form.customHeaders, { name: "", value: "" }]);
  const removeHeader = (idx: number) =>
    update("customHeaders", form.customHeaders.filter((_, i) => i !== idx));

  const applyPreset = (preset: ClaudeProviderPreset) => {
    setActivePresetId(preset.id);
    setFetchedModels([]);
    setFetchError(null);
    const makeRow = (k: ClaudeRoleKey): ClaudeRoleRowState => {
      const seed = preset.roles[k];
      const model = seed?.model ?? "";
      return {
        model,
        displayName: k !== "subagent" ? (seed?.displayName ?? "") : "",
        supports1m: Boolean(seed?.supports1m),
        thinkingMode:
          preset.protocol === "openai" && model
            ? inferModelThinking(preset.baseUrl, model).mode
            : "none",
        thinkingDefault: "medium",
      };
    };
    setForm({
      ...form,
      name: preset.name,
      baseUrl: preset.baseUrl,
      authMode: preset.authMode,
      protocol: preset.protocol,
      roles: {
        sonnet: makeRow("sonnet"),
        opus: makeRow("opus"),
        fable: makeRow("fable"),
        haiku: makeRow("haiku"),
        subagent: makeRow("subagent"),
      },
    });
  };

  const fetchUpstreamModels = async () => {
    if (!form.baseUrl.trim()) {
      setFetchError(t("settings.customModels.errBaseUrl"));
      return;
    }
    const headersResult = customHeadersFromRows(form.customHeaders);
    if (!headersResult.ok) {
      setFetchError(t("settings.customModels.errHeader"));
      return;
    }
    setFetchingModels(true);
    setFetchError(null);
    try {
      const res = await api.customModel.fetchModels({
        id: form.id,
        baseUrl: form.baseUrl.trim(),
        authToken: form.authToken.trim() || undefined,
        authMode: form.authMode,
        protocol: form.protocol,
        customHeaders: headersResult.headers,
      });
      if (!res.ok) {
        setFetchError(res.error ?? t("settings.unknownError"));
        return;
      }
      setFetchedModels(res.models);
    } catch (err) {
      setFetchError((err as Error).message);
    } finally {
      setFetchingModels(false);
    }
  };

  const quickFillAllRoles = () => {
    const firstKey = CLAUDE_ROLE_KEYS.find((k) => strip1mTag(form.roles[k].model));
    if (!firstKey) {
      setQuickSetNote(t("settings.customModels.quickSetNeedModel"));
      return;
    }
    const source = form.roles[firstKey];
    const model = strip1mTag(source.model);
    const nextRoles = { ...form.roles };
    for (const k of CLAUDE_ROLE_KEYS) {
      nextRoles[k] = {
        ...nextRoles[k],
        model,
        displayName: k !== "subagent" ? source.displayName : "",
        supports1m: source.supports1m,
        thinkingMode: source.thinkingMode,
        thinkingDefault: source.thinkingDefault,
      };
    }
    setForm({ ...form, roles: nextRoles });
    setQuickSetNote(t("settings.customModels.quickSetDone", { model }));
    window.setTimeout(() => setQuickSetNote(null), 2200);
  };

  const configuredIds = Array.from(
    new Set(CLAUDE_ROLE_KEYS.map((k) => strip1mTag(form.roles[k].model)).filter(Boolean)),
  );
  const dropdownOptions = Array.from(new Set([...fetchedModels, ...configuredIds]));

  const envPreviewJson = useMemo(
    () => JSON.stringify({ env: buildClaudeEnvPreview(form) }, null, 2),
    [form],
  );
  const copyEnvPreview = async () => {
    try {
      await navigator.clipboard.writeText(envPreviewJson);
      setCopiedEnv(true);
      window.setTimeout(() => setCopiedEnv(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="space-y-3">
      {/* Quick presets bar (new mode only) */}
      {!isEdit && (
        <div>
          <div className="mb-1 text-[0.7143em] font-medium text-content-subtle">
            {t("settings.customModels.presetsLabel")}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CLAUDE_PROVIDER_PRESETS.map((p) => {
              const selected = activePresetId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-[0.7143em] font-medium transition-colors",
                    selected
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-edge bg-surface/60 text-content-muted hover:border-accent/40 hover:text-content",
                  )}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Core connection fields: Name + Base URL first */}
      <div className="grid grid-cols-[180px_1fr] gap-2">
        <Field label={t("settings.customModels.nameLabel")}>
          <Input
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder={t("settings.customModels.namePlaceholder")}
          />
        </Field>
        <Field label="Base URL">
          <Input
            value={form.baseUrl}
            onChange={(e) => update("baseUrl", e.target.value)}
            placeholder={isOpenAi ? "https://api.openai.com/v1" : "https://api.deepseek.com/anthropic"}
          />
        </Field>
      </div>

      {/* Token + Auth mode + API format */}
      <div className="grid grid-cols-[1fr_108px_150px] gap-2">
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
        <Field label={t("settings.customModels.protocolLabel")}>
          <Select.Root value={form.protocol} onValueChange={(v) => update("protocol", v as Protocol)}>
            <Select.Trigger className="w-full">
              <Select.Value>
                {(val: Protocol) => {
                  const o = PROTOCOL_OPTIONS.find((x) => x.value === val) ?? PROTOCOL_OPTIONS[0];
                  return (
                    <span className="flex items-center gap-1.5 truncate">
                      {o.icon}
                      <span className="truncate">{val === "openai" ? "OpenAI" : "Anthropic"}</span>
                    </span>
                  );
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
      </div>
      {isOpenAi && (
        <div className="space-y-1 text-[0.6428em] leading-relaxed text-content-subtle">
          <p>{t("settings.customModels.openaiNote")}</p>
          {(syncTarget === "claude" || syncTarget === "both") && (
            <p className="text-warning">{t("settings.customModels.openaiSyncHint")}</p>
          )}
        </div>
      )}

      {/* Unified single-table Model Mapping (modeled directly on cc-switch) */}
      <div className="space-y-2 rounded border border-edge bg-surface/30 p-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="text-[0.8571em] font-semibold text-content">
              {t("settings.customModels.modelMappingTitle")}
            </div>
            <p className="mt-0.5 text-[0.6428em] leading-relaxed text-content-subtle">
              {t("settings.customModels.modelMappingHint")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={quickFillAllRoles}
              title={t("settings.customModels.quickSetTitle")}
              className="h-7 gap-1 px-2 text-[0.7143em]"
            >
              <IconSparkles size={12} />
              {t("settings.customModels.quickSetBtn")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void fetchUpstreamModels()}
              disabled={fetchingModels}
              className="h-7 gap-1 px-2 text-[0.7143em]"
            >
              {fetchingModels ? (
                <IconLoader2 size={12} className="animate-spin" />
              ) : fetchedModels.length > 0 ? (
                <IconRefresh size={12} />
              ) : (
                <IconDownload size={12} />
              )}
              {fetchedModels.length > 0
                ? t("settings.customModels.refreshModelsBtn", { n: fetchedModels.length })
                : t("settings.customModels.fetchModelsBtn")}
            </Button>
          </div>
        </div>

        {quickSetNote && (
          <p className="text-[0.7143em] text-accent">{quickSetNote}</p>
        )}
        {fetchError && (
          <p className="rounded border border-danger/30 bg-danger/5 px-2 py-1 text-[0.7143em] text-danger">
            {fetchError}
          </p>
        )}

        <div className="hidden grid-cols-[84px_0.85fr_1fr_62px_28px] gap-1.5 px-0.5 text-[0.6428em] font-medium text-content-subtle md:grid">
          <span>{t("settings.customModels.modelRoleCol")}</span>
          <span>{t("settings.customModels.modelDisplayCol")}</span>
          <span>{t("settings.customModels.modelRequestCol")}</span>
          <span className="text-center">{t("settings.customModels.model1mCol")}</span>
          <span />
        </div>

        <div className="space-y-1.5">
          {CLAUDE_ROLE_ROWS.map((spec) => {
            const row = form.roles[spec.key];
            const testingThis = test.status === "testing" && test.role === spec.key;
            const modelBase = strip1mTag(row.model);
            return (
              <div key={spec.key} className="space-y-1">
                <div className="grid grid-cols-1 items-center gap-1.5 md:grid-cols-[84px_0.85fr_1fr_62px_28px]">
                  <div
                    title={spec.envKey}
                    className="flex h-7 items-center rounded border border-edge bg-surface/60 px-2 text-[0.75em] font-medium text-content-muted"
                  >
                    {t(spec.labelKey)}
                  </div>
                  {spec.hasDisplayName ? (
                    <Input
                      value={row.displayName}
                      onChange={(e) => updateRole(spec.key, { displayName: e.target.value })}
                      placeholder={modelBase || t("settings.customModels.modelDisplayNameOpt")}
                    />
                  ) : (
                    <div className="flex h-7 items-center rounded border border-edge bg-surface/40 px-2 text-[0.7143em] text-content-subtle">
                      {t("settings.customModels.subagentNoMenu")}
                    </div>
                  )}
                  <TierModelInput
                    value={row.model}
                    onChange={(next) => updateRole(spec.key, { model: next })}
                    placeholder={t("settings.customModels.modelIdPlaceholder")}
                    optionIds={dropdownOptions}
                    pickTitle={t("settings.customModels.tierPickFromList")}
                  />
                  <label
                    className="flex items-center justify-center gap-1 text-[0.7143em] text-content-muted"
                    title={t("settings.customModels.supports1mLabel")}
                  >
                    <input
                      type="checkbox"
                      checked={row.supports1m}
                      onChange={(e) => updateRole(spec.key, { supports1m: e.target.checked })}
                      className="accent-accent"
                    />
                    <span>1M</span>
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onTest(spec.key)}
                    disabled={test.status === "testing" || !modelBase}
                    title={t("settings.customModels.testWithModel")}
                    className="h-7 w-7"
                  >
                    {testingThis ? (
                      <IconLoader2 size={12} className="animate-spin" />
                    ) : (
                      <IconPlugConnected size={12} />
                    )}
                  </Button>
                </div>
                {isOpenAi && modelBase && spec.hasDisplayName && (
                  <div className="flex flex-wrap items-center gap-1.5 pl-1 md:pl-[90px]">
                    <span className="text-[0.6428em] text-content-subtle">
                      {t("settings.customModels.thinkingLabel")}
                    </span>
                    <Select.Root
                      value={row.thinkingMode}
                      onValueChange={(v) =>
                        updateRole(spec.key, { thinkingMode: v as CustomModelThinkingMode })
                      }
                    >
                      <Select.Trigger className="min-w-0 flex-1 text-[0.7143em]">
                        <Select.Value>
                          {(val: string | null) => {
                            const labelKey = THINKING_MODE_KEYS.find(
                              ([value]) => value === (val ?? "none"),
                            )?.[1];
                            return <span>{labelKey ? t(labelKey) : (val ?? "none")}</span>;
                          }}
                        </Select.Value>
                      </Select.Trigger>
                      <Select.Portal><Select.Positioner><Select.Popup><Select.List>
                        {THINKING_MODE_KEYS.map(([value, labelKey]) => (
                          <Select.Item key={value} value={value}>
                            <Select.ItemText>{t(labelKey)}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.List></Select.Popup></Select.Positioner></Select.Portal>
                    </Select.Root>
                    {row.thinkingMode === "reasoning_effort" && (
                      <Select.Root
                        value={row.thinkingDefault}
                        onValueChange={(v) => updateRole(spec.key, { thinkingDefault: v as string })}
                      >
                        <Select.Trigger
                          className="w-[7.5em] text-[0.7143em]"
                          title={t("settings.customModels.thinkingDefaultTitle")}
                        >
                          <Select.Value />
                        </Select.Trigger>
                        <Select.Portal><Select.Positioner><Select.Popup><Select.List>
                          {REASONING_EFFORT_LEVELS.map((lv) => (
                            <Select.Item key={lv} value={lv}>
                              <Select.ItemText>{lv}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.List></Select.Popup></Select.Positioner></Select.Portal>
                      </Select.Root>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Advanced + env preview */}
      <div className="flex flex-wrap items-center gap-3 pt-0.5">
        <button type="button" onClick={() => setAdvancedOpen((v) => !v)} className="flex items-center gap-1 text-[0.7857em] text-content-subtle hover:text-content-muted">
          <IconChevronRight size={12} className={cn("transition-transform", advancedOpen && "rotate-90")} />
          {t("settings.customModels.advancedToggle")}
        </button>
        <button type="button" onClick={() => setEnvPreviewOpen((v) => !v)} className="flex items-center gap-1 text-[0.7857em] text-content-subtle hover:text-content-muted">
          <IconCode size={12} />
          {t("settings.customModels.envPreviewToggle")}
        </button>
      </div>
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

          <div className="space-y-1.5 border-t border-edge pt-2">
            <div className="flex items-center justify-between">
              <span className="text-[0.7857em] text-content-muted">
                {t("settings.customModels.customHeadersLabel")}
              </span>
              <Button variant="ghost" size="sm" onClick={addHeader}>
                <IconPlus size={12} />
                {t("settings.customModels.customHeadersAdd")}
              </Button>
            </div>
            {form.customHeaders.map((h, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5">
                <Input
                  value={h.name}
                  onChange={(e) => updateHeader(idx, { name: e.target.value })}
                  placeholder={t("settings.customModels.customHeadersNamePlaceholder")}
                />
                <Input
                  value={h.value}
                  onChange={(e) => updateHeader(idx, { value: e.target.value })}
                  placeholder={t("settings.customModels.customHeadersValuePlaceholder")}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeHeader(idx)}
                  title={t("settings.customModels.customHeadersRemove")}
                >
                  <IconTrash size={13} />
                </Button>
              </div>
            ))}
            <p className="text-[0.6428em] leading-relaxed text-content-subtle">
              {t("settings.customModels.customHeadersHint")}
            </p>
          </div>
        </div>
      )}

      {envPreviewOpen && (
        <div className="space-y-1.5 rounded border border-edge bg-surface/50 p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[0.6428em] text-content-subtle">{t("settings.customModels.envPreviewHint")}</span>
            <Button variant="ghost" size="sm" onClick={() => void copyEnvPreview()} className="h-6 gap-1 px-2 text-[0.7143em]">
              {copiedEnv ? <IconCheck size={11} /> : <IconCopy size={11} />}
              {copiedEnv ? t("settings.customModels.copiedEnv") : t("settings.customModels.copyEnv")}
            </Button>
          </div>
          <pre className="max-h-48 overflow-auto rounded bg-surface p-2 font-mono text-[0.7143em] leading-relaxed text-content">
            {envPreviewJson}
          </pre>
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
