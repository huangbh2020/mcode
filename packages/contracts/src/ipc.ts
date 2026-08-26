/**
 * IPC contract — validated messages crossing the Electron main↔renderer boundary.
 * Every channel is whitelisted in the preload and validated with zod before
 * the main process acts on it. This is the security boundary.
 */
import { z } from "zod";
import type { RuntimeEvent } from "./runtime.js";
import type { Project, Session, MessageRecord, TurnInput, ApprovalDecision } from "./session.js";
import type { ProviderCapabilities, UserInputAnswers, BuiltinModelOption } from "./provider.js";
import type { CustomModelPublic, CustomModelInput, TestCustomModelResult } from "./customModel.js";
import type { PiProviderConfig, PiProviderPublic } from "./piModel.js";
import type { ThemeName, EffectiveTheme, ThemeChangedMessage } from "./theme.js";
import type { PairingStartResult, PairedDevice } from "./mobile.js";
import type { RelayStatus, RelayVpsConfig, RelayVpsConfigInput } from "./relay.js";

// Re-export relay types so consumers can import from "@contracts/ipc".
export type {
  RelayState,
  RelayStatus,
  RelayVpsConfig,
  RelayVpsConfigInput,
} from "./relay.js";
export {
  RelayVpsConfigSchema,
  RELAY_CONFIG_SETTING_KEY,
  RELAY_DEFAULT_PUBLIC_PORT,
} from "./relay.js";

/**
 * Default provider id — used when no provider is explicitly specified for a
 * new session. Currently "claude-sdk" (Claude Agent SDK).
 */
export const DEFAULT_PROVIDER_ID = "claude-sdk";

/**
 * Setting key under which the user's color-scheme preference is persisted.
 * Value is one of {@link ThemeName}: "dark" | "light" | "system". Shared
 * between main (theme module + IPC handler) and renderer (settings panel +
 * inline FOUC script) so the string never drifts.
 */
export const THEME_SETTING_KEY = "theme";

/** zod schema for the theme preference (used by SetThemeSchema). */
export const ThemeNameSchema = z.enum(["dark", "light", "system"]);

/**
 * Setting key under which the auto-update flow state is persisted, so reopening
 * the About panel (or restarting the app mid-download) restores the progress /
 * "ready to install" banner instead of dropping the user back to idle.
 *
 * Value is a JSON-encoded {@link PersistedUpdateState} string. The main process
 * writes it from the autoUpdater event callbacks; the renderer reads it on mount
 * via the generic `setting.get` IPC and clears it after install.
 */
export const UPDATE_STATE_SETTING_KEY = "update.state";

/**
 * Display mode for the center pane:
 *  - "single" (default): clicking a thread in the left bar replaces the
 *    center pane content (legacy behavior).
 *  - "tabs": threads accumulate as tabs along the top of the center pane.
 *    Closing a tab leaves any in-flight turn running in the background;
 *    re-opening the thread restores the live state.
 *
 * Persisted in the `settings` table under this key; the renderer reads it
 * at boot via the generic `setting.get` IPC and applies it to the
 * sessionStore's `displayMode` field.
 */
export const DISPLAY_MODE_SETTING_KEY = "ui.displayMode";

/**
 * Search-dialog file-type filter history. Persisted in the `settings` table
 * under this key as a JSON string array (most recent first, deduplicated,
 * capped) — the search dialog feeds it into a `<datalist>` so users can
 * re-pick file types they've typed before.
 */
export const SEARCH_FILE_TYPES_SETTING_KEY = "ui.search.fileTypes";

/** zod schema + TS union for the display-mode preference. */
export const DisplayModeSchema = z.enum(["single", "tabs"]);
export type DisplayMode = z.infer<typeof DisplayModeSchema>;

/**
 * UI language preference:
 *  - "zh" (default): Simplified Chinese — the project's original UI language.
 *  - "en": English.
 *
 * Persisted in the `settings` table under this key; the renderer reads it at
 * boot (first-paint `setting.getMany` batch) into the sessionStore's `locale`
 * field. All translated components subscribe to `locale` via `useI18n()` and
 * re-render immediately when it flips — no restart needed.
 */
export const UI_LOCALE_SETTING_KEY = "ui.locale";

/** zod schema + TS union for the UI language preference. */
export const LocaleSchema = z.enum(["zh", "en"]);
export type Locale = z.infer<typeof LocaleSchema>;

/**
 * Setting key under which the session auto-archive rules are persisted (JSON).
 *
 * A session is auto-archived when its `updated_at` (bumped by every activity)
 * is older than the project's effective threshold: `overrides[projectId]`
 * when present, otherwise `defaultDays`. A threshold of `0` means "never
 * archive". Pinned and running sessions are always excluded. The main-process
 * AutoArchiver reads this key fresh on every tick, so a settings change takes
 * effect on the next tick without any push sync.
 */
export const AUTO_ARCHIVE_SETTING_KEY = "session.autoArchive";

/** zod schema for the auto-archive rules persisted under AUTO_ARCHIVE_SETTING_KEY. */
export const AutoArchiveConfigSchema = z.object({
  /** Master switch — when false, the AutoArchiver is a no-op. */
  enabled: z.boolean(),
  /** Global default inactivity threshold in days; applies to every project
   *  without an explicit override. */
  defaultDays: z.number().int().min(0),
  /** Per-project overrides: projectId -> threshold in days (`0` = never
   *  archive). Projects absent from this map inherit `defaultDays`. */
  overrides: z.record(z.string(), z.number().int().min(0)),
});
export type AutoArchiveConfig = z.infer<typeof AutoArchiveConfigSchema>;

export const DEFAULT_AUTO_ARCHIVE_CONFIG: AutoArchiveConfig = {
  enabled: false,
  defaultDays: 30,
  overrides: {},
};

/**
 * Parse the raw settings-table value into an AutoArchiveConfig. Any malformed
 * or missing value falls back to the disabled default — shared by the main
 * AutoArchiver and the renderer's settings hydration.
 */
export function parseAutoArchiveConfig(raw: string | null | undefined): AutoArchiveConfig {
  if (!raw) return { ...DEFAULT_AUTO_ARCHIVE_CONFIG, overrides: {} };
  try {
    const parsed = AutoArchiveConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to the default
  }
  return { ...DEFAULT_AUTO_ARCHIVE_CONFIG, overrides: {} };
}


/**
 * Setting key under which the chat message-stream density is persisted.
 *  - "compact"    : tighter vertical rhythm — denser, more messages per fold.
 *  - "comfortable" (default): the historical look (assistant `mt-3` / user
 *    `mt-5`, block gap `space-y-2`).
 *  - "cozy"       : more breathing room between rows and blocks.
 *
 * Drives two CSS custom properties written on <html> by lib/appearance.ts:
 *   --chat-row-gap-assistant / --chat-row-gap-user (top margin of each row)
 *   --chat-block-gap (gap between blocks inside a single message)
 * with static fallbacks in styles.css so the uncustomized state matches the
 * old hardcoded values. Mirrors the displayMode pipeline.
 */
export const UI_CHAT_DENSITY_SETTING_KEY = "ui.chatDensity";

/** zod schema + TS union for the chat density preference. */
export const ChatDensitySchema = z.enum(["compact", "comfortable", "cozy"]);
export type ChatDensity = z.infer<typeof ChatDensitySchema>;

/**
 * Setting key under which the user's preferred left-bar project view is
 * persisted. `"flat"` (default) renders projects as a flat list; `"grouped"`
 * clusters them under collapsible headers keyed by `Project.group`. Mirrors
 * the displayMode pipeline (hydrated in sessionStore.init, written on toggle).
 */
export const UI_PROJECT_VIEW_SETTING_KEY = "ui.projectView";

/** zod schema + TS union for the left-bar project view preference. */
export const ProjectViewSchema = z.enum(["flat", "grouped"]);
export type ProjectView = z.infer<typeof ProjectViewSchema>;

/**
 * Setting key under which per-group metadata (color + display order) is
 * persisted as a JSON object keyed by group name. Groups are not a first-class
 * DB entity — they're derived from `Project.group` — so their metadata lives
 * here alongside the projects that reference them.
 *
 * Value shape: `Record<groupName, { color?: "R G B"|null, order?: number }>`.
 * `color` follows the same "R G B" triplet convention as userMessageColor /
 * accentColor (null = default theme color). `order` is ascending; groups
 * missing from the blob fall back to first-appearance order. Stale entries
 * for dissolved groups are harmless (filtered out on read by active groups).
 */
export const UI_PROJECT_GROUPS_SETTING_KEY = "ui.projectGroups";

/** Setting key under which the last-activated project id is persisted, so
 *  `init()` can restore the user's previous landing project on the next
 *  launch instead of always falling back to the first project. Written
 *  alongside {@link UI_LAST_SESSION_SETTING_KEY} whenever a session is
 *  activated (selectSession / openTab). Fire-and-forget: a failed write just
 *  means the next launch falls back to the default first-project selection. */
export const UI_LAST_PROJECT_SETTING_KEY = "ui.lastProjectId";

/** Setting key under which the last-activated session id is persisted.
 *  Paired with {@link UI_LAST_PROJECT_SETTING_KEY}; restored by `init()` to
 *  re-open the exact thread the user was on before quitting. */
export const UI_LAST_SESSION_SETTING_KEY = "ui.lastSessionId";

/** Metadata for a single project group. */
export const ProjectGroupMetaSchema = z.object({
  color: z.string().nullable().optional(),
  order: z.number().optional(),
});
export type ProjectGroupMeta = z.infer<typeof ProjectGroupMetaSchema>;

/** Per-group metadata map (groupName → { color, order }). */
export const ProjectGroupsMetaSchema = z.record(z.string(), ProjectGroupMetaSchema);
export type ProjectGroupsMeta = z.infer<typeof ProjectGroupsMetaSchema>;

/**
 * Setting key under which the user's keyboard-shortcut overrides are persisted
 * as a JSON object: `{ commandId: Accelerator }`. Only user-changed bindings
 * are stored — commands absent from this map fall back to the compiled-in
 * `DEFAULT_SHORTCUTS` table, so a version bump that adds new defaults takes
 * effect automatically while preserving older overrides.
 *
 * The Accelerator is platform-neutral: `cmd: true` means "the primary
 * modifier" (⌘ on macOS, Ctrl elsewhere). The renderer resolves it for
 * display and matching. Mirrors the displayMode pipeline.
 */
export const UI_SHORTCUTS_SETTING_KEY = "ui.shortcuts";

/** zod schema for a single accelerator. All three modifiers are always
 *  present (default false); `key` is the normalized main key, lowercase
 *  for letters ("k"), or a named key ("f1", "space", "escape"). */
export const AcceleratorSchema = z.object({
  key: z.string(),
  cmd: z.boolean().default(false),
  shift: z.boolean().default(false),
  alt: z.boolean().default(false),
});
export type Accelerator = z.infer<typeof AcceleratorSchema>;

/** zod schema for the whole override map: commandId → Accelerator. */
export const ShortcutBindingsSchema = z.record(z.string(), AcceleratorSchema);
export type ShortcutBindings = z.infer<typeof ShortcutBindingsSchema>;

/**
 * Setting key under which the user's preferred chat content font size (px)
 * is persisted. Value is a numeric string like "14". Validated/clamped in
 * the renderer store action (12–20 px). Mirrors the displayMode pipeline.
 */
export const UI_CHAT_FONT_SIZE_SETTING_KEY = "ui.chatFontSize";

/**
 * Setting key under which the user's preferred right-panel (files / git /
 * terminal) font size (px) is persisted. Value is a numeric string like
 * "14". Validated/clamped in the renderer store action (10–22 px). Drives
 * the `--right-panel-font-size` CSS var (and its `--rp-fs-*` derived
 * variants) plus the xterm terminal fontSize. Mirrors the chatFontSize
 * pipeline.
 */
export const UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY = "ui.rightPanelFontSize";

/**
 * Setting key under which the paste-to-card promotion threshold (character
 * count) is persisted. Value is a numeric string like "200". When a paste
 * exceeds this many characters (or spans more than the hardcoded line
 * threshold of 3), it's promoted to a content-tag chip above the composer
 * instead of being inserted inline. Validated/clamped in the renderer store
 * action (50–5000).
 */
export const UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY = "ui.pasteTagThresholdChars";

/**
 * Setting key under which the default voice-input mode is persisted.
 * Value is "continuous" (click to start/stop continuous dictation) or
 * "pushToTalk" (hold the mic button to talk, release to stop).
 * Hydrated into sessionStore.voiceInputMode at boot; the composer mic button
 * reads it as its default mode (the user can still flip it per-use from the
 * mic button's menu).
 */
export const UI_VOICE_INPUT_MODE_SETTING_KEY = "ui.voiceInputMode";

/** zod schema + TS union for the voice-input default mode. */
export const VoiceInputModeSchema = z.enum(["continuous", "pushToTalk"]);
export type VoiceInputMode = z.infer<typeof VoiceInputModeSchema>;

/**
 * Setting key under which the default speech-recognition language is
 * persisted. Value is a BCP-47-ish tag like "zh-CN" or "en-US" (used to pick
 * the ASR model / decoder language). Hydrated into sessionStore.voiceLang.
 */
export const UI_VOICE_LANG_SETTING_KEY = "ui.voiceLang";

/**
 * Setting key under which the chosen voice engine is persisted: "zipformer"
 * (streaming Chinese Zipformer — live interim results) or "parakeet" (offline
 * NVIDIA Parakeet — higher accuracy, no interim). Falls back to "zipformer"
 * when the parakeet engine/model is unavailable. Hydrated into
 * sessionStore.voiceEngine.
 */
export const UI_VOICE_ENGINE_SETTING_KEY = "ui.voiceEngine";

/** zod schema + TS union for the voice ASR engine. */
export const VoiceEngineSchema = z.enum(["zipformer", "parakeet"]);
export type VoiceEngine = z.infer<typeof VoiceEngineSchema>;

/**
 * Setting key under which the user's mic permission grant is cached
 * ("granted" | "denied" | ""). The main window's permission handler lets the
 * renderer request the microphone; this caches the outcome so the composing
 * mic button can show a clear "grant access" state instead of silently
 * failing. Managed by the renderer voice store action.
 */
export const UI_VOICE_MIC_PERMISSION_SETTING_KEY = "ui.voiceMicPermission";

/**
 * Setting key under which the active voice model id is persisted (one of the
 * ids in {@link VOICE_MODEL_CATALOG}). Choosing a model in Settings →
 * 语音输入 → 下载模型 writes this, and the engine resolves the model's files
 * under the download dir at `voice.start`. Empty = no model selected.
 */
export const UI_VOICE_MODEL_SETTING_KEY = "ui.voiceModel";

/**
 * Setting key under which the list of downloaded voice models is persisted as
 * a JSON array of the model ids present on disk (from the catalog). Kept in
 * sync by main after each download completes/removes; the settings panel reads
 * it to render the "已下载" list.
 */
export const UI_VOICE_DOWNLOADED_MODELS_SETTING_KEY = "ui.voiceDownloadedModels";

/**
 * Setting key under the local directory that downloaded voice model files are
 * kept in (absolute path, or empty string for the default `userData/models/voice`).
 * Each catalog model lives in `<dir>/<model-id>/`. The engine validates the files
 * exist at `voice.start` time and surfaces a clear "模型未下载" error.
 */
export const UI_VOICE_MODEL_DIR_SETTING_KEY = "ui.voiceModelDir";

/** Get the current effective model root (the user-customized path when set,
 *  otherwise the default `userData/models/voice`). Returned to the settings
 *  panel so it can render the current value. */
export const GetVoiceModelDirSchema = z.object({});
export type GetVoiceModelDirInput = z.infer<typeof GetVoiceModelDirSchema>;
export const GetVoiceModelDirResultSchema = z.object({
  /** The active root (never empty — resolves the default). */
  modelDir: z.string(),
  /** True when the user has customized the path. */
  isCustom: z.boolean(),
});
export type GetVoiceModelDirResult = z.infer<typeof GetVoiceModelDirResultSchema>;

/** Change the model root directory. The new path must be an absolute, writable
 *  directory; the call validates and rejects bad input. An empty string resets
 *  to the default `userData/models/voice` root. The new root is then scanned
 *  for already-downloaded catalog models so the renderer can update the list
 *  in a single round-trip. */
export const SetVoiceModelDirSchema = z.object({
  /** Absolute path, or "" to reset to the default. */
  modelDir: z.string(),
});
export type SetVoiceModelDirInput = z.infer<typeof SetVoiceModelDirSchema>;
export const SetVoiceModelDirResultSchema = z.object({
  modelDir: z.string(),
  isCustom: z.boolean(),
  /** Catalog models found under the new root. */
  downloaded: z.array(z.string()),
});
export type SetVoiceModelDirResult = z.infer<typeof SetVoiceModelDirResultSchema>;

/**
 * Setting key under which the draggable panel widths are persisted as a JSON
 * object: `{ left, right, bottomTerminal, editor }`.
 *  - `left` / `right`: side-bar widths in px (clamped 180–500 / 240–640).
 *  - `bottomTerminal`: bottom terminal bar height in px (clamped 80–600).
 *  - `editor`: editor-column share of the center pane as a percentage 0–100
 *    (clamped 20–80); the chat column gets the remainder.
 * Hydrated + clamped in sessionStore.init(); written (debounced) on drag end.
 */
export const UI_PANE_WIDTHS_SETTING_KEY = "ui.paneWidths";

/**
 * Setting key under which the user's custom user-message background color
 * is persisted. Value is a space-separated "R G B" triplet (e.g.
 * "124 58 237") so it composes with Tailwind's <alpha-value> placeholder.
 * An empty string / null means "use the theme default" (the --user-bubble
 * CSS var defined in styles.css per :root/.dark).
 */
export const UI_USER_MSG_COLOR_SETTING_KEY = "ui.userMessageColor";

/**
 * Setting key under which the user's custom brand/accent color is persisted.
 * Value is a space-separated "R G B" triplet (e.g. "5 150 105") so it
 * composes with Tailwind's <alpha-value> placeholder via the `accent` color
 * token. An empty string / null means "use the theme default" (the --accent
 * CSS var defined in styles.css per :root/.dark — emerald-600 in light,
 * emerald-500 in dark). Unlike --user-bubble (chat-only), --accent is the
 * global emphasis color: buttons, links, selected states, focus rings, and
 * the accent highlights in the three prompt cards all follow it.
 */
export const UI_ACCENT_COLOR_SETTING_KEY = "ui.accentColor";

/**
 * Setting key under which the active right-panel tab is persisted.
 * Value is one of "files" | "git" | "browser" | "turns". The right panel reads it
 * at boot and restores the last-used tab. "browser" re-enables the browser as an
 * embedded sidebar panel (mobile-first); on hydrate the store still falls back
 * to "files" so the browser doesn't auto-open at startup — the "browser" value
 * is only reached via an explicit user toggle during the session.
 * (Terminal used to live here as a tab but moved to the bottom bar; a persisted
 * "terminal" value is rejected by the schema and falls back to "files".)
 */
export const UI_RIGHT_PANEL_TAB_SETTING_KEY = "ui.rightPanelTab";

/** zod schema + TS union for the right-panel tab preference. */
export const RightPanelTabSchema = z.enum(["files", "git", "browser", "turns"]);
export type RightPanelTab = z.infer<typeof RightPanelTabSchema>;

/**
 * Setting key under which the IDE file editor's open-file list is persisted.
 * Value is a JSON-encoded `string[]` of absolute file paths (the tabs open in
 * the Monaco editor area). Empty/unset = no files open. Restored at boot so
 * the editor state survives restarts. Paths that no longer exist on disk are
 * dropped silently on first open.
 */
export const UI_IDE_OPEN_FILES_SETTING_KEY = "ui.ideOpenFiles";

/**
 * Setting key under which the IDE file editor's active file is persisted.
 * Value is an absolute file path, or empty/null for "none". Must be a member
 * of the open-files list to take effect.
 */
export const UI_IDE_ACTIVE_FILE_SETTING_KEY = "ui.ideActiveFile";

/**
 * Setting key under which the IDE file-tree's expanded directories are
 * persisted. Value is a JSON-encoded `string[]` of absolute directory paths.
 * Restored at boot so the tree re-opens to where the user left it.
 */
export const UI_IDE_EXPANDED_DIRS_SETTING_KEY = "ui.ideExpandedDirs";

/**
 * Setting key under which the IDE editor's open-mode preference is persisted.
 *  - "tabs"    (default): each opened file accumulates as a tab in the editor
 *               area; the user can have several files open and switch between
 *               them.
 *  - "replace": opening a file replaces whatever was previously open, so at
 *               most one file is ever shown (simpler, lower-clutter).
 * Persisted as one of the two literals; restored at boot.
 */
export const UI_IDE_EDITOR_MODE_SETTING_KEY = "ui.ideEditorMode";

/**
 * Setting key under which the composer's persisted provider/model choice is
 * stored — the "next session" defaults the user picked (SDK + model + custom
 * config). Value is a JSON-encoded `{ providerId, model, customModelId }`
 * object; hydrated at boot so the last pick is pre-selected, and validated
 * against the current model lists (a deleted model falls back to auto).
 */
export const UI_COMPOSER_MODEL_SETTING_KEY = "ui.composerModel";

/**
 * Setting key under which the custom-model id used for git-commit-message
 * generation is persisted. Value is a config id from CustomModelStore, or
 * empty/null for "use built-in model". Shared between main (the generator
 * handler resolves the config) and renderer (the settings panel reads/writes).
 */
export const UI_COMMIT_GEN_MODEL_SETTING_KEY = "ui.commitGenModel";

/**
 * Setting key under which the prompt template for commit-message generation
 * is persisted. Value is a string; the staged diff is appended after it.
 * Empty/unset → use a built-in default prompt.
 */
export const UI_COMMIT_GEN_PROMPT_SETTING_KEY = "ui.commitGenPrompt";

/**
 * Setting key under which the custom-model id used for AI git-conflict
 * resolution is persisted. Same shape as UI_COMMIT_GEN_MODEL_SETTING_KEY
 * (`"configId:roleKey"`); null/empty = use the built-in model. Shared
 * between main (the resolve handler resolves the config) and renderer
 * (the settings panel reads/writes).
 */
export const UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY = "ui.conflictResolveModel";

/**
 * Setting key under which the auto thread-title generation toggle is
 * persisted. Value is `"on"` (enabled) or `"off"` (disabled, default).
 * When enabled, the main process fires a one-shot LLM call on the first
 * user message of a new session to generate a short Chinese title, then
 * overwrites the placeholder title. Shared between main (the title-gen
 * routine reads it) and renderer (the settings panel reads/writes).
 */
export const UI_TITLE_GEN_ENABLED_SETTING_KEY = "ui.titleGenEnabled";

/** zod schema + TS union for the title-gen enabled preference. */
export const TitleGenEnabledSchema = z.enum(["on", "off"]);
export type TitleGenEnabled = z.infer<typeof TitleGenEnabledSchema>;

/**
 * Setting key under which the custom-model id used for auto thread-title
 * generation is persisted. Same shape as UI_COMMIT_GEN_MODEL_SETTING_KEY
 * (`"configId:roleKey"`); null/empty = use the built-in model. Shared
 * between main (the title-gen routine resolves the config) and renderer
 * (the settings panel reads/writes).
 */
export const UI_TITLE_GEN_MODEL_SETTING_KEY = "ui.titleGenModel";

/**
 * Setting key for per-repo collapsed state in the Git panel. Value is a
 * JSON-encoded `Record<string, boolean>` mapping repo paths to collapsed
 * state. Persisted so the collapsed/expanded state survives restarts.
 */
export const UI_GIT_COLLAPSED_REPOS_SETTING_KEY = "ui.gitCollapsedRepos";

/**
 * Setting key under which the user's notification preferences are persisted as
 * a JSON-encoded {@link NotificationPrefs} object. Controls whether OS-level
 * notifications fire (window unfocused) and which event categories trigger
 * them. Hydrated by the main-process NotificationManager at boot.
 */
export const NOTIFICATION_PREFS_SETTING_KEY = "notifications.prefs";

/** User-controllable notification preferences. Persisted under
 *  {@link NOTIFICATION_PREFS_SETTING_KEY}. */
export interface NotificationPrefs {
  /** Master switch for OS-level notifications. When false, no OS
   *  notifications are shown (in-app badges + toasts still work). Default
   *  true. */
  osEnabled: boolean;
  /** Notify on turn completion (non-active session). Default true. */
  turnComplete: boolean;
  /** Notify on errors (non-active session). Default true. */
  errors: boolean;
  /** Notify on blocking events (approval request / question / plan approval).
   *  Default true - these are the highest-value notifications since the agent
   *  is stalled until the user responds. */
  blocking: boolean;
  /** Notify when a backgrounded subagent finishes. Default true. */
  backgroundTasks: boolean;
}

/** Default notification prefs: everything on. The user can dial back via the
 *  settings panel. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  osEnabled: true,
  turnComplete: true,
  errors: true,
  blocking: true,
  backgroundTasks: true,
};

/** zod schema for the notification prefs JSON blob. */
export const NotificationPrefsSchema = z.object({
  osEnabled: z.boolean().default(true),
  turnComplete: z.boolean().default(true),
  errors: z.boolean().default(true),
  blocking: z.boolean().default(true),
  backgroundTasks: z.boolean().default(true),
});

/**
 * Setting key under which the user's saved terminal quick-commands are
 * persisted. Value is a JSON-encoded `CustomCommand[]` (name + command + id).
 *
 * @deprecated Replaced by {@link UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY}.
 * Commands are now scoped per-project. This key is no longer read or written
 * by the app; any persisted value is ignored. Kept only to avoid breaking
 * imports - to be removed in a future cleanup.
 */
export const UI_CUSTOM_COMMANDS_SETTING_KEY = "ui.customCommands";

/**
 * Setting key under which per-project terminal quick-commands are persisted.
 * Value is a JSON-encoded `Record<string, CustomCommand[]>` keyed by
 * `projectId`. Mirrors the per-project IDE-state persistence pattern
 * (ui.ideOpenFiles etc.): one setting row holds all projects' command lists,
 * and the renderer re-hydrates the whole map at boot.
 */
export const UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY = "ui.customCommandsByProject";

/** One user-saved terminal quick-command. `id` is a stable client-side id
 *  (used as the React key and for edit/delete targeting); `name` is the menu
 *  label; `command` is the shell text written to the PTY (run verbatim). */
export interface CustomCommand {
  id: string;
  name: string;
  command: string;
}

/** zod schema + TS union for the IDE editor open-mode preference. */
export const IdeEditorModeSchema = z.enum(["tabs", "replace"]);
export type IdeEditorMode = z.infer<typeof IdeEditorModeSchema>;

/**
 * Setting key under which the user's preferred way of opening a file diff from
 * the Git panel is persisted.
 *  - "center" (default): the diff opens in the center-area Monaco editor (the
 *               existing behavior - replaces/accumulates as editor tabs).
 *  - "dialog": the diff opens in a floating modal dialog that supports multiple
 *               diff tabs at once. Closing the dialog keeps the tabs; a button
 *               in the Git panel toolbar re-opens it.
 * Persisted as one of the two literals; restored at boot.
 */
export const UI_GIT_DIFF_OPEN_MODE_SETTING_KEY = "ui.gitDiffOpenMode";

/** zod schema + TS union for the git-diff open-mode preference. */
export const GitDiffOpenModeSchema = z.enum(["center", "dialog"]);
export type GitDiffOpenMode = z.infer<typeof GitDiffOpenModeSchema>;

/** Per-file view mode for the center file editor.
 *  - "edit": editable Monaco instance
 *  - "diff": read-only Monaco DiffEditor (vs a before-snapshot)
 *  - "preview": rendered Markdown preview (read-only)
 *  Markdown files default to "preview" on first open; the user can toggle back
 *  to "edit". Pure renderer state - not validated over IPC. */
export type FileViewMode = "edit" | "diff" | "preview";

/**
 * Permission modes are now open strings (see `PermissionMode` in runtime.ts).
 * This constant is kept for backward compatibility and for the claude-sdk
 * provider's own validation. The IPC schemas below use `z.string()` so any
 * provider can declare its own mode set via `ProviderCapabilities`.
 */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
] as const;
/** Legacy schema - still validates claude's 6 modes. Used only where we need
 *  to constrain to claude's set (e.g. the claude-sdk provider internals). */
export const PermissionModeSchema = z.enum(PERMISSION_MODES);

/* ──────────────────────────  Renderer → Main (RPC)  ────────────────────────── */

export const StartSessionSchema = z.object({
  projectId: z.string(),
  title: z.string().optional(),
  /** Provider id — which AI backend to use. Defaults to "claude-sdk". */
  providerId: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().default("default"),
  permissionMode: z.string().default("default"),
  /** Id of a custom-model config to bind to this session (omit/null = built-in). */
  customModelId: z.string().nullable().optional(),
});
export type StartSessionInput = z.infer<typeof StartSessionSchema>;

/** One user-attached image sent inline with the turn (base64, no data: prefix).
 *  Media types match the Anthropic image-block allowlist (jpeg/png/gif/webp) —
 *  the Pi provider accepts the same values. The 6M-char cap keeps the decoded
 *  bytes under Anthropic's ~5MB-per-image API limit. */
export const SendTurnImageSchema = z.object({
  /** Base64-encoded image bytes (no data: prefix). */
  data: z.string().min(1).max(6_000_000),
  mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
});
export type SendTurnImage = z.infer<typeof SendTurnImageSchema>;

export const SendTurnSchema = z.object({
  sessionId: z.string(),
  prompt: z.string(),
  attachments: z.array(z.string()).optional(),
  /** User-attached images inlined into the provider request as base64 content
   *  blocks (NOT paths — the model server can't read the local filesystem).
   *  Sent alongside `prompt`; an image-only turn passes an empty prompt. */
  images: z.array(SendTurnImageSchema).max(20).optional(),
  /** Override session-scoped settings for this turn (reflects current UI state). */
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  /** Override the session's bound custom model for this turn. null = clear
   *  (use built-in credential discovery); a string = bind to that config. */
  customModelId: z.string().nullable().optional(),
  /** Per-turn provider override. Normally the session's providerId is
   *  fixed at creation, but the UI can pass the active providerId here so
   *  the in-memory session is patched before RuntimeManager resolves the
   *  backend. Used as a per-turn override (NOT persisted — the session
   *  row's providerId stays as it was). */
  providerId: z.string().optional(),
  /** Skill names picked via composer skill pills this turn (no leading "/").
   *  Forwarded to the provider as the SDK `skills` allowlist so the model's
   *  Skill tool can reach them (stream-json input doesn't parse /name). */
  skills: z.array(z.string()).optional(),
  /** The sender's local user message (id / createdAt / display blocks).
   *  When present, the host echoes it to every client as a `user.message`
   *  RuntimeEvent so the prompt's bubble appears on the OTHER devices in
   *  real time (the sender dedupes by id — it already appended locally).
   *  Optional so older/foreign callers keep working (no echo, no dupes). */
  userMessage: z
    .object({
      id: z.string().min(1),
      createdAt: z.number(),
      blocks: z.array(z.unknown()),
      /** Set only when this send is an EDIT of an earlier user message
       *  (editAndResendMessage). Carries the id of the message being
       *  replaced so every OTHER client can truncate its own store at that
       *  message before appending the re-sent bubble — keeping their in-memory
       *  tail (and their turn.done persistence of it) consistent with the
       *  originator's truncation. Absent for a normal first send. */
      editedMessageId: z.string().optional(),
    })
    .optional(),
});
export type SendTurnInput = z.infer<typeof SendTurnSchema>;

export const InterruptSchema = z.object({ sessionId: z.string() });
export type InterruptInput = z.infer<typeof InterruptSchema>;

export const ApproveSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  granted: z.boolean(),
  always: z.boolean().optional(),
});
export type ApproveInput = z.infer<typeof ApproveSchema>;

/* Answer to an AskUserQuestion. `requestId` matches the question.ask event.
 * Each value is one question's answer: option label (string), labels
 * (string[] for multi-select), or null (skipped). See UserInputAnswers.
 * `dismissed: true` means the user closed the question card without
 * answering — main resolves the provider's pending Deferred as dismissed so
 * the model's turn continues instead of blocking forever. */
export const RespondQuestionSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
  dismissed: z.boolean().optional(),
});
export type RespondQuestionInput = {
  sessionId: string;
  requestId: string;
  answers: UserInputAnswers;
  dismissed?: boolean;
};

/* User's decision on a pending ExitPlanMode plan-approval request. `requestId`
 * matches the plan.approval_request event. The decision fields (approved /
 * editedPlan / reason) mirror PlanApprovalDecision in provider.ts; we spell
 * them out here so zod's inferred type matches without a circular import. */
export const RespondPlanApprovalSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  approved: z.boolean(),
  editedPlan: z.string().optional(),
  reason: z.string().optional(),
  /* User's plan-adjustment feedback from the approval sheet. Attached to the
   * decision: on approve it's delivered to the model alongside the approval
   * (execution should incorporate it); on reject it doubles as the reason. */
  feedback: z.string().optional(),
});
export type RespondPlanApprovalInput = z.infer<typeof RespondPlanApprovalSchema>;

/* Rewind a turn: restore the given files to their `before` state. The
 * renderer passes the explicit TurnFileEntry[] (the card's own frozen
 * list), so this works for BOTH the latest turn (entries from the live
 * snapshot) and any historical turn (entries persisted on the message),
 * AND for a session reopened after restart (entries rehydrated from the
 * DB) — none of those cases depend on the in-memory FileSnapshot being
 * present. Main resolves each path against the session's cwd and refuses
 * any path that escapes it (path-traversal guard).
 *
 * `targetFiles`: the requested path set, forwarded onto the
 * `turn.rewound` event so the renderer can locate the exact card to
 * mark `rewound: true`. Always present — the card is never removed,
 * only marked, for both latest-turn and historical rewinds. */
export const RewindTurnSchema = z.object({
  sessionId: z.string(),
  files: z.array(
    z.object({
      filePath: z.string(),
      kind: z.enum(["modified", "created"]),
      adds: z.number(),
      dels: z.number(),
      before: z.string(),
    }),
  ),
  targetFiles: z.array(z.string()),
});
export type RewindTurnInput = z.infer<typeof RewindTurnSchema>;

/* Per-session settings update (model / effort / permissionMode / customModelId).
 * Only the fields present in the payload are persisted; omitted fields are
 * left as-is. */
export const UpdateSessionSettingsSchema = z.object({
  sessionId: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  customModelId: z.string().nullable().optional(),
  /** Provider id (e.g. "claude-sdk"). Only honored while the session has no
   *  messages yet — once a turn has run the provider is fixed at creation, so
   *  the main handler rejects this field for non-empty sessions. */
  providerId: z.string().optional(),
});
export type UpdateSessionSettingsInput = z.infer<typeof UpdateSessionSettingsSchema>;

export const CreateProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

/* Project / session lifecycle: archive (soft-delete, restorable) and delete
 * (hard, cascading — projects take their sessions+messages with them via the
 * DB's ON DELETE CASCADE). */
export const DeleteProjectSchema = z.object({ id: z.string() });
export const ArchiveProjectSchema = z.object({ id: z.string(), archived: z.boolean() });
/* Assign a project to a group (left-bar "grouped" view). `group` is null to
 * remove the project from any group. Group names are free-form strings; the
 * store trims and clamps the length before sending. */
export const SetProjectGroupSchema = z.object({
  id: z.string(),
  group: z.string().max(50).nullable(),
});
export type SetProjectGroupInput = z.infer<typeof SetProjectGroupSchema>;
/* Persist the user's drag-to-reorder. The renderer sends the full ordered
 * list of project ids as they should appear; the main process writes
 * sort_order = index for each row. Sending the whole list (rather than a
 * from/to pair) keeps the operation atomic and avoids drift when rows were
 * deleted (leaving gaps in sort_order). */
export const ReorderProjectsSchema = z.object({
  orderedIds: z.array(z.string()),
});
export type ReorderProjectsInput = z.infer<typeof ReorderProjectsSchema>;
export const DeleteSessionSchema = z.object({ id: z.string() });
export const ArchiveSessionSchema = z.object({ id: z.string(), archived: z.boolean() });

/* Pin/unpin a session (project-scoped: pinned sessions sort to the top of
 * their project's list, most recent pin first). */
export const PinSessionSchema = z.object({ id: z.string(), pinned: z.boolean() });
export type PinSessionInput = z.infer<typeof PinSessionSchema>;

/* Rename a session (user-edited title). Title is clamped to a sane length;
 * empty/whitespace-only is rejected by the min(1) on the trimmed value (the
 * store trims before sending). */
export const RenameSessionSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
});
export type RenameSessionInput = z.infer<typeof RenameSessionSchema>;

/* Open a path in the OS file manager. The main handler refuses any path that
 * isn't an exact match for a known project root, so the renderer can't ask it
 * to open arbitrary locations. */
export const OpenPathSchema = z.object({ path: z.string() });
export type OpenPathInput = z.infer<typeof OpenPathSchema>;

/* Reveal a file or directory in the OS file manager (Finder / Explorer),
 * selecting it. Unlike `shell.openPath`, this accepts any path that resolves
 * inside a known project root (not just the root itself) - the main handler
 * enforces the same project-root containment check as the file handlers. Used
 * by the file-tree context menu's "Reveal in Explorer" action. */
export const ShowItemInFolderSchema = z.object({ path: z.string() });
export type ShowItemInFolderInput = z.infer<typeof ShowItemInFolderSchema>;

/** Open a file with the OS's default associated application (e.g. .docx in
 *  Word, .pdf in Preview). Accepts any path that resolves inside a known,
 *  non-archived project root - the same containment rule as
 *  `shell.showItemInFolder`. Used by the editor's "unsupported file" pane to
 *  let the user open binary files the editor can't preview. */
export const OpenFileSchema = z.object({ path: z.string() });
export type OpenFileInput = z.infer<typeof OpenFileSchema>;

/** List a project's sessions with optional pagination + archived filter.
 *  The left-bar tree loads the first `limit` (default 5) non-archived threads
 *  and appends the next page on "load more"; the archived bin requests
 *  `archived: true` (unpaginated). `hasMore` / `total` let the UI decide
 *  whether to render the "load more" affordance. */
export const ProjectSessionsSchema = z.object({
  projectId: z.string(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  archived: z.boolean().optional(),
});
export type ProjectSessionsInput = z.infer<typeof ProjectSessionsSchema>;

/** Cross-project session search by title substring. The unified Ctrl+K search
 *  palette uses this to list threads across the whole workspace (not just the
 *  active project's loaded page). Matches non-archived sessions only. */
export const SessionSearchSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional(),
});
export type SessionSearchInput = z.infer<typeof SessionSearchSchema>;

/* A persisted message: content is opaque JSON (text/thinking/tool_use blocks).
 * P2's renderer serializes its ChatMessage.blocks array here.
 * We use z.custom<unknown>() for content: zod treats z.unknown()/z.any() as
 * optional in its inferred type, which would mismatch MessageRecord.content
 * (required `unknown`). z.custom() preserves the exact type we give it. */
export const MessageRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.custom<unknown>((v) => v !== undefined, "content is required"),
  createdAt: z.number(),
});

export const SessionMessagesSchema = z.object({
  sessionId: z.string(),
  /** Page size. Omit for the legacy unpaginated path (all rows). */
  limit: z.number().int().positive().optional(),
  /** Cursor: fetch the page strictly older than this (createdAt, id) pair.
   *  Omit on the first page (most recent). */
  beforeCreatedAt: z.number().optional(),
  beforeId: z.string().optional(),
});
export type SessionMessagesInput = z.infer<typeof SessionMessagesSchema>;

export const SaveMessagesSchema = z.object({
  sessionId: z.string(),
  /** Full message snapshot for the session — replaces whatever is stored. */
  messages: z.array(MessageRecordSchema),
});
/**
 * We type `messages` against the domain MessageRecord rather than z.infer,
 * because zod renders z.unknown()/z.any() content as optional, which would
 * mismatch MessageRecord.content (required). The schema still validates shape
 * at runtime; the type is asserted to match the domain model.
 */
export type SaveMessagesInput = { sessionId: string; messages: MessageRecord[] };

/** Incremental message persist — upserts the given rows by id, leaving all
 *  other rows for the session untouched. Use for additive / localized changes
 *  (a turn's new messages, a turn-files card attached to a trailing message).
 *  Prefer this over {@link SaveMessagesSchema} when only a few rows changed —
 *  it avoids the O(N) DELETE+re-INSERT of a full snapshot. */
export const UpsertMessagesSchema = z.object({
  sessionId: z.string(),
  messages: z.array(MessageRecordSchema),
});
export type UpsertMessagesInput = { sessionId: string; messages: MessageRecord[] };

/** Edit-and-resend persist: delete every message at or after the cursor
 *  (createdAt, id) and insert the given replacement rows in one transaction.
 *  This is paginated-history-safe — older rows not loaded in renderer memory
 *  are preserved, whereas {@link SaveMessagesSchema} would wipe them. */
export const TruncateAndInsertMessagesSchema = z.object({
  sessionId: z.string(),
  cursorCreatedAt: z.number(),
  cursorId: z.string(),
  messages: z.array(MessageRecordSchema),
});
export type TruncateAndInsertMessagesInput = {
  sessionId: string;
  cursorCreatedAt: number;
  cursorId: string;
  messages: MessageRecord[];
};

/* ── Settings ── */
export const GetSettingSchema = z.object({ key: z.string() });
export type GetSettingInput = z.infer<typeof GetSettingSchema>;

export const SetSettingSchema = z.object({ key: z.string(), value: z.string() });
export type SetSettingInput = z.infer<typeof SetSettingSchema>;

/** Bulk read of setting keys — one IPC instead of N round-trips. Missing keys
 *  map to `null` in the result record. */
export const GetManySettingsSchema = z.object({ keys: z.array(z.string()) });
export type GetManySettingsInput = z.infer<typeof GetManySettingsSchema>;
export type GetManySettingsResult = Record<string, string | null>;

/* ── Voice input ── */

/**
 * Kick off an ASR session: ensure the model/engine is ready (downloading on
 * first use, lazily), create an online decoder for `lang`, and prepare to
 * receive PCM audio. `sessionId` lets the renderer run one live transcription
 * at a time per composer (a per-composer token); it is NOT the chat-session id.
 */
export const VoiceStartSchema = z.object({
  /** Opaque per-listen token chosen by the renderer (e.g. a random hex id). */
  sessionId: z.string().min(1),
  /** Speech language tag, e.g. "zh-CN" | "en-US". Picks the decoder language. */
  lang: z.string().min(1),
  /** Desired engine: "zipformer" (streaming, interim results) | "parakeet"
   *  (offline, higher accuracy). Falls back to zipformer when unavailable. */
  engine: VoiceEngineSchema,
});
export type VoiceStartInput = z.infer<typeof VoiceStartSchema>;

/** Feed a chunk of 16 kHz mono PCM samples to the active session's decoder.
 *  The Float32Array form is the preferred wire encoding (structured clone
 *  carries it at 4 bytes/sample and validation is a single instanceof check);
 *  the plain number[] form is still accepted for compatibility. */
export const VoiceFeedSchema = z.object({
  sessionId: z.string().min(1),
  pcm: z.union([z.instanceof(Float32Array), z.array(z.number()).max(65536 * 4)]),
});
export type VoiceFeedInput = z.infer<typeof VoiceFeedSchema>;

/** Stop the session and return the final (highest-confidence) transcript. */
export const VoiceStopSchema = z.object({ sessionId: z.string().min(1) });
export type VoiceStopInput = z.infer<typeof VoiceStopSchema>;

/** Cancel/discard a session (no final result emitted; drops partials). */
export const VoiceCancelSchema = z.object({ sessionId: z.string().min(1) });
export type VoiceCancelInput = z.infer<typeof VoiceCancelSchema>;

/** Result of voice.stop — the final recognized text ("" if nothing spoken). */
export const VoiceStopResultSchema = z.object({ text: z.string() });
export type VoiceStopResult = z.infer<typeof VoiceStopResultSchema>;

/** Main → renderer push: live recognition result for a voice session.
 *  `partial` = interim (streaming, possibly revised); `final` = committed
 *  segment for the current session. */
export const VoiceResultPayloadSchema = z.object({
  sessionId: z.string().min(1),
  kind: z.enum(["partial", "final"]),
  text: z.string(),
});
export type VoiceResultPayload = z.infer<typeof VoiceResultPayloadSchema>;

/* ── Voice model catalog + download ── */

/** One downloadable ASR model. `files` carry the exact filenames the engine
 *  requires (mirroring {@link STREAMING_ZIPFORMER_FILES} in the sherpa-onnx
 *  model zoo) plus per-file download URLs. `dir` is the local subdir name. */
export interface VoiceModelInfo {
  id: string;
  name: string;
  /** Human label for the primary language, e.g. "中文 (zh-CN)". */
  langLabel: string;
  /** Approximate expanded size, shown in the settings list. */
  sizeLabel: string;
  /** Subdirectory under the voice model dir that this model's files live in. */
  dir: string;
  files: { rel: string; url: string }[];
}

/**
 * The set of models the app can download. All are free / open (Apache-2.0)
 * and run fully on-device. Streaming Zipformer models give live interim
 * results (the "文字边听边出" UX). Hosted on HuggingFace under `csukuangfj`;
 * per-file URLs may move — keep them in sync with the sherpa-onnx model zoo.
 * @see https://k2-fsa.github.io/sherpa/onnx/
 */
export const VOICE_MODEL_CATALOG: VoiceModelInfo[] = [
  {
    id: "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23",
    name: "Streaming Zipformer 中文",
    langLabel: "中文 (zh-CN)",
    sizeLabel: "~67 MB",
    dir: "streaming-zipformer-zh",
    files: [
      {
        rel: "tokens.txt",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main/tokens.txt",
      },
      {
        rel: "encoder-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main/encoder-epoch-99-avg-1.int8.onnx",
      },
      {
        rel: "decoder-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main/decoder-epoch-99-avg-1.int8.onnx",
      },
      {
        rel: "joiner-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main/joiner-epoch-99-avg-1.int8.onnx",
      },
    ],
  },
  {
    id: "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
    name: "Streaming Zipformer 中英",
    langLabel: "中英双语 (zh + en)",
    sizeLabel: "~81 MB",
    dir: "streaming-zipformer-zh-en",
    files: [
      {
        rel: "tokens.txt",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main/tokens.txt",
      },
      {
        rel: "encoder-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main/encoder-epoch-99-avg-1.int8.onnx",
      },
      {
        rel: "decoder-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main/decoder-epoch-99-avg-1.int8.onnx",
      },
      {
        rel: "joiner-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main/joiner-epoch-99-avg-1.int8.onnx",
      },
    ],
  },
];

/** Start downloading a catalog model (`modelId`). Main streams files into the
 *  model dir and reports progress on `voice:downloadProgress`. */
export const VoiceDownloadModelSchema = z.object({
  modelId: z.string().min(1),
});
export type VoiceDownloadModelInput = z.infer<typeof VoiceDownloadModelSchema>;

/** List the catalog + which models are downloaded + the active selection. */
export const VoiceModelListSchema = z.object({});
export type VoiceModelListInput = z.infer<typeof VoiceModelListSchema>;
export const VoiceModelListResultSchema = z.object({
  models: z.array(z.custom<VoiceModelInfo>()),
  downloaded: z.array(z.string()),
  selected: z.string().nullable(),
  /** Active model root (after the user's customization, if any). */
  modelDir: z.string(),
  /** True when the user has set a custom model root. */
  isCustom: z.boolean(),
});
export type VoiceModelListResult = z.infer<typeof VoiceModelListResultSchema>;

/** Main → renderer push: download progress for a model. `percent` is 0–100
 *  across the whole model (byte-weighted when per-file sizes are known,
 *  file-count-weighted otherwise). */
export const VoiceDownloadProgressPayloadSchema = z.object({
  modelId: z.string().min(1),
  stage: z.enum(["downloading", "done", "error", "cancelled"]),
  /** Whole-model progress 0–100 (includes file index weighting). */
  percent: z.number().min(0).max(100),
  /** 0-based index of the file currently downloading. */
  fileIndex: z.number().min(0),
  fileCount: z.number().min(1),
  /** Bytes so far for the current file (for small-file UIs). */
  fileBytes: z.number().min(0),
  /** Total bytes of the current file when known (Content-Length); lets the
   *  UI render "12.3 / 50.6 MB" instead of a bare percentage. */
  fileTotalBytes: z.number().min(0).optional(),
  error: z.string().optional(),
});
export type VoiceDownloadProgressPayload = z.infer<
  typeof VoiceDownloadProgressPayloadSchema
>;

/* ── Notifications ── */

/** Input for getting/setting notification preferences. The prefs are persisted
 *  under {@link NOTIFICATION_PREFS_SETTING_KEY} as JSON; these RPCs provide a
 *  typed wrapper so the renderer doesn't hand-roll the JSON parse/stringify. */
export const GetNotificationPrefsSchema = z.object({});
export type GetNotificationPrefsInput = z.infer<typeof GetNotificationPrefsSchema>;

export const SetNotificationPrefsSchema = NotificationPrefsSchema;
export type SetNotificationPrefsInput = NotificationPrefs;

/** Input for focusing a session after an OS notification click. The main
 *  process brings the window to the front (show + focus), then pushes a
 *  `notification:focusSession` event so the renderer can navigate to the
 *  session (selectSession / openTab). */
export const FocusSessionSchema = z.object({ sessionId: z.string() });
export type FocusSessionInput = z.infer<typeof FocusSessionSchema>;

/* ── Custom model configs (user-defined Anthropic-compatible endpoints) ── */

/** One selectable model within a custom-model config. */
const CustomModelEntrySchema = z.object({
  id: z.string().min(1),
  supports1m: z.boolean().optional(),
});

const AuthModeSchema = z.enum(["auth_token", "api_key"]);

const ProtocolSchema = z.enum(["anthropic", "openai"]);

/** Save (create or update) a custom-model config. On update, an omitted
 *  `authToken` keeps the existing stored token; on create, `authToken` is
 *  required. At least one model entry is required. */
export const SaveCustomModelSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  authMode: AuthModeSchema.optional(),
  protocol: ProtocolSchema.optional(),
  authToken: z.string().optional(),
  models: z.array(CustomModelEntrySchema).min(1),
  disableNonEssentialTraffic: z.boolean().optional(),
  timeoutMs: z.number().optional(),
});
export type SaveCustomModelInput = CustomModelInput;

export const DeleteCustomModelSchema = z.object({ id: z.string() });

/** Probe a custom endpoint using the supplied (not-yet-saved) values, so the
 *  user can verify auth/baseUrl/a-specific-model before committing. The probe
 *  tests ONE model at a time (the user picks which model in the UI). */
export const TestCustomModelSchema = z.object({
  baseUrl: z.string().min(1),
  authToken: z.string().min(1),
  authMode: AuthModeSchema.optional(),
  protocol: ProtocolSchema.optional(),
  /** The single model id to probe in this request. */
  model: z.string().min(1),
  /** Whether to declare 1M context (adds the `[1m]` suffix) — mirrors the
   *  model row's toggle. */
  supports1m: z.boolean().optional(),
  disableNonEssentialTraffic: z.boolean().optional(),
  timeoutMs: z.number().optional(),
});
export type TestCustomModelInput = z.infer<typeof TestCustomModelSchema>;

/** Fetch the cleartext auth token for an already-saved custom-model config.
 *  This BREAKS the usual "cleartext never crosses IPC" rule on purpose: it
 *  exists solely so the settings UI can show the token when the user clicks
 *  the eye icon on an edit form. It MUST NOT be used by any background /
 *  turn-time path (those resolve the token in main via resolveApiConfig). */
export const GetCustomModelTokenSchema = z.object({ id: z.string().min(1) });
export type GetCustomModelTokenInput = z.infer<typeof GetCustomModelTokenSchema>;

/* ── Pi models (visual editor for ~/.pi/agent/models.json) ── */

/** Save a provider to models.json. `config` is the full provider object from
 *  the form; unknown fields are preserved by the store. `apiKey` is encrypted
 *  separately (safeStorage) and never written to models.json — empty string
 *  means "preserve the existing key" when updating; required when creating
 *  a new provider. */
export const SavePiProviderSchema = z.object({
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  apiKey: z.string().optional(),
});
export type SavePiProviderInput = z.infer<typeof SavePiProviderSchema>;

export const DeletePiProviderSchema = z.object({ name: z.string().min(1) });
export type DeletePiProviderInput = z.infer<typeof DeletePiProviderSchema>;

/** Get a provider's API key in cleartext. Main-process only — never
 *  exposed to the renderer. Used by PiAgentSdkProvider to inject the key
 *  into the pi authStorage at turn time. */
export const GetPiApiKeySchema = z.object({ name: z.string().min(1) });
export type GetPiApiKeyInput = z.infer<typeof GetPiApiKeySchema>;

/* ── Theme / color scheme ── */

export const SetThemeSchema = z.object({ theme: ThemeNameSchema });
export type SetThemeInput = z.infer<typeof SetThemeSchema>;
export type GetThemeResult = { theme: ThemeName; effective: EffectiveTheme };

/* ── App / runtime info (About panel) ── */

/** Runtime info surfaced to the About panel. `appVersion` comes from
 *  Electron's `app.getVersion()` (reads the root package.json in dev, the
 *  built app's version in production); the rest come from `process.versions`
 *  and `process.platform` on the main side. No input - it's a parameterless
 *  RPC. */
export interface AppInfoResult {
  /** App version string (e.g. "0.0.0" in dev, the release version in prod). */
  appVersion: string;
  /** Electron version. */
  electron: string;
  /** Bundled Node.js version. */
  node: string;
  /** Bundled Chromium version. */
  chromium: string;
  /** OS platform: "win32" | "darwin" | "linux". */
  platform: string;
  /** CPU architecture (e.g. "x64", "arm64"). */
  arch: string;
}

/* ── Auto-update (electron-updater, GitHub Releases channel) ── */

/** Result of a manual/auto update check. */
export type CheckForUpdatesResult =
  | { status: "up-to-date"; version: string }
  | { status: "available"; version: string; manualInstallRequired: boolean }
  | { status: "error"; error: string };

/** Pushed when the updater finds a newer version on the release channel.
 *  Sent right after `update-available` fires in main; the renderer shows a
 *  download prompt. autoDownload is off, so the user opts in. */
export interface UpdateAvailableMessage {
  channel: "update:available";
  /** Version string of the pending update (e.g. "0.2.0"). */
  version: string;
  /** Release notes (markdown or plain) from the release, if any. */
  releaseNotes?: string;
  /** ISO date string of the release, if available. */
  releaseDate?: string;
  /** Where the check that discovered this update came from: "auto" = the
   *  boot/interval check initiated by main, "manual" = the user clicked
   *  "check for updates" in the About panel. The global update notification
   *  card only auto-shows for "auto" so a manual check never pops a redundant
   *  card over the panel the user is already looking at. */
  source?: "auto" | "manual";
  /** True when Squirrel.Mac can't auto-install updates (macOS ad-hoc
   *  signature). Surfaced at discovery time — before any bytes are downloaded
   *  — so the renderer can guide the user to the releases page immediately
   *  instead of wasting a ~100MB in-app download that ends in "manual install
   *  required". Always false on Windows. */
  manualInstallRequired?: boolean;
}

/** Pushed when a downloaded update is ready to install. The renderer offers a
 *  "restart & install" button that calls `app.quitAndInstall`.
 *
 *  On macOS with an ad-hoc signed app (no Apple Developer ID), Squirrel.Mac
 *  silently fails to apply the update — the button appears to do nothing.
 *  When `manualInstallRequired` is true the renderer should instead guide the
 *  user to manually download from the releases page. */
export interface UpdateDownloadedMessage {
  channel: "update:downloaded";
  /** Version string of the downloaded update. */
  version: string;
  /** Release notes (markdown or plain) from the release, if any. */
  releaseNotes?: string;
  /** True when Squirrel.Mac can't auto-install the update (e.g. macOS ad-hoc
   *  signature). The renderer should offer a "go to download" action instead
   *  of "restart & install". Always false on Windows. */
  manualInstallRequired?: boolean;
}

/** Pushed repeatedly while an update downloads, carrying live progress so the
 *  About panel can render a percentage + byte counter instead of a static
 *  spinner. `percent` is 0-100. */
export interface UpdateDownloadProgressMessage {
  channel: "update:downloadProgress";
  /** Version string of the update being downloaded. */
  version: string;
  /** Download progress, 0-100. */
  percent: number;
  /** Bytes transferred so far. */
  transferred: number;
  /** Total bytes to download (0 if unknown). */
  total: number;
  /** Current download speed in bytes/second. */
  bytesPerSecond: number;
}

/** Persisted snapshot of the update flow, stored under
 *  {@link UPDATE_STATE_SETTING_KEY} so the About panel can restore the banner
 *  after being unmounted/remounted or after an app restart. Only the states
 *  worth restoring are persisted - transient checks/errors stay in memory. */
export interface PersistedUpdateState {
  /** "downloading" = an update is mid-download (autoUpdater resumes on boot);
   *  "downloaded" = an update is ready to install on next restart. */
  status: "downloading" | "downloaded";
  /** Version string of the update. */
  version: string;
  /** Last seen download percent (0-100). Only meaningful for "downloading". */
  percent: number;
  /** Bytes transferred so far. Only meaningful for "downloading". */
  transferred: number;
  /** Total bytes (0 if unknown). Only meaningful for "downloading". */
  total: number;
  /** ISO timestamp of when this snapshot was written. */
  updatedAt: string;
  /** Mirrors {@link UpdateDownloadedMessage.manualInstallRequired} so the
   *  banner restores the correct action (manual download vs restart & install)
   *  after app restart. Only meaningful for "downloaded". */
  manualInstallRequired?: boolean;
}

/* ── File operations (read / list dir / write) ── */

/** Read a single file's current content as utf-8 text. The main handler
 *  resolves the path against the session's project cwd and refuses anything
 *  that escapes it (path-traversal guard) — the renderer (contextIsolation)
 *  has no filesystem access of its own. Used by the turn-files diff card to
 *  fetch the post-turn content to diff against the snapshotted `before`. */
export const FileReadSchema = z.object({
  /** Absolute or cwd-relative path. Must resolve inside a known project root. */
  filePath: z.string(),
});
export type FileReadInput = z.infer<typeof FileReadSchema>;

/** Read a file as base64-encoded binary, returned as a `data:` URL ready for an
 *  `<img src=...>`. Used by the editor's image preview pane. Same
 *  project-root path-traversal guard as `file:readFile`. The `mimeType` is
 *  derived from the extension on the main side so the renderer doesn't have to.
 *  On refusal / failure returns `{ dataUrl: "" }` so the renderer can show a
 *  friendly error instead of throwing. */
export const FileReadBinarySchema = z.object({
  /** Absolute path. Must resolve inside a known project root. */
  filePath: z.string(),
});
export type FileReadBinaryInput = z.infer<typeof FileReadBinarySchema>;

/** Open the OS file dialog for image selection and return the files as base64.
 *  Main reads the files itself (the renderer can't read arbitrary paths under
 *  contextIsolation). A user-driven dialog is explicit consent, so no
 *  project-root guard applies — same trust level as `clipboard.saveFile`.
 *  Individual files above PICK_IMAGE_MAX_BYTES (main-side) are skipped; the
 *  renderer additionally downsizes before sending (see imageResize.ts). */
export const PickImagesSchema = z.object({});
export type PickImagesInput = z.infer<typeof PickImagesSchema>;

/** One image read from the user's file dialog. `data` is base64 without the
 *  `data:` prefix; `mimeType` is the SendTurn allowlist (jpeg/png/gif/webp). */
export interface PickedImage {
  /** Original file name (display only). */
  name: string;
  data: string;
  mimeType: SendTurnImage["mimeType"];
}

/** Save a file pasted from the OS clipboard (external image/file — copied in
 *  Finder, a browser, or a screenshot) to a temp path the agent can read.
 *  Bytes travel as base64 (matches the existing binary patterns); main
 *  preserves the original extension so the agent's Read tool can sniff image
 *  types, and returns the absolute temp path. The renderer then attaches it
 *  exactly like an internally dragged file (a `@path` file tag). */
export const ClipboardSaveFileSchema = z.object({
  /** Original file name (display + extension preservation). */
  name: z.string().min(1).max(255),
  /** base64-encoded file bytes (~52MB file ceiling). */
  bytes: z.string().min(1).max(70_000_000),
});
export type ClipboardSaveFileInput = z.infer<typeof ClipboardSaveFileSchema>;

export const ClipboardSaveFileResultSchema = z.object({
  ok: z.boolean(),
  /** Absolute temp path (set when ok). */
  path: z.string().optional(),
  error: z.string().optional(),
});
export type ClipboardSaveFileResult = z.infer<typeof ClipboardSaveFileResultSchema>;

/** Copy an image (a `data:image/...` URL, e.g. from an agent screenshot) onto
 *  the OS clipboard. The renderer's `navigator.clipboard` can't reliably write
 *  images, so main decodes the data URL into a nativeImage and calls
 *  `clipboard.writeImage`. The data URL scheme is validated here — main only
 *  trusts `data:image/` payloads, never remote URLs. */
export const ClipboardWriteImageSchema = z.object({
  /** Full `data:image/<mime>;base64,...` URL of the image to copy. */
  dataUrl: z.string().regex(/^data:image\/[a-z0-9.+-]+;base64,/i).max(80_000_000),
});
export type ClipboardWriteImageInput = z.infer<typeof ClipboardWriteImageSchema>;

export const ClipboardWriteImageResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type ClipboardWriteImageResult = z.infer<typeof ClipboardWriteImageResultSchema>;

/** One entry returned by `file.listDir`. `path` is the absolute filesystem
 *  path (already validated to sit inside a project root); `name` is the base
 *  name for display. `size` is only populated for files (bytes). */
export interface FileTreeEntry {
  name: string;
  /** Absolute path (cwd-resolved + validated by main). */
  path: string;
  isDir: boolean;
  /** File size in bytes (omitted for directories). */
  size?: number;
}

/** List a single level of a directory (non-recursive). `dirPath` is relative
 *  to `projectPath` (empty string = the project root itself). Main resolves
 *  it, refuses escapes, filters out ignored entries (node_modules, .git, …),
 *  and returns entries sorted directories-first then alphabetical. On any
 *  read failure the handler returns `{ entries: [] }` so the tree degrades
 *  gracefully rather than throwing into the renderer. */
export const FileListDirSchema = z.object({
  /** Absolute path of the project root the listing is scoped to. Must match a
   *  persisted Project.path — main cross-checks this against ProjectRepo. */
  projectPath: z.string(),
  /** Directory to list, relative to projectPath. "" or "." = root. */
  dirPath: z.string(),
});
export type FileListDirInput = z.infer<typeof FileListDirSchema>;

/**
 * One file hit from `file.search`. Paths are absolute and already validated
 * to sit inside the project root. `relativePath` uses forward slashes for
 * stable display across platforms.
 */
export interface FileSearchEntry {
  name: string;
  /** Absolute filesystem path. */
  path: string;
  /** Path relative to the project root (forward-slash separated). */
  relativePath: string;
}

/**
 * Recursive file search under a project root for composer @-mention and
 * "add context" pickers. Main walks the tree (skipping the same ignored
 * dirs as listDir), optionally filters by case-insensitive substring on
 * name/relativePath, and returns at most `limit` files. Directories are
 * never returned — only files. Empty query returns a truncated breadth-
 * first sample so the picker has something to show immediately.
 */
export const FileSearchSchema = z.object({
  /** Absolute path of the project root. Must match a persisted Project.path. */
  projectPath: z.string(),
  /** Optional case-insensitive filter over file name / relative path. */
  query: z.string().optional(),
  /** Optional file-extension allow-list (no dots, lowercased). Empty or
   *  absent means no filter; name search drops files outside the list. */
  includeExts: z.array(z.string().min(1).max(32)).max(50).optional(),
  /** Max files to return. Defaults to 80 on the main side. */
  limit: z.number().int().positive().max(2000).optional(),
});
export type FileSearchInput = z.infer<typeof FileSearchSchema>;

/**
 * Result of a `file.search` call. `files` are already ranked and sliced to
 * `limit`. `truncated` is true when more matches existed than the requested
 * `limit` (the caller showed a slice, not the full set). `incompleteScan` is
 * true when the walk itself was cut short by the traversal budget (visit /
 * depth caps) — some subtrees were never visited, so results may miss
 * matches regardless of ranking.
 */
export interface FileSearchResult {
  files: FileSearchEntry[];
  /** More matches existed than the returned slice. */
  truncated: boolean;
  /** The tree walk hit its visit/depth budget before finishing. */
  incompleteScan: boolean;
}

/** Write utf-8 content to a file, creating it (and parent dirs) if absent.
 *  Path must resolve inside a known project root (path-traversal guard,
 *  same as readFile). Returns `{ ok }`; on refusal or failure `ok` is false
 *  and the handler logs — the renderer surfaces a non-blocking error. */
export const FileWriteSchema = z.object({
  /** Absolute or cwd-relative path. Must resolve inside a known project root. */
  filePath: z.string(),
  content: z.string(),
});
export type FileWriteInput = z.infer<typeof FileWriteSchema>;

/** Create a directory (and any missing ancestors), scoped to a known project
 *  root. Used by the file-tree "新建文件夹" action. `recursive: true` means an
 *  already-existing dir is not an error. Returns `{ ok }`; on refusal or
 *  failure `ok` is false and the handler logs. */
export const FileMkdirSchema = z.object({
  /** Absolute path of the directory to create. Must resolve inside a known
   *  project root (path-traversal guard, same as writeFile). */
  dirPath: z.string(),
});
export type FileMkdirInput = z.infer<typeof FileMkdirSchema>;

/** Delete a file or directory by moving it to the system trash (recoverable).
 *  Used by the file-tree "删除" right-click action. The path must resolve
 *  inside a known project root; on refusal or failure `ok` is false and the
 *  handler logs — the renderer surfaces a non-blocking error. Returns `{ ok }`. */
export const FileDeleteSchema = z.object({
  /** Absolute path of the file or directory to trash. Must resolve inside a
   *  known project root (path-traversal guard, same as writeFile/mkdir). */
  targetPath: z.string(),
});
export type FileDeleteInput = z.infer<typeof FileDeleteSchema>;

/** Rename a file or directory in place (same parent directory). Both paths
 *  must resolve inside the same known project root and share the same parent
 *  directory — cross-directory moves are refused (that is a move, not a
 *  rename). Used by the file-tree "重命名" right-click action. On refusal or
 *  failure `ok` is false and the handler logs. Returns `{ ok }`. */
export const FileRenameSchema = z.object({
  /** Absolute path of the entry to rename. Must resolve inside a known project
   *  root. */
  oldPath: z.string(),
  /** Absolute path of the new name. Must be in the same project root and the
   *  same parent directory as `oldPath`. */
  newPath: z.string(),
});
export type FileRenameInput = z.infer<typeof FileRenameSchema>;

/** Native multi-file picker (project-external files allowed). Used by the
 *  composer "添加上下文" button to attach files that live outside the active
 *  project root — unlike the project-scoped `file.search`, this surfaces any
 *  file on the user's machine via the OS open dialog. */
export const DialogPickFilesSchema = z.object({
  /** Optional dialog title; defaults to a localized "选择文件" on the main side. */
  title: z.string().optional(),
});
export type DialogPickFilesInput = z.infer<typeof DialogPickFilesSchema>;

/**
 * One line-level match from `file.grep`. `lineNumber` is 1-based. `lineText`
 * is the raw matched line (untrimmed, so column offsets are meaningful).
 * `matches` are 0-based [start,end) column ranges for each occurrence of the
 * query on that line, for frontend highlighting.
 */
export interface FileGrepEntry {
  /** Absolute filesystem path. */
  path: string;
  /** Path relative to the project root (forward-slash separated). */
  relativePath: string;
  /** 1-based line number within the file. */
  lineNumber: number;
  /** Raw text of the matched line. */
  lineText: string;
  /** Column ranges of each query occurrence on this line (0-based [start,end)). */
  matches: Array<{ start: number; end: number }>;
}

/**
 * Grep file contents under a project root. Main walks the same ignored-dir-
 * filtered tree as `file.search`, skips binary files (null-byte sniff on the
 * first ~8KB + a binary-extension skip-list), and scans each text file's
 * lines for the query. Case-insensitive by default. Returns line-level
 * matches, capped at `limit` total and `maxResultsPerFile` per file.
 */
export const FileGrepSchema = z.object({
  /** Absolute path of the project root. Must match a persisted Project.path. */
  projectPath: z.string(),
  /** Substring to search for inside file contents. */
  query: z.string(),
  /** Optional file-extension allow-list (no dots, lowercased). Empty or
   *  absent means no filter; narrows rg's globs and the JS fallback. */
  includeExts: z.array(z.string().min(1).max(32)).max(50).optional(),
  /** Max total matches to return. Defaults to 200 on the main side. */
  limit: z.number().int().positive().max(500).optional(),
  /** Max matches per single file. Defaults to 10 on the main side. */
  maxResultsPerFile: z.number().int().positive().max(50).optional(),
  /** Case-sensitive match. Defaults to false. */
  caseSensitive: z.boolean().optional(),
});
export type FileGrepInput = z.infer<typeof FileGrepSchema>;

/**
 * Result of a `file.grep` call. `matches` are capped at `limit` total /
 * `maxResultsPerFile` per file. `truncated` is true when the match cap was
 * reached while more matches almost certainly exist in files scanned so far.
 * `incompleteScan` is true when the walk hit its visit/depth budget before
 * covering the whole tree — unseen subtrees may hold additional matches.
 */
export interface FileGrepResult {
  matches: FileGrepEntry[];
  /** The match cap was reached — more matches likely exist. */
  truncated: boolean;
  /** The tree walk hit its visit/depth budget before finishing. */
  incompleteScan: boolean;
}

/* ── ripgrep availability / one-click install ──
 *  `file.search` / `file.grep` prefer ripgrep when one is resolvable and
 *  degrade to the in-process scanners when not. These channels let the search
 *  dialog detect the missing binary and offer a one-click install (downloads
 *  the official release into `userData/bin`). */

/** Snapshot of ripgrep availability for the search dialog. `installing`
 *  mirrors the main-side in-flight guard so a reopen during an ongoing
 *  install shows the right state. */
export interface RgStatusResult {
  /** An `rg` binary is resolvable (bundled userData/bin checked first, then PATH). */
  available: boolean;
  /** Resolved binary path when available. */
  path?: string;
  /** An install has been requested and is still running. */
  installing: boolean;
}

export const RgInstallSchema = z.object({});
export type RgInstallInput = z.infer<typeof RgInstallSchema>;

/** Result of an `rg.install` request. On success the binary sits in
 *  `userData/bin` and subsequent searches pick it up. */
export interface RgInstallResult {
  ok: boolean;
  error?: string;
  /** Path of the installed binary on success. */
  path?: string;
}

/* ── Git operations (status / stage / commit / push / pull / diff) ──
 *  All git operations are scoped to a `repoPath` that must resolve inside a
 *  known project root. A single project folder may host MULTIPLE git repos
 *  (monorepo, submodules, nested projects) — `git.discoverRepos` finds them. */

/** A git repository discovered under a project folder. `path` is the absolute
 *  repo root (the directory containing `.git`). `name` is the relative path
 *  from the project root (or the basename for the root itself). */
export interface GitRepo {
  /** Absolute path to the repo root (contains `.git`). */
  path: string;
  /** Display name: path relative to the project root, or the folder name. */
  name: string;
  /** Always true — discriminator for future result unions. */
  isRepo: true;
}

/** Git status code for a single file, mirroring porcelain output. `index` is
 *  the staged (cached) status; `workingTree` is the unstaged status. Both use
 *  the same union of git status codes. */
export type GitStatusCode =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged"
  | "ignored"
  | "untracked";

/** One file's status in a repo. `path` is relative to the repo root. */
export interface GitFileStatus {
  path: string;
  /** Staged status (what's in the index vs HEAD). */
  index: GitStatusCode;
  /** Working-tree status (what's on disk vs the index). */
  workingTree: GitStatusCode;
}

/** Full status of a single repo. */
export interface GitStatusResult {
  /** Current branch name (empty in detached HEAD). */
  branch: string;
  /** Commits ahead of upstream (0 if no upstream). */
  ahead: number;
  /** Commits behind upstream (0 if no upstream). */
  behind: number;
  /** All changed files (staged + unstaged + untracked). */
  files: GitFileStatus[];
}

/** Result of a git operation that may fail (push/pull/commit). `ok` is false
 *  on any error; `error` carries a human-readable message (e.g. auth failure,
 *  no upstream, merge conflict). */
export interface GitOpResult {
  ok: boolean;
  /** Error message when ok is false. */
  error?: string;
  /** Set by `git:pull` when the pull produced a merge conflict. The repo is
   *  now in a conflicted (unmerged) state; `conflictedFiles` lists the paths
   *  that need resolution before the merge can be committed. */
  conflict?: boolean;
  conflictedFiles?: string[];
}

/** Discover all git repos under a project root (recursive, max depth 3). */
export const GitDiscoverReposSchema = z.object({
  projectPath: z.string(),
});
export type GitDiscoverReposInput = z.infer<typeof GitDiscoverReposSchema>;

/** Input for operations targeting a single repo. */
export const GitRepoPathSchema = z.object({
  repoPath: z.string(),
});
export type GitRepoPathInput = z.infer<typeof GitRepoPathSchema>;

/** Stage (git add) specific files. `filePaths` are relative to the repo root. */
export const GitStageSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string()),
});
export type GitStageInput = z.infer<typeof GitStageSchema>;

/** Unstage (git reset) specific files. `filePaths` are relative to the repo root. */
export const GitUnstageSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string()),
});
export type GitUnstageInput = z.infer<typeof GitUnstageSchema>;

/** Commit staged changes with a message. */
export const GitCommitSchema = z.object({
  repoPath: z.string(),
  message: z.string().min(1),
});
export type GitCommitInput = z.infer<typeof GitCommitSchema>;

/** Diff of a single file. `filePath` is relative to repo. When `staged` is
 *  true, diffs the index against HEAD (what will be committed); otherwise
 *  diffs the working tree against the index (unstaged changes). */
export const GitDiffSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
  /** If true, show staged (cached) diff — index vs HEAD. */
  staged: z.boolean().optional(),
});
export type GitDiffInput = z.infer<typeof GitDiffSchema>;

/** Discard (revert) local changes to specific files. For tracked files this
 *  runs `git checkout -- <files>` (restores to index/HEAD); for untracked files
 *  it runs `git clean -f -- <files>` (removes them). The handler decides per
 *  file based on its status. */
export const GitDiscardSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string()),
});
export type GitDiscardInput = z.infer<typeof GitDiscardSchema>;

/** Generate a commit message from the staged diff using an LLM.
 *  `repoPath` scopes the diff; `customModelId` + `customModelRole` select the
 *  specific model (a config + its role binding); `prompt` is the user's
 *  configured prompt template. The handler collects the staged diff, feeds
 *  it to the model via a one-shot SDK query, and returns the generated text. */
export const GitGenerateCommitSchema = z.object({
  repoPath: z.string(),
  /** Custom-model config id (from CustomModelStore). null = use built-in. */
  customModelId: z.string().nullable(),
  /** Which role binding within the config to use (e.g. "sonnet"). Ignored
   *  when customModelId is null. */
  customModelRole: z.string().nullable(),
  /** The user's prompt template. The diff is appended after this. */
  prompt: z.string(),
  /** Optional cancellation key: when present, the AbortController driving the
   *  SDK query is registered under this id so git.cancelGenerateCommit can
   *  abort an in-flight generation. */
  requestId: z.string().optional(),
});
export type GitGenerateCommitInput = z.infer<typeof GitGenerateCommitSchema>;

/** Cancel an in-flight git.generateCommitMessage call (matched by the
 *  requestId passed to it). No-op if that generation already finished. */
export const GitCancelGenerateCommitSchema = z.object({
  requestId: z.string(),
});
export type GitCancelGenerateCommitInput = z.infer<typeof GitCancelGenerateCommitSchema>;

/** Input for git.resolveConflicts: resolve all unmerged files in a repo via
 *  an AI one-shot call. `repoPath` scopes the operation; `customModelId` +
 *  `customModelRole` select the specific model (a config + its role binding,
 *  same shape as git.generateCommitMessage); null = use the built-in model.
 *  The handler reads each conflicted file's conflict markers, asks the model
 *  for a resolved version, writes it back, and runs `git add`. It does NOT
 *  commit — the user completes the merge commit after reviewing. */
export const GitResolveConflictsSchema = z.object({
  repoPath: z.string(),
  /** Custom-model config id (from CustomModelStore). null = use built-in. */
  customModelId: z.string().nullable(),
  /** Which role binding within the config to use (e.g. "sonnet"). Ignored
   *  when customModelId is null. */
  customModelRole: z.string().nullable(),
});
export type GitResolveConflictsInput = z.infer<typeof GitResolveConflictsSchema>;

/* ── Git history (log / show commit / show file at revision) ── */

/** One commit in a `git.log` / `git.showCommit` result. */
export interface GitCommitInfo {
  /** Full commit hash. */
  hash: string;
  /** Abbreviated hash (typically 7 chars). */
  shortHash: string;
  /** First line of the commit message. */
  subject: string;
  /** Remaining body after the subject (may be empty). */
  body?: string;
  /** Author display name. */
  author: string;
  /** Author date as ISO-8601 string. */
  authoredAt: string;
  /** Parent commit hashes (empty for root commits). Present on showCommit. */
  parents?: string[];
}

/** File change status inside a single commit (relative to its parent). */
export type GitCommitFileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied";

/** One file changed by a commit. */
export interface GitCommitFile {
  /** Path relative to the repo root (new path for renames). */
  path: string;
  status: GitCommitFileStatus;
  /** Previous path when status is renamed/copied. */
  oldPath?: string;
  additions?: number;
  deletions?: number;
}

/** Full detail for one commit: meta + changed files. */
export interface GitCommitDetail {
  commit: GitCommitInfo;
  files: GitCommitFile[];
}

/** Paginated commit log. `limit` defaults to 50; `skip` defaults to 0. */
export const GitLogSchema = z.object({
  repoPath: z.string(),
  /** Max commits to return (default 50, max 200). */
  limit: z.number().int().min(1).max(200).optional(),
  /** Number of commits to skip (for pagination). */
  skip: z.number().int().min(0).optional(),
  /** Optional ref to start from (branch/tag/hash). Defaults to HEAD.
   *  Restricted to safe ref characters to avoid CLI injection. */
  ref: z
    .string()
    .regex(/^[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref")
    .optional(),
});
export type GitLogInput = z.infer<typeof GitLogSchema>;

/** Commit hashes are restricted to hex so callers cannot inject CLI args. */
const GitCommitHashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{4,40}$/, "invalid commit hash");

/** Load meta + changed-file list for one commit. */
export const GitShowCommitSchema = z.object({
  repoPath: z.string(),
  commitHash: GitCommitHashSchema,
});
export type GitShowCommitInput = z.infer<typeof GitShowCommitSchema>;

/** Load parent-vs-commit file contents for Monaco diff. */
export const GitShowFileSchema = z.object({
  repoPath: z.string(),
  commitHash: GitCommitHashSchema,
  /** Path relative to the repo root (new path for renames). */
  filePath: z.string().min(1),
  /** Previous path when the file was renamed/copied in this commit. */
  oldPath: z.string().optional(),
});
export type GitShowFileInput = z.infer<typeof GitShowFileSchema>;

/* ── Git branch switching (list / checkout) ── */

/** Ref kind for `git.listBranches` entries. */
export type GitBranchType = "local" | "remote" | "tag";

/** One branch / tag entry in a `git.listBranches` result. */
export interface GitBranchInfo {
  /** Display name: short name for local (main), `origin/main` for remote,
   *  tag name for tags (v1.0.0). */
  name: string;
  /** True when this is the currently checked-out ref. */
  current: boolean;
  /** Short commit hash at this ref. */
  commit: string;
  /** Commit subject (first line of the message) at this ref. */
  label: string;
  /** Ref kind discriminator. */
  type: GitBranchType;
}

/** Grouped ref list returned by `git.listBranches`. */
export interface GitBranchListResult {
  /** Current branch name (empty string in detached HEAD). */
  current: string;
  /** True when the repo is in a detached HEAD state. */
  detached: boolean;
  /** Local branches (refs/heads). */
  local: GitBranchInfo[];
  /** Remote branches (refs/remotes), excluding the HEAD symref of each remote. */
  remote: GitBranchInfo[];
  /** Tags (refs/tags), annotated + lightweight. */
  tags: GitBranchInfo[];
}

/** Switch the working tree to another branch / tag / ref.
 *
 *  - `branch` is the target ref (local branch, remote branch, tag, or `HEAD`).
 *    Restricted to safe ref characters to avoid CLI injection (same charset as
 *    `GitLogSchema.ref`).
 *  - `newBranch`, when set, creates a new local branch from `branch` and checks
 *    it out (i.e. `git checkout -b <newBranch> <branch>`). Used both for
 *    creating a fresh branch from HEAD (`branch: "HEAD"`) and for tracking a
 *    remote branch (`branch: "origin/foo"`, `newBranch: "foo"`). */
export const GitCheckoutSchema = z.object({
  repoPath: z.string(),
  branch: z.string().regex(/^[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref"),
  /** When provided, create this new local branch from `branch` and check it out. */
  newBranch: z
    .string()
    .regex(/^[A-Za-z0-9._/\-]+$/, "invalid branch name")
    .optional(),
});
export type GitCheckoutInput = z.infer<typeof GitCheckoutSchema>;

/* ── Skill discovery (composer slash-command menu) ──
 *  The composer's `/` menu lists skills discovered by scanning the local
 *  filesystem (`~/.claude/skills/` global + `<project>/.claude/skills/`
 *  project-scoped). Each skill's SKILL.md frontmatter supplies the name +
 *  description; we don't depend on a running SDK session for the listing, so
 *  the menu is instant. Selecting a skill inserts `/name` into the textarea
 *  and the user sends it as a normal turn (SDK is started with
 *  `skills: "all"`, so the agent recognizes and runs the skill). */

export type SkillSource = "global" | "project";

/** One registered AI backend surfaced to the renderer via `provider.list`.
 *  The capabilities descriptor drives which composer chips / dropdown entries
 *  the UI renders for a given provider (declarative capability negotiation). */
export interface ProviderInfo {
  /** Provider id, e.g. "claude-sdk" / "pi-sdk". Persisted in Session.providerId. */
  id: string;
  /** Human-readable name for the provider picker. */
  displayName: string;
  capabilities: ProviderCapabilities;
}

/** One discoverable skill surfaced in the composer `/` menu. Mirrors the
 *  fields the SDK's own `SlashCommand` exposes (name / description /
 *  argumentHint) plus a `source` discriminator so the UI can show whether a
 *  skill came from the user's global dir or the active project. */
export interface SkillInfo {
  /** Skill name without the leading slash (e.g. "pdf"). Used as the slash
   *  command the user sends, and as the dedupe key (project overrides global). */
  name: string;
  /** Short description from SKILL.md frontmatter (may be empty when absent). */
  description: string;
  /** Hint for skill arguments (e.g. "<file>"), when present in frontmatter. */
  argumentHint?: string;
  /** Where the skill was discovered: user-global vs the active project. */
  source: SkillSource;
}

/** List skills for a project root. `projectPath` must match a persisted
 *  Project.path (main cross-checks, same containment guard as file ops). */
export const SkillsListSchema = z.object({
  projectPath: z.string(),
});
export type SkillsListInput = z.infer<typeof SkillsListSchema>;

/** Skill name charset — kebab-case-ish identifiers only. Restricting here
 *  (and again in main with pathWithin) prevents path-traversal via `../` or
 *  absolute paths. Matches what the SDK / Claude Code itself accepts. */
const SKILL_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Read one skill's full SKILL.md source. Returns the complete file text (no
 *  truncation — skills can be large). A missing file resolves to empty
 *  content so the editor opens cleanly for a not-yet-written skill. */
export const SkillsReadSchema = z.object({
  /** Project root (must match a persisted Project.path). Only used to verify
   *  the caller's identity; the skill itself is resolved by `source` + `name`. */
  projectPath: z.string(),
  /** Which skills root to read from: user-global or the active project. */
  source: z.enum(["global", "project"]),
  /** Skill name (= directory name under <root>/.claude/skills/). */
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
});
export type SkillsReadInput = z.infer<typeof SkillsReadSchema>;

/** Write (create or overwrite) a skill's SKILL.md. Creates the skill directory
 *  if absent; always writes the full file content (complete overwrite).
 *  `newName` is reserved for future rename support (when set and differs from
 *  `name`, the skill directory is moved first); v1 UI leaves it unset. */
export const SkillsSaveSchema = z.object({
  projectPath: z.string(),
  source: z.enum(["global", "project"]),
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
  /** Full SKILL.md text (frontmatter + body). Written verbatim. */
  content: z.string(),
  newName: z.string().regex(SKILL_NAME_RE).optional(),
});
export type SkillsSaveInput = z.infer<typeof SkillsSaveSchema>;

/** Delete a skill directory. For a symlinked skill only the link is removed
 *  (the target - e.g. a gstack checkout - is left intact); for a real
 *  directory the whole skill folder is removed recursively. */
export const SkillsDeleteSchema = z.object({
  projectPath: z.string(),
  source: z.enum(["global", "project"]),
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
});
export type SkillsDeleteInput = z.infer<typeof SkillsDeleteSchema>;

/* ── Skill import (settings panel) ──
 *  The settings panel's "Import" feature scans external skill directories
 *  (Claude Code ~/.claude/skills, Codex ~/.codex/skills, Zcode ~/.agents/skills
 *  + ~/.zcode/skills + plugin cache) and lets the user pick which skills to
 *  copy into Mcode's own global skills dir (~/.mcode/skills). This makes
 *  user-level skills available even under custom endpoints, where the SDK
 *  normally can't load them from ~/.claude/skills. */

/** Which external tool a scanned skill originated from. `"local"` covers skills
 *  discovered in an arbitrary user-picked local directory (the import dialog's
 *  "select folder" flow), as opposed to a known tool's install location. */
export type SkillTool = "claude-code" | "codex" | "zcode" | "local";

/** A skill discovered in an external tool's skill directory, available for
 *  import into Mcode's own ~/.mcode/skills. Carries the source directory's
 *  absolute path so the import handler can copy it without re-resolving. */
export interface ExternalSkillInfo {
  /** Skill name (from frontmatter, falling back to directory name). */
  name: string;
  /** Short description from SKILL.md frontmatter (may be empty). */
  description: string;
  /** Which external tool this skill was found in. */
  tool: SkillTool;
  /** Absolute path to the skill directory in the external tool's tree. */
  sourcePath: string;
}

/** Scan external tools' skill directories and return all discoverable skills.
 *  When `localDir` is provided, also scans that user-picked directory:
 *  if it directly contains a SKILL.md it is treated as a single skill,
 *  otherwise each SKILL.md-bearing subdirectory is treated as a skill (same
 *  rule as scanning a tool's skills root). Always resolves (degrades to an
 *  empty list on any IO error). */
export const SkillsScanSourcesSchema = z.object({
  /** Optional: a user-picked local directory to scan in addition to the fixed
   *  external tool dirs. Used by the import dialog's "select folder" flow. */
  localDir: z.string().optional(),
});
export type SkillsScanSourcesInput = z.infer<typeof SkillsScanSourcesSchema>;

/** A single skill to import: the source directory (from a scan result) and
 *  the name to use as the destination directory under ~/.mcode/skills. */
export const SkillsImportItemSchema = z.object({
  /** Absolute path to the source skill directory (from a scanSources result). */
  sourcePath: z.string(),
  /** Destination skill name (directory name under ~/.mcode/skills). */
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
});

/** Import (copy) selected skills from external tools into ~/.mcode/skills.
 *  Skills that already exist at the destination are skipped (not overwritten).
 *  Returns per-skill success/skip/error so the UI can report precisely. */
export const SkillsImportSchema = z.object({
  skills: z.array(SkillsImportItemSchema),
});
export type SkillsImportInput = z.infer<typeof SkillsImportSchema>;

/* ── Output style (settings panel) ──
 *  Claude sessions can run with a different "output style" — the CLI rewrites
 *  its system prompt to change HOW the model responds (default / Explanatory /
 *  Learning / Proactive / Concise, plus user-defined markdown styles). The SDK
 *  exposes this as `Settings.outputStyle` (NOT a top-level Options field) and
 *  offers no runtime switch control request, so the selection is persisted
 *  here and injected per-turn by the Claude provider. Changes therefore apply
 *  on the NEXT turn (same contract as the MCP panel). Pi sessions do not
 *  support output styles. */

/**
 * Setting key under which the selected output style name is persisted.
 * Value = the exact style name the CLI matches on: a built-in id
 * ("default" | "Explanatory" | "Learning" | "Proactive" | "Concise") or the
 * frontmatter `name` of a custom style in ~/.mcode/output-styles/*.md.
 * Empty/null = never configured → nothing injected (CLI default behavior).
 */
export const AGENT_OUTPUT_STYLE_SETTING_KEY = "agent.outputStyle";

/** Which source a listed output style comes from. */
export type OutputStyleSource = "builtin" | "user";

/** One row of the settings panel's output-style list. `id` is the value to
 *  persist under AGENT_OUTPUT_STYLE_SETTING_KEY. `description` is only set
 *  for user styles (verbatim frontmatter text — user content, not localized);
 *  built-in descriptions are i18n'd renderer-side by id. */
export interface OutputStyleEntry {
  id: string;
  source: OutputStyleSource;
  description?: string;
}

/** List selectable output styles (built-ins gated by the bundled CLI version
 *  + user styles scanned from ~/.mcode/output-styles). */
export const OutputStyleListSchema = z.object({});
export type OutputStyleListInput = z.infer<typeof OutputStyleListSchema>;

/* ── MCP management (settings panel) ──
 *  The settings panel's "MCP" section lists three MCP server sources and lets
 *  the user toggle, add, remove and import them:
 *   - user scope: the `mcpServers` object of ~/.mcode/.claude.json — Mcode's
 *     redirected Claude config root (CLAUDE_CONFIG_DIR). The claude binary
 *     loads these automatically (settingSources default includes "user"), so
 *     the file is the source of truth; disabling a server moves its config
 *     out of the file into the management-state stash below, which is what
 *     keeps the binary from loading it.
 *   - project scope: <projectRoot>/.mcp.json (read-only, never rewritten).
 *     The CLI's native first-use approval dialog can't surface through our
 *     onUserDialog bridge (unknown kinds get cancelled), so this panel
 *     replaces it: project servers default to OFF and are recorded here when
 *     explicitly enabled; the provider passes per-turn
 *     enabledMcpjsonServers / disabledMcpjsonServers accordingly.
 *   - builtin: the in-process "mcode-browser" server injected by the Claude
 *     provider each turn; toggling gates that injection. */

/** Setting key for the persisted MCP management state.
 *  Value = JSON.stringify(McpManagementState). */
export const MCP_MANAGEMENT_SETTING_KEY = "mcp.management";

/** Serializable MCP server config shapes, mirroring the Claude Agent SDK's
 *  McpStdioServerConfig / McpHttpServerConfig / McpSSEServerConfig. Transport
 *  fields only; exotic fields (timeout, tools, ...) survive import round-trips
 *  via passthrough. Absent `type` means stdio, same as the SDK. */
export const McpServerConfigSchema = z.union([
  z
    .object({
      type: z.literal("stdio").optional(),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("http"),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("sse"),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** Persisted MCP management state (MCP_MANAGEMENT_SETTING_KEY). */
export interface McpManagementState {
  /** Built-in mcode-browser server disabled. Absent/false = enabled. */
  browserDisabled?: boolean;
  /** User-scope servers the user turned OFF. Their full configs are stashed
   *  here (keyed by name) so re-enabling restores them exactly; the config
   *  file meanwhile stays free of them, which is what keeps the binary from
   *  loading them. */
  userDisabled?: Record<string, McpServerConfig>;
  /** Project .mcp.json servers the user explicitly turned ON. Project servers
   *  default to OFF (this panel replaces the CLI's first-use approval dialog),
   *  so an allowlist — not a denylist — is persisted. Matched against the
   *  turn's cwd at startTurn. */
  projectEnabled?: Array<{ projectPath: string; name: string }>;
}

/** Which source a listed MCP server comes from. */
export type McpScope = "user" | "project" | "builtin";

/** Transport kind shown in the panel badges; "builtin" = in-process server. */
export type McpKind = "stdio" | "http" | "sse" | "builtin";

/** One row of the MCP panel's server list. `detail` is a secret-free summary
 *  ("node server.js --foo" / "https://example.com/mcp") — env and header
 *  values are never included. */
export interface McpServerEntry {
  name: string;
  scope: McpScope;
  kind: McpKind;
  detail: string;
  enabled: boolean;
}

/** List MCP servers for the settings panel. `projectPath` scopes the project
 *  .mcp.json group and must match a persisted Project.path when present; the
 *  group is simply omitted when absent. */
export const McpListSchema = z.object({
  projectPath: z.string().optional(),
});
export type McpListInput = z.infer<typeof McpListSchema>;

/** Toggle a server. `projectPath` is required for scope "project". */
export const McpToggleSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["user", "project", "builtin"]),
  projectPath: z.string().optional(),
  enabled: z.boolean(),
});
export type McpToggleInput = z.infer<typeof McpToggleSchema>;

/** MCP server name charset — same family as skill names (letters, digits,
 *  underscore, hyphen). The name becomes a JSON object key, not a path, but
 *  staying conservative costs nothing. */
const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Reserved server name — collides with the built-in in-process server. */
export const MCP_RESERVED_NAME = "mcode-browser";

/** Add a user-scope server. Rejected when the name already exists (enabled in
 *  the config file or stashed as disabled). The config is written into
 *  ~/.mcode/.claude.json. */
export const McpSaveSchema = z.object({
  name: z.string().regex(MCP_NAME_RE, "invalid MCP server name"),
  config: McpServerConfigSchema,
});
export type McpSaveInput = z.infer<typeof McpSaveSchema>;

/** Remove a user-scope server — from both the config file and the disabled
 *  stash (whichever holds it). Project/builtin entries have no delete. */
export const McpRemoveSchema = z.object({
  name: z.string().regex(MCP_NAME_RE, "invalid MCP server name"),
});
export type McpRemoveInput = z.infer<typeof McpRemoveSchema>;

/** A server discovered in the local Claude CLI config (~/.claude.json),
 *  offered by the import dialog. `origin` labels where it came from: the
 *  global scope or the project path it was configured for. */
export interface McpImportSource {
  name: string;
  kind: McpKind;
  detail: string;
  origin: string;
  config: McpServerConfig;
}

/** Scan the local Claude CLI config for importable MCP servers. Read-only;
 *  never writes to ~/.claude.json. */
export const McpScanImportSchema = z.object({});
export type McpScanImportInput = z.infer<typeof McpScanImportSchema>;

/** A single server to import (name + full config, from a scanImport result). */
export const McpImportItemSchema = z.object({
  name: z.string().min(1),
  config: McpServerConfigSchema,
});

/** Import selected servers into the user scope (Mcode's own config file).
 *  Already-existing names are skipped. Returns per-server lists. */
export const McpImportSchema = z.object({
  servers: z.array(McpImportItemSchema),
});
export type McpImportInput = z.infer<typeof McpImportSchema>;

/* ── Usage stats (settings panel) ──
 *  Aggregates the per-turn usage history persisted on each session row
 *  (`sessions.usage_history`, one TurnUsageRecord per completed turn) into
 *  daily / per-model / summary views. Read-only. */

/** Time ranges offered by the usage panel. `today` starts at local midnight;
 *  `7d` / `30d` span N-1 midnights back from today (today inclusive);
 *  `all` covers everything. */
export const USAGE_STATS_PRESETS = ["today", "7d", "30d", "all"] as const;
export type UsageStatsPreset = (typeof USAGE_STATS_PRESETS)[number];

export const UsageStatsSchema = z.object({
  preset: z.enum(USAGE_STATS_PRESETS),
});
export type UsageStatsInput = z.infer<typeof UsageStatsSchema>;

/** Per-day aggregate. `date` is the LOCAL calendar day as YYYY-MM-DD —
 *  "today" must mean the user's today, not UTC's. */
export interface UsageDayStat {
  date: string;
  turns: number;
  totalTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Per-model aggregate over the selected range, keyed by (vendor, model):
 *  the same model name from different vendors (e.g. "deepseek-v4-flash" via
 *  the official API vs a gateway) must not be lumped together.
 *  `model: null` groups turns whose record carried no model id. */
export interface UsageModelStat {
  /** Vendor/endpoint label the turns ran under: "Anthropic" for the built-in
   *  Claude path, the custom-model config's user-chosen name for a gateway
   *  endpoint, "Pi" for Pi-agent sessions. null = unknown (e.g. the binding
   *  config was deleted). */
  vendor: string | null;
  model: string | null;
  turns: number;
  totalTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** Range totals over the selected range. */
export interface UsageSummaryStat {
  turns: number;
  /** Distinct sessions that contributed at least one turn in the range. */
  sessions: number;
  totalTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** `usage.stats` response. `summary` / `models` aggregate the selected range;
 *  `daily` always covers the last 183 days (26 weeks, today inclusive) so the
 *  heatmap can render a fixed half-year grid regardless of the preset. */
export interface UsageStatsResult {
  summary: UsageSummaryStat;
  models: UsageModelStat[];
  daily: UsageDayStat[];
}

/* ──────────────────────────  Main → Renderer (events)  ─────────────────────── */

/* ── Language servers (LSP) ──
 *  Each language has an installable, toggleable language server (TS/JS,
 *  Python, Go, Java). Servers run in the main process as stdio JSON-RPC
 *  children; the renderer talks to them via the `lsp.*` RPC namespace and
 *  receives diagnostics/logs/state changes over the `lsp:event` push channel.
 *  Monaco providers (definition/references/hover) in the renderer call
 *  `lsp.request` to forward LSP method calls; document sync goes through
 *  `lsp.openDocument` / `lsp.didChange` / `lsp.didSave` / `lsp.closeDocument`. */

/** Setting key for the persisted LSP server config list.
 *  Value = JSON.stringify(LspServerConfig[]). */
export const LSP_SERVERS_SETTING_KEY = "lsp.servers";

/** Languages with first-class LSP support. The enum is reused across every
 *  LSP schema so the renderer, preload, and main share one vocabulary. */
export const LspLanguageSchema = z.enum(["typescript", "python", "go", "java"]);
export type LspLanguageId = z.infer<typeof LspLanguageSchema>;

/** A single language's persisted configuration. Stored as a JSON array under
 *  LSP_SERVERS_SETTING_KEY. Missing entries default to { enabled: false }. */
export interface LspServerConfig {
  language: LspLanguageId;
  enabled: boolean;
  /** User override for the server executable. Empty/absent -> auto-detect via
   *  PATH lookup (which/where). */
  serverPath?: string;
  /** Extra CLI args appended after the server's stdio flag. Advanced. */
  args?: string[];
  /** Java only: path to a JDK 17+ home (JAVA_HOME) used to RUN jdtls. This is
   *  independent of the project's JDK -- jdtls needs Java 17+ to run even when
   *  the project itself targets Java 8. Empty/absent -> use system java. */
  javaHome?: string;
}

/** Generic success/failure result for install/stop/health operations. */
export interface LspOpResult {
  ok: boolean;
  error?: string;
}

/** Snapshot of one language's state, sent to the renderer by `lsp.list`. The
 *  renderer treats this as read-only display data. */
export interface LspLanguageState {
  language: LspLanguageId;
  enabled: boolean;
  /** Whether the server binary was found on disk (PATH or custom path). */
  installed: boolean;
  /** Resolved server path (or null if not found). */
  serverPath: string | null;
  /** Whether a server process is currently alive for this language (any
   *  workspace). */
  running: boolean;
  /** Whether an install/uninstall is currently in progress. */
  installing: boolean;
  /** Tail of the most recent install/uninstall output (truncated). */
  installLog: string;
  /** Last error from a failed server start (stderr summary). Empty when the
   *  server is running fine. Shown in the settings panel so the user knows
   *  WHY the server won't start (e.g. "jdtls requires at least Java 21"). */
  lastError: string;
}

/** `lsp:event` stateChanged payload: the language-server lifecycle for one
 *  (workspacePath, language). Emitted at every phase transition so the
 *  renderer can show startup progress in the editor toolbar. `stopped` after
 *  a failed start carries the reason in `error`. */
export interface LspStateChangedPayload {
  /** "starting" = spawned, initialize handshake in flight (can take minutes
   *  for Java); "running" = initialize done; "stopped" = exited/failed. */
  phase: "starting" | "running" | "stopped";
  /** Boolean view of the phase (running === phase === "running"), kept for
   *  consumers that only care whether the server is usable. */
  running: boolean;
  /** Failure reason when the server couldn't start (phase "stopped"). */
  error?: string;
}

/** A diagnostic pushed from the server via publishDiagnostics. Mirrors LSP
 *  Diagnostic (0-based line/character). */
export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** 1=Error, 2=Warning, 3=Information, 4=Hint. */
  severity: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
}

// -- RPC input schemas --

export const LspListSchema = z.object({});
export type LspListInput = z.infer<typeof LspListSchema>;

export const LspInstallSchema = z.object({ language: LspLanguageSchema });
export type LspInstallInput = z.infer<typeof LspInstallSchema>;

/** Install from a user-downloaded archive (tar.gz/zip) or binary. Used when
 *  the package-manager install fails due to network issues -- the user
 *  downloads the file manually via the download-page button, then selects it
 *  here. For Java the archive is extracted into userData/lsp/java; for other
 *  languages the file/binary path is recorded as a custom serverPath. */
export const LspInstallFromFileSchema = z.object({
  language: LspLanguageSchema,
  /** Absolute path to the user-selected file (archive or binary). */
  archivePath: z.string().min(1),
});
export type LspInstallFromFileInput = z.infer<typeof LspInstallFromFileSchema>;

export const LspUninstallSchema = z.object({ language: LspLanguageSchema });
export type LspUninstallInput = z.infer<typeof LspUninstallSchema>;

export const LspToggleSchema = z.object({
  language: LspLanguageSchema,
  enabled: z.boolean(),
});
export type LspToggleInput = z.infer<typeof LspToggleSchema>;

export const LspSetPathSchema = z.object({
  language: LspLanguageSchema,
  serverPath: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** Java only: override the JDK used to run jdtls (JAVA_HOME). */
  javaHome: z.string().optional(),
});
export type LspSetPathInput = z.infer<typeof LspSetPathSchema>;

export const LspHealthCheckSchema = z.object({ language: LspLanguageSchema });
export type LspHealthCheckInput = z.infer<typeof LspHealthCheckSchema>;

/** Restart a language server for one workspace. Unlike a toggle-off/on this
 *  immediately relaunches (with the crash-loop guard cleared) so the editor's
 *  startup pill visibly goes starting → running/stopped. */
export const LspRestartSchema = z.object({
  /** Project root the server was started for (must be a known project). */
  workspacePath: z.string(),
  language: LspLanguageSchema,
});
export type LspRestartInput = z.infer<typeof LspRestartSchema>;

export const LspOpenDocSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  language: LspLanguageSchema,
});
export type LspOpenDocInput = z.infer<typeof LspOpenDocSchema>;

export const LspCloseDocSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
});
export type LspCloseDocInput = z.infer<typeof LspCloseDocSchema>;

export const LspDidChangeSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  text: z.string(),
  version: z.number().int(),
});
export type LspDidChangeInput = z.infer<typeof LspDidChangeSchema>;

export const LspDidSaveSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  text: z.string(),
});
export type LspDidSaveInput = z.infer<typeof LspDidSaveSchema>;

export const LspRequestSchema = z.object({
  workspacePath: z.string(),
  language: LspLanguageSchema,
  /** LSP method, e.g. "textDocument/definition". */
  method: z.string(),
  /** LSP params object (passed through verbatim). */
  params: z.unknown(),
});
export type LspRequestInput = z.infer<typeof LspRequestSchema>;

/** `lsp.request` returns either the LSP result or an error object. */
export type LspRequestResult =
  | { result: unknown }
  | { error: { code: number; message: string } };

export interface ClaudeEventMessage {
  channel: "claude:event";
  sessionId: string;
  event: RuntimeEvent;
}

/**
 * Pushed from main to renderer when an auto-generated session title has been
 * written to the DB by the background title-gen routine. The renderer patches
 * its in-memory session lists so the sidebar / tabs reflect the new title
 * without a full reload. Mirrors the rename flow but is main-initiated.
 */
export interface SessionTitleUpdatedMessage {
  channel: "session:titleUpdated";
  sessionId: string;
  title: string;
}

export interface TerminalDataMessage {
  channel: "terminal:data";
  terminalId: string;
  data: string;
}

/** Fired when a PTY process exits (user typed `exit`, shell crashed, or kill). */
export interface TerminalExitMessage {
  channel: "terminal:exit";
  terminalId: string;
  /** Process exit code, or null if killed by signal / unknown. */
  exitCode: number | null;
}

/** Pushed from main -> renderer for LSP diagnostics, server logs, and running
 *  state changes. The `payload` shape depends on `type`:
 *  - "diagnostics":  { uri: string; diagnostics: LspDiagnostic[] }
 *  - "log":          { level: "info" | "warn" | "error"; message: string }
 *  - "stateChanged": { running: boolean }
 *  Kept as `unknown` here so the contract stays decoupled from the renderer's
 *  narrowing logic. */
export interface LspEventMessage {
  channel: "lsp:event";
  workspacePath: string;
  language: LspLanguageId;
  /** Type-specific shape: diagnostics → LspDiagnostic[], log →
   *  { level, message }, stateChanged → LspStateChangedPayload. */
  type: "diagnostics" | "log" | "stateChanged";
  payload: unknown;
}

/** A DOM element picked by the user from the embedded browser. This is the
 *  payload produced by the picker script injected into a page's main world,
 *  forwarded to the renderer where it becomes a `ContentTag` (kind="element")
 *  in the composer. */
export interface PickedElement {
  /** CSS selector path generated by the picker (id > class chain > nth-child). */
  selector: string;
  /** The element's outerHTML, truncated to a sane cap (≤ 2000 chars) so a huge
   *  subtree can't blow up the prompt. */
  outerHTML: string;
  /** The page URL the element was picked from. */
  url: string;
  /** Short single-line preview for the composer chip (e.g. `button.btn`). */
  preview: string;
}

/** Pushed from main -> renderer for the embedded browser panel. The payload
 *  shape depends on `type`:
 *  - "navigation": the active page changed (URL/title/back/forward state).
 *  - "loading":    the page started or stopped loading.
 *  - "pickResult": the user clicked an element in pick mode.
 *  - "crashed":    the renderer process died; the view needs recreating.
 *  - "agentOpened": an agent tool created/reused a browser view; the renderer
 *    should switch the right panel to the browser tab so the view is visible.
 *  - "authRequest": a page asked for HTTP Basic Auth and no saved credential
 *    matched; the payload is a BrowserAuthRequest and the renderer should show
 *    a login dialog, then answer via the browser.authRespond RPC. */
export interface BrowserEventMessage {
  channel: "browser:event";
  browserId: string;
  type:
    | "navigation"
    | "loading"
    | "pickResult"
    | "crashed"
    | "agentOpened"
    | "authRequest";
  payload: unknown;
}

/** Payload of the "authRequest" browser push event. The requestId maps 1:1 to
 *  a pending Electron login callback held in main; answering (or cancelling)
 *  with browser.authRespond resolves it. */
export interface BrowserAuthRequest {
  requestId: string;
  /** Origin the credentials will be sent to (scheme://host[:port]). */
  origin: string;
  /** Host name only, for the dialog title. */
  host: string;
}

/**
 * Pushed from main -> renderer whenever the main window gains or loses focus.
 * The renderer uses this as the basis for notification decisions: when the
 * window is unfocused (minimized or another app is frontmost), background
 * session events warrant a stronger notification (OS notification); when
 * focused, only in-app toasts / badges are needed.
 */
export interface WindowFocusChangedMessage {
  channel: "window:focusChanged";
  /** True when the main window is focused (frontmost + not minimized). */
  focused: boolean;
}

/**
 * Pushed from main -> renderer when the user clicks an OS notification. The
 * main process has already shown + focused the window; this event tells the
 * renderer which session to navigate to (selectSession / openTab) so the user
 * lands directly on the thread that generated the notification.
 */
export interface NotificationFocusSessionMessage {
  channel: "notification:focusSession";
  sessionId: string;
}

/** Pushed from main → renderer on relay state changes (connecting, deployed,
 *  connected, error, disconnected). The renderer uses these to update the
 *  remote-access panel without polling. */
export interface RelayEventMessage {
  channel: "relay:event";
  status: RelayStatus;
}

/** Pushed from main → renderer with live ASR results for a voice-input
 *  session. `partial` = interim streaming text (may still change), `final` =
 *  a committed segment for the session. The renderer matches results to its
 *  composer via `sessionId` (the per-listen token it chose at voice.start). */
export interface VoiceResultMessage {
  channel: "voice:result";
  sessionId: string;
  kind: "partial" | "final";
  text: string;
}

/** Pushed from main → renderer while a voice model downloads. The settings
 *  panel renders a progress bar from this; `stage: "done"` means the model is
 *  ready to select. */
export interface VoiceDownloadProgressMessage {
  channel: "voice:downloadProgress";
  modelId: string;
  stage: "downloading" | "done" | "error" | "cancelled";
  percent: number;
  fileIndex: number;
  fileCount: number;
  fileBytes: number;
  error?: string;
}

export type MainToRendererMessage =
  | ClaudeEventMessage
  | SessionTitleUpdatedMessage
  | TerminalDataMessage
  | TerminalExitMessage
  | LspEventMessage
  | BrowserEventMessage
  | ThemeChangedMessage
  | UpdateAvailableMessage
  | UpdateDownloadProgressMessage
  | UpdateDownloadedMessage
  | WindowFocusChangedMessage
  | NotificationFocusSessionMessage
  | RelayEventMessage
  | VoiceResultMessage
  | VoiceDownloadProgressMessage;

/* ── Integrated terminal (xterm.js + node-pty) ──
 *  PTY processes live in main. Renderer only sees opaque terminalIds and
 *  streams data over push channels. Every create is scoped to a known
 *  project root (cwd must resolve inside that root). */

/** Setting key for the user-preferred shell executable (absolute path or
 *  bare command name). Empty/absent → platform smart default. */
export const TERMINAL_SHELL_SETTING_KEY = "terminal.shell";

/** Setting key for the directory where agent browser screenshots are saved.
 *  Empty/absent → the system Pictures directory. Screenshots are organized as
 *  `<dir>/<sessionId>/turn-<N>/<timestamp>-<toolCallId>.png`. */
export const BROWSER_SCREENSHOT_DIR_SETTING_KEY = "browser.screenshotDir";

/** Setting key for the directory where the embedded browser's session data is
 *  stored (cookies, form/autofill data, localStorage, IndexedDB, etc.). The
 *  browser views run on a dedicated persistent partition
 *  ("persist:mcode-browser"); when this is set, the partition is pointed at
 *  that directory via session.fromPartition's `path` option. Empty/absent →
 *  Electron's default partition location under userData. NOTE: Electron caches
 *  Session objects by partition string, so changing this only takes effect
 *  after an app restart. */
export const BROWSER_DATA_DIR_SETTING_KEY = "browser.dataDir";

/** Setting key for the address-bar history (JSON array of
 *  `BrowserHistoryEntry`, most-recent first, capped at 50). Written only by
 *  the main process (BrowserManager on did-navigate); the renderer reads it
 *  via setting.get and removes entries via the browser.historyRemove /
 *  browser.historyClear RPCs. */
export const BROWSER_ADDRESS_HISTORY_SETTING_KEY = "browser.addressHistory";

/** One address-bar history entry. */
export interface BrowserHistoryEntry {
  url: string;
  /** Page title at the time of navigation (may be empty for redirects). */
  title: string;
  /** Epoch ms of the last visit. */
  at: number;
}

/** Setting key for the encrypted browser credential vault (JSON
 *  `{ [origin]: { username, passwordEnc } }`). Passwords are encrypted with
 *  Electron safeStorage via the shared secretStore helpers; only the main
 *  process ever sees plaintext. */
export const BROWSER_CREDENTIALS_SETTING_KEY = "browser.credentials";

/** Snapshot of a live (or just-exited) terminal session. */
export interface TerminalInfo {
  terminalId: string;
  /** Absolute cwd the PTY was spawned with. */
  cwd: string;
  /** Resolved shell executable path/name. */
  shell: string;
  /** OS process id while alive; 0 after exit. */
  pid: number;
  /** Project root this terminal is bound to. */
  projectPath: string;
}

/** Create a new PTY bound to a project. `cwd` defaults to `projectPath`. */
export const TerminalCreateSchema = z.object({
  projectPath: z.string().min(1),
  /** Optional working directory; must resolve inside projectPath. */
  cwd: z.string().min(1).optional(),
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
  /** Optional shell override for this session only. */
  shell: z.string().min(1).optional(),
});
export type TerminalCreateInput = z.infer<typeof TerminalCreateSchema>;

export const TerminalWriteSchema = z.object({
  terminalId: z.string().min(1),
  data: z.string(),
});
export type TerminalWriteInput = z.infer<typeof TerminalWriteSchema>;

export const TerminalResizeSchema = z.object({
  terminalId: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type TerminalResizeInput = z.infer<typeof TerminalResizeSchema>;

export const TerminalKillSchema = z.object({
  terminalId: z.string().min(1),
});
export type TerminalKillInput = z.infer<typeof TerminalKillSchema>;

export const TerminalListSchema = z.object({
  /** When set, only terminals bound to this project root are returned. */
  projectPath: z.string().min(1).optional(),
});
export type TerminalListInput = z.infer<typeof TerminalListSchema>;

/** Structured result for create — either success fields or ok:false + error. */
export type TerminalCreateResult =
  | {
      ok: true;
      terminalId: string;
      pid: number;
      cwd: string;
      shell: string;
    }
  | { ok: false; error: string };

export interface TerminalOpResult {
  ok: boolean;
  error?: string;
}

/* ── Embedded browser (WebContentsView + DOM element picker) ──
 *  The browser view lives in main (an OS-level WebContentsView overlaid on the
 *  main window). Renderer only sees an opaque browserId and drives it via RPC.
 *  The picker script is injected into the page's main world via executeJavaScript;
 *  picked elements come back as a push event (browser:event / pickResult). */

/** A pixel rect in window coordinates, used to position the WebContentsView
 *  over the renderer's browser-panel placeholder. Measured by the renderer via
 *  getBoundingClientRect() and forwarded on resize. */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const BrowserCreateSchema = z.object({
  projectPath: z.string().min(1),
  /** Optional initial device-emulation preset applied once the view's renderer
   *  is ready (dom-ready). Used by the sidebar container to start in mobile
   *  mode without calling setDevice too early (which can crash the GPU
   *  process before it's initialized). Omit = desktop (no emulation). */
  initialDevice: z
    .enum([
      "desktop",
      "iphone",
      "iphone-se",
      "android",
      "galaxy-s23",
      "ipad-mini",
      "pc",
      "custom",
    ])
    .optional(),
});
export type BrowserCreateInput = z.infer<typeof BrowserCreateSchema>;

export const BrowserLoadUrlSchema = z.object({
  browserId: z.string().min(1),
  url: z.string().min(1),
});
export type BrowserLoadUrlInput = z.infer<typeof BrowserLoadUrlSchema>;

export const BrowserGoBackSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserGoBackInput = z.infer<typeof BrowserGoBackSchema>;

export const BrowserGoForwardSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserGoForwardInput = z.infer<typeof BrowserGoForwardSchema>;

export const BrowserReloadSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserReloadInput = z.infer<typeof BrowserReloadSchema>;

export const BrowserSetBoundsSchema = z.object({
  browserId: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});
export type BrowserSetBoundsInput = z.infer<typeof BrowserSetBoundsSchema>;

export const BrowserSetPickModeSchema = z.object({
  browserId: z.string().min(1),
  enabled: z.boolean(),
});
export type BrowserSetPickModeInput = z.infer<typeof BrowserSetPickModeSchema>;

export const BrowserShowSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserShowInput = z.infer<typeof BrowserShowSchema>;

export const BrowserHideSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserHideInput = z.infer<typeof BrowserHideSchema>;

export const BrowserCloseSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserCloseInput = z.infer<typeof BrowserCloseSchema>;

/** Device presets for the browser panel's H5/mobile emulation. "desktop" is
 *  the default (no emulation); the mobile presets set a viewport width/height
 *  + deviceScaleFactor + mobile screenPosition via enableDeviceEmulation.
 *  "pc" is a large desktop-sized viewport (1920×1080) used in the sidebar with
 *  a scroll container (page renders at true PC size; scrolling pans the view).
 *  "custom" uses the width/height passed at set-device time instead of a fixed
 *  preset. */
export type BrowserDevicePreset =
  | "desktop"
  | "iphone"
  | "iphone-se"
  | "android"
  | "galaxy-s23"
  | "ipad-mini"
  | "pc"
  | "custom";

/** Screen orientation for device emulation. "landscape" swaps the preset's
 *  width/height before applying emulation (e.g. 390×844 → 844×390). */
export type BrowserOrientation = "portrait" | "landscape";

/** One entry in the shared device preset catalog. `width`/`height` are the
 *  portrait-orientation logical (CSS) viewport dims; `scale` is the
 *  deviceScaleFactor passed to enableDeviceEmulation. Kept in contracts so
 *  main (BrowserManager.setDevice) and renderer (BrowserPanel bounds sync +
 *  BrowserToolbar labels) read the same numbers. */
export interface BrowserDeviceSpec {
  id: BrowserDevicePreset;
  label: string;
  width: number;
  height: number;
  scale: number;
}

/** Shared preset catalog — single source of truth for the device selector.
 *  "custom" is a menu entry (no fixed dims; width/height come from the input
 *  fields at set time).
 *
 *  Note: "desktop" (no-emulation, fill-the-panel) is still a valid
 *  BrowserDevicePreset — it's the default device and the sentinel used when
 *  collapsing the toolbar disables emulation. But it is intentionally NOT
 *  listed here: it isn't a selectable menu entry, only the renamed
 *  "桌面端" (= the former "PC 1920×1080", fixed emulation) is. */
export const BROWSER_DEVICE_PRESETS: BrowserDeviceSpec[] = [
  { id: "pc", label: "桌面端", width: 1920, height: 1080, scale: 1 },
  { id: "iphone", label: "iPhone 14", width: 390, height: 844, scale: 3 },
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667, scale: 2 },
  { id: "android", label: "Pixel 7", width: 412, height: 915, scale: 2.625 },
  { id: "galaxy-s23", label: "Galaxy S23", width: 360, height: 740, scale: 3 },
  { id: "ipad-mini", label: "iPad mini", width: 768, height: 1024, scale: 2 },
  { id: "custom", label: "自定义", width: 0, height: 0, scale: 3 },
];

/** Resolve a preset's portrait dims/scale, falling back to the given custom
 *  width/height (or the default preset) when the id is unknown. */
export function resolveBrowserDeviceSpec(
  device: BrowserDevicePreset,
  custom?: { width?: number; height?: number },
): BrowserDeviceSpec {
  const found = BROWSER_DEVICE_PRESETS.find((p) => p.id === device);
  if (device === "custom") {
    return {
      id: "custom",
      label: found?.label ?? "自定义",
      width: custom?.width ?? 390,
      height: custom?.height ?? 844,
      scale: found?.scale ?? 3,
    };
  }
  return (
    found ?? { id: "desktop", label: "桌面端", width: 0, height: 0, scale: 1 }
  );
}

export const BrowserSetDeviceSchema = z.object({
  browserId: z.string().min(1),
  device: z.enum([
    "desktop",
    "iphone",
    "iphone-se",
    "android",
    "galaxy-s23",
    "ipad-mini",
    "pc",
    "custom",
  ]),
  /** Custom viewport width (required when device === "custom"). */
  width: z.number().int().min(1).optional(),
  /** Custom viewport height (required when device === "custom"). */
  height: z.number().int().min(1).optional(),
  /** Screen orientation; "landscape" swaps width/height. Defaults to
   *  "portrait" when omitted (backward compatible with old callers). */
  orientation: z.enum(["portrait", "landscape"]).optional(),
  /** Effective emulated viewport size (CSS px) to apply. When set, overrides
   *  the preset/custom dims — used by the renderer to match the view's
   *  physical bounds exactly (e.g. a narrow sidebar column), which keeps
   *  capturePage() from returning black frames and pages from being clipped.
   *  Omit to use the preset/custom dims. */
  viewportWidth: z.number().int().min(1).optional(),
  viewportHeight: z.number().int().min(1).optional(),
});
export type BrowserSetDeviceInput = z.infer<typeof BrowserSetDeviceSchema>;

/** Current viewport configuration for a browser view (mirrors what was last
 *  passed to browser.setDevice). Custom dims are present only for "custom";
 *  orientation defaults to "portrait" when the field is absent. effWidth/
 *  effHeight are the EFFECTIVE emulated viewport size (CSS px) actually
 *  applied — equals the preset/custom dims (post-orientation) unless the
 *  renderer overrode them to match the view's physical bounds. */
export interface BrowserViewport {
  device: BrowserDevicePreset;
  width?: number;
  height?: number;
  orientation: BrowserOrientation;
  effWidth?: number;
  effHeight?: number;
}

/** Structured result for browser.create - either success with the id, or
 *  ok:false + error. */
export type BrowserCreateResult =
  | { ok: true; browserId: string }
  | { ok: false; error: string };

/** Generic ok/error result for browser navigation / view ops. */
export interface BrowserOpResult {
  ok: boolean;
  error?: string;
}

/* ── Address history + credential vault ──
 *  History is written by main only (on did-navigate); these RPCs let the
 *  renderer remove entries without racing main's writes. Credentials are
 *  encrypted at rest (safeStorage) and never leave main in plaintext. */

export const BrowserHistoryRemoveSchema = z.object({
  url: z.string().min(1),
});
export type BrowserHistoryRemoveInput = z.infer<typeof BrowserHistoryRemoveSchema>;

export const BrowserHistoryClearSchema = z.object({});
export type BrowserHistoryClearInput = z.infer<typeof BrowserHistoryClearSchema>;

/** A saved credential as exposed to the renderer — the password is
 *  intentionally NOT included. */
export interface BrowserCredentialPublic {
  /** Origin the credential belongs to (scheme://host[:port]). */
  origin: string;
  username: string;
}

export const BrowserCredentialsListSchema = z.object({});
export type BrowserCredentialsListInput = z.infer<typeof BrowserCredentialsListSchema>;

export const BrowserCredentialsSaveSchema = z.object({
  origin: z.string().min(1),
  username: z.string().min(1),
  password: z.string(),
});
export type BrowserCredentialsSaveInput = z.infer<typeof BrowserCredentialsSaveSchema>;

export const BrowserCredentialsRemoveSchema = z.object({
  origin: z.string().min(1),
});
export type BrowserCredentialsRemoveInput = z.infer<typeof BrowserCredentialsRemoveSchema>;

/** Fill the saved credential for the view's current origin into the page's
 *  login form (heuristic: first password input + nearest preceding text
 *  input). The password stays in main; only the injected fill script sees it. */
export const BrowserCredentialsFillSchema = z.object({
  browserId: z.string().min(1),
  /** When omitted, the credential for the page's current origin is used. */
  origin: z.string().min(1).optional(),
});
export type BrowserCredentialsFillInput = z.infer<typeof BrowserCredentialsFillSchema>;

export interface BrowserCredentialsFillResult {
  ok: boolean;
  error?: string;
}

/** Renderer's answer to an "authRequest" push event. */
export const BrowserAuthRespondSchema = z.object({
  requestId: z.string().min(1),
  /** Empty username+password cancels the auth prompt. */
  username: z.string(),
  password: z.string(),
  /** Persist the credential (encrypted) for this origin when true. */
  save: z.boolean().optional(),
});
export type BrowserAuthRespondInput = z.infer<typeof BrowserAuthRespondSchema>;

/* ──────────────────────────  RPC method map  ───────────────────────────────── */

/** Revoke a paired mobile device. Input to `mobile.revokeDevice`. */
export const RevokeMobileDeviceSchema = z.object({ deviceId: z.string().min(1) });

/** A typed map of all renderer→main RPC invocations. The preload exposes a
 * typed `window.api` matching this shape; the renderer imports it for safety. */
export interface RpcMap {
  // Claude
  "claude.startSession": (input: StartSessionInput) => Promise<{ session: Session }>;
  /** Returns the (possibly retitled) session so the renderer can refresh. */
  "claude.sendTurn": (input: SendTurnInput) => Promise<{ session: Session }>;
  "claude.interrupt": (input: InterruptInput) => Promise<void>;
  "claude.approve": (input: ApproveInput) => Promise<void>;
  /** Submit the user's answers to a pending AskUserQuestion. */
  "claude.respondQuestion": (input: RespondQuestionInput) => Promise<void>;
  /** Submit the user's approve/reject decision on a pending ExitPlanMode plan. */
  "claude.respondPlanApproval": (input: RespondPlanApprovalInput) => Promise<void>;
  /** Rewind a turn: restore the given files to their pre-turn state.
   *  Works for the latest turn, any historical turn, or a session
   *  reopened after restart (the renderer passes the explicit entries).
   *  Returns the list of paths that were actually restored (failed
   *  paths are silently logged in main). */
  "claude.rewindTurn": (input: RewindTurnInput) => Promise<{ restored: string[] }>;
  /** Update the active session's model / effort / permissionMode / customModelId in-place. */
  "session.updateSettings": (input: UpdateSessionSettingsInput) => Promise<void>;
  // Projects
  "project.create": (input: CreateProjectInput) => Promise<{ project: Project }>;
  "project.list": () => Promise<{ projects: Project[] }>;
  "project.sessions": (input: ProjectSessionsInput) => Promise<{ sessions: Session[]; hasMore: boolean; total: number }>;
  /** Hard-delete a project; its sessions + messages cascade-delete (DB FK). */
  "project.delete": (input: { id: string }) => Promise<void>;
  /** Set a project's archived flag (soft-delete; restorable). */
  "project.archive": (input: { id: string; archived: boolean }) => Promise<{ project: Project }>;
  /** Assign a project to a group (left-bar "grouped" view); null removes it. */
  "project.setGroup": (input: SetProjectGroupInput) => Promise<{ project: Project }>;
  /** Persist a drag-to-reorder: writes sort_order = index for each id. */
  "project.reorder": (input: ReorderProjectsInput) => Promise<void>;
  // Sessions (P2 persistence)
  /** Cross-project session search by title substring (Ctrl+K unified search). */
  "session.search": (input: SessionSearchInput) => Promise<{ sessions: Session[] }>;
  /** All pinned non-archived sessions across projects (most recent pin
   *  first) — powers the left bar's global pinned section above the project
   *  tree. */
  "session.listPinned": () => Promise<{ sessions: Session[] }>;
  "session.messages": (
    input: SessionMessagesInput,
  ) => Promise<{ messages: MessageRecord[]; hasMore: boolean }>;
  "session.saveMessages": (input: SaveMessagesInput) => Promise<void>;
  "session.upsertMessages": (input: UpsertMessagesInput) => Promise<void>;
  "session.truncateAndInsertMessages": (
    input: TruncateAndInsertMessagesInput,
  ) => Promise<void>;
  /** Hard-delete a session; its messages cascade-delete (DB FK). */
  "session.delete": (input: { id: string }) => Promise<void>;
  /** Set a session's archived flag (soft-delete; restorable). */
  "session.archive": (input: { id: string; archived: boolean }) => Promise<{ session: Session }>;
  /** Rename a session (persist a user-edited title). Returns the updated row. */
  "session.rename": (input: RenameSessionInput) => Promise<{ session: Session }>;
  /** Pin/unpin a session (project-scoped). Returns the updated row. */
  "session.pin": (input: PinSessionInput) => Promise<{ session: Session }>;
  // Providers
  "provider.list": () => Promise<{ providers: ProviderInfo[] }>;
  // Settings
  "setting.get": (input: GetSettingInput) => Promise<{ value: string | null }>;
  "setting.set": (input: SetSettingInput) => Promise<void>;
  "setting.getMany": (input: GetManySettingsInput) => Promise<GetManySettingsResult>;
  // Voice input
  "voice.start": (input: VoiceStartInput) => Promise<void>;
  "voice.feed": (input: VoiceFeedInput) => Promise<void>;
  "voice.stop": (input: VoiceStopInput) => Promise<VoiceStopResult>;
  "voice.cancel": (input: VoiceCancelInput) => Promise<void>;
  /** List the model catalog + downloaded models + active selection. */
  "voice.modelList": () => Promise<VoiceModelListResult>;
  /** Begin downloading a catalog model. Returns immediately; progress arrives
   *  on the `voice:downloadProgress` push. */
  "voice.downloadModel": (input: VoiceDownloadModelInput) => Promise<void>;
  /** Cancel an in-flight model download (no-op if none). */
  "voice.cancelModelDownload": (input: VoiceDownloadModelInput) => Promise<void>;
  /** Persist the active voice model selection for the composer mic button. */
  "voice.selectModel": (input: VoiceDownloadModelInput) => Promise<void>;
  /** Delete a downloaded model's local files (the active selection is
   *  re-pointed at another downloaded model, or cleared). */
  "voice.removeModel": (input: VoiceDownloadModelInput) => Promise<void>;
  /** Read the current effective voice model root (custom or default). */
  "voice.getModelDir": (input: GetVoiceModelDirInput) => Promise<GetVoiceModelDirResult>;
  /** Change the voice model root directory. Empty string = default. The new
   *  path is scanned; already-present catalog models appear as "downloaded"
   *  in the returned list, no re-download required. */
  "voice.setModelDir": (input: SetVoiceModelDirInput) => Promise<SetVoiceModelDirResult>;
  // Notifications
  /** Get the user's notification preferences (typed wrapper over settings). */
  "notification.getPrefs": () => Promise<{ prefs: NotificationPrefs }>;
  /** Set (persist) the user's notification preferences. */
  "notification.setPrefs": (input: SetNotificationPrefsInput) => Promise<{ prefs: NotificationPrefs }>;
  /** Focus a session after an OS notification click. Main shows + focuses the
   *  window, then pushes `notification:focusSession` so the renderer navigates. */
  "notification.focusSession": (input: FocusSessionInput) => Promise<void>;
  // Custom models (user-defined Anthropic-compatible endpoints)
  "customModel.list": () => Promise<{ models: CustomModelPublic[] }>;
  "customModel.save": (input: SaveCustomModelInput) => Promise<{ models: CustomModelPublic[] }>;
  "customModel.delete": (input: { id: string }) => Promise<{ models: CustomModelPublic[] }>;
  "customModel.test": (input: TestCustomModelInput) => Promise<TestCustomModelResult>;
  /** Settings UI eye-icon only — returns cleartext token for display. */
  "customModel.getToken": (input: GetCustomModelTokenInput) => Promise<{ token: string | null }>;
  // Pi models (visual editor for ~/.pi/agent/models.json)
  "piModels.list": () => Promise<{ providers: Record<string, PiProviderPublic> }>;
  "piModels.save": (input: SavePiProviderInput) => Promise<{ providers: Record<string, PiProviderPublic> }>;
  "piModels.delete": (input: DeletePiProviderInput) => Promise<{ providers: Record<string, PiProviderPublic> }>;
  /** Returns cleartext apiKey. Used two ways: (1) main-process turn-time
   *  injection into the pi authStorage; (2) the settings UI's eye-icon view
   *  (same security carve-out as customModel.getToken). */
  "piModels.getApiKey": (input: GetPiApiKeyInput) => Promise<{ apiKey: string | null }>;
  /** List models the SDK can authenticate with the current configured keys.
   *  Builds a fresh ModelRuntime with all encrypted apiKeys injected, then
   *  returns getAvailable() projected into BuiltinModelOption[] shape for
   *  the composer's model picker. */
  "piModels.listAvailable": () => Promise<{ models: BuiltinModelOption[] }>;
  // Theme / color scheme
  "theme.get": () => Promise<GetThemeResult>;
  "theme.set": (input: SetThemeInput) => Promise<GetThemeResult>;
  // File read (on-demand diff rendering)
  "file.readFile": (input: FileReadInput) => Promise<{ content: string }>;
  /** Read a binary file as a base64 data URL (image preview). Same path guard. */
  "file.readBinary": (input: FileReadBinaryInput) => Promise<{ dataUrl: string }>;
  /** OS dialog image picker → base64 images (composer 图片 button). */
  "file.pickImages": (input: PickImagesInput) => Promise<{ images: PickedImage[]; skipped: string[] }>;
  /** Persist a clipboard-pasted external file to a temp path (composer paste). */
  "clipboard.saveFile": (input: ClipboardSaveFileInput) => Promise<ClipboardSaveFileResult>;
  /** Copy an image data URL onto the OS clipboard (image lightbox 复制). */
  "clipboard.writeImage": (input: ClipboardWriteImageInput) => Promise<ClipboardWriteImageResult>;
  /** List one level of a directory (non-recursive), scoped to a project root. */
  "file.listDir": (input: FileListDirInput) => Promise<{ entries: FileTreeEntry[] }>;
  /** Recursive file search under a project root (composer @ / add-context). */
  "file.search": (input: FileSearchInput) => Promise<FileSearchResult>;
  /** Write content to a file (creates parents), scoped to a project root. */
  "file.writeFile": (input: FileWriteInput) => Promise<{ ok: boolean }>;
  /** Create a directory (recursive), scoped to a project root. */
  "file.mkdir": (input: FileMkdirInput) => Promise<{ ok: boolean }>;
  /** Delete a file or directory (moves to system trash), scoped to a project root. */
  "file.delete": (input: FileDeleteInput) => Promise<{ ok: boolean }>;
  /** Rename a file or directory in place, scoped to a project root. */
  "file.rename": (input: FileRenameInput) => Promise<{ ok: boolean }>;
  /** Grep file contents under a project root (line-level matches). */
  "file.grep": (input: FileGrepInput) => Promise<FileGrepResult>;
  /** ripgrep availability snapshot (drives the search-dialog install banner). */
  "rg.status": () => Promise<RgStatusResult>;
  /** Download + install the ripgrep binary into userData/bin (one-click). */
  "rg.install": (input: RgInstallInput) => Promise<RgInstallResult>;
  // Git operations (P4 Git panel)
  /** Discover all git repos under a project root (recursive, max depth 3). */
  "git.discoverRepos": (input: GitDiscoverReposInput) => Promise<{ repos: GitRepo[] }>;
  /** Get the status of a single repo (branch / ahead / behind / files). */
  "git.status": (input: GitRepoPathInput) => Promise<{ status: GitStatusResult }>;
  /** Stage (git add) specific files. */
  "git.stage": (input: GitStageInput) => Promise<GitOpResult>;
  /** Unstage (git reset) specific files. */
  "git.unstage": (input: GitUnstageInput) => Promise<GitOpResult>;
  /** Commit staged changes with a message. */
  "git.commit": (input: GitCommitInput) => Promise<GitOpResult>;
  /** Push local commits to the upstream remote. */
  "git.push": (input: GitRepoPathInput) => Promise<GitOpResult>;
  /** Pull remote changes into the current branch. */
  "git.pull": (input: GitRepoPathInput) => Promise<GitOpResult>;
  /** Get the unstaged diff patch for a single file. */
  "git.diff": (input: GitDiffInput) => Promise<{ patch: string }>;
  /** Discard local changes to specific files (checkout tracked / clean untracked). */
  "git.discard": (input: GitDiscardInput) => Promise<GitOpResult>;
  /** Generate a commit message from the staged diff via an LLM one-shot call. */
  "git.generateCommitMessage": (input: GitGenerateCommitInput) => Promise<{ ok: boolean; message?: string; error?: string }>;
  "git.cancelGenerateCommitMessage": (input: GitCancelGenerateCommitInput) => Promise<{ ok: boolean }>;
  /** Resolve all merge conflicts in a repo via an AI one-shot call. Reads each
   *  conflicted file, asks the model for a resolved version, writes it back and
   *  runs `git add`. Does NOT commit. Returns the resolved file paths. */
  "git.resolveConflicts": (input: GitResolveConflictsInput) => Promise<{ ok: boolean; resolvedFiles?: string[]; error?: string }>;
  /** Paginated commit log for a repo (newest first). */
  "git.log": (input: GitLogInput) => Promise<{ commits: GitCommitInfo[]; hasMore: boolean }>;
  /** Meta + changed files for one commit. */
  "git.showCommit": (input: GitShowCommitInput) => Promise<GitCommitDetail | null>;
  /** Parent-vs-commit file contents for a single path (Monaco diff). */
  "git.showFile": (
    input: GitShowFileInput,
  ) => Promise<{ before: string; after: string }>;
  /** List local branches, remote branches and tags for a repo (grouped). */
  "git.listBranches": (input: GitRepoPathInput) => Promise<{ branches: GitBranchListResult }>;
  /** Check out a branch / tag / ref. With `newBranch`, creates a new local
   *  branch from the target and checks it out (tracking branch or new branch). */
  "git.checkout": (input: GitCheckoutInput) => Promise<GitOpResult>;
  // Integrated terminal (P4 IDE right panel)
  /** Spawn a PTY in the project cwd (or a subdir). */
  "terminal.create": (input: TerminalCreateInput) => Promise<TerminalCreateResult>;
  /** Write raw input bytes/text to a live PTY. */
  "terminal.write": (input: TerminalWriteInput) => Promise<TerminalOpResult>;
  /** Notify the PTY of a cols/rows change (after xterm fit). */
  "terminal.resize": (input: TerminalResizeInput) => Promise<TerminalOpResult>;
  /** Kill a PTY process and drop it from the manager. */
  "terminal.kill": (input: TerminalKillInput) => Promise<TerminalOpResult>;
  /** List live terminals, optionally filtered by project. */
  "terminal.list": (input: TerminalListInput) => Promise<{ terminals: TerminalInfo[] }>;
  // Embedded browser (WebContentsView + DOM element picker)
  /** Create a browser view bound to a project root. Returns an opaque id. */
  "browser.create": (input: BrowserCreateInput) => Promise<BrowserCreateResult>;
  /** Navigate the view to a URL. */
  "browser.loadUrl": (input: BrowserLoadUrlInput) => Promise<BrowserOpResult>;
  /** History back. */
  "browser.goBack": (input: BrowserGoBackInput) => Promise<BrowserOpResult>;
  /** History forward. */
  "browser.goForward": (input: BrowserGoForwardInput) => Promise<BrowserOpResult>;
  /** Reload the current page. */
  "browser.reload": (input: BrowserReloadInput) => Promise<BrowserOpResult>;
  /** Reposition/resize the view over the renderer's placeholder. */
  "browser.setBounds": (input: BrowserSetBoundsInput) => Promise<BrowserOpResult>;
  /** Inject/remove the DOM element picker into the page's main world. */
  "browser.setPickMode": (input: BrowserSetPickModeInput) => Promise<BrowserOpResult>;
  /** Show the view (attach + restore bounds). */
  "browser.show": (input: BrowserShowInput) => Promise<BrowserOpResult>;
  /** Hide the view (move offscreen without destroying the session). */
  "browser.hide": (input: BrowserHideInput) => Promise<BrowserOpResult>;
  /** Destroy the view and drop it from the manager. */
  "browser.close": (input: BrowserCloseInput) => Promise<BrowserOpResult>;
  /** Set the device emulation preset (desktop / iphone / android). */
  "browser.setDevice": (input: BrowserSetDeviceInput) => Promise<BrowserOpResult>;
  /** Clear the embedded browser's HTTP cache + temporary site storage
   *  (localStorage / IndexedDB / service workers / etc.). Cookies and login
   *  data are preserved, so the user stays signed in. */
  "browser.clearCache": () => Promise<BrowserOpResult>;
  /** Remove one entry from the address-bar history. */
  "browser.historyRemove": (input: BrowserHistoryRemoveInput) => Promise<BrowserOpResult>;
  /** Clear the whole address-bar history. */
  "browser.historyClear": (input: BrowserHistoryClearInput) => Promise<BrowserOpResult>;
  /** List saved browser credentials (origin + username only, no passwords). */
  "browser.credentialsList": (input: BrowserCredentialsListInput) => Promise<{
    credentials: BrowserCredentialPublic[];
  }>;
  /** Create/update a credential (password encrypted with safeStorage). */
  "browser.credentialsSave": (input: BrowserCredentialsSaveInput) => Promise<{
    credentials: BrowserCredentialPublic[];
  }>;
  /** Delete a credential by origin. */
  "browser.credentialsRemove": (input: BrowserCredentialsRemoveInput) => Promise<{
    credentials: BrowserCredentialPublic[];
  }>;
  /** Fill the saved credential into the view's current page login form. */
  "browser.credentialsFill": (input: BrowserCredentialsFillInput) => Promise<BrowserCredentialsFillResult>;
  /** Answer a pending HTTP Basic Auth prompt (see "authRequest" push event). */
  "browser.authRespond": (input: BrowserAuthRespondInput) => Promise<void>;
  /** App version + runtime info for the About panel. */
  "app.info": () => Promise<AppInfoResult>;
  /** Check for updates on the GitHub Releases channel. Returns the current
   *  version when up-to-date, the new version when available, or an error.
   *  In dev this short-circuits to "up-to-date" (updater only runs in prod). */
  "app.checkForUpdates": () => Promise<CheckForUpdatesResult>;
  /** Start downloading the pending update (autoDownload is off, so the user
   *  opts in via this call). Resolves once the download begins; the
   *  `update:downloaded` push event fires when it's ready to install. */
  "app.downloadUpdate": () => Promise<void>;
  /** Quit the app and install the downloaded update (called after
   *  `update:downloaded`). */
  "app.quitAndInstall": () => Promise<void>;
  /** Open a path in the OS file manager. Main refuses any path that isn't a
   *  known project root, so this can't be used to open arbitrary locations. */
  "shell.openPath": (input: OpenPathInput) => Promise<void>;
  /** Reveal a file or directory in the OS file manager, selecting it. Accepts
   *  any path that resolves inside a known project root (not just the root). */
  "shell.showItemInFolder": (input: ShowItemInFolderInput) => Promise<void>;
  /** Open a file with the OS's default associated application. Accepts any
   *  path that resolves inside a known project root (not just the root). */
  "shell.openFile": (input: OpenFileInput) => Promise<void>;
  /** Native multi-file picker (project-external files allowed). Returns the
   *  selected absolute paths; empty array when the user cancels. */
  "dialog.pickFiles": (input: DialogPickFilesInput) => Promise<{ paths: string[] }>;
  /** Discover skills for the composer `/` menu. Scans the user-global
   *  `~/.claude/skills/` plus the active project's `.claude/skills/` and
   *  parses each SKILL.md's frontmatter. Always resolves (degrades to an
   *  empty list on any IO error). */
  "skills.list": (input: SkillsListInput) => Promise<{ skills: SkillInfo[] }>;
  /** Read one skill's full SKILL.md source (no truncation). Missing file →
   *  empty content. */
  "skills.read": (input: SkillsReadInput) => Promise<{ content: string }>;
  /** Create or overwrite a skill's SKILL.md (full content write; creates the
   *  skill directory if absent). Returns ok:false + error on any IO failure. */
  "skills.save": (input: SkillsSaveInput) => Promise<{ ok: boolean; error?: string }>;
  /** Delete a skill directory (symlink → unlink link only; real dir → recursive
   *  remove). Returns ok:false + error on any IO failure. */
  "skills.delete": (input: SkillsDeleteInput) => Promise<{ ok: boolean; error?: string }>;
  /** Scan external tools (Claude Code / Codex / Zcode) for skills available
   *  for import into Mcode's own ~/.mcode/skills. Returns the full list of
   *  discoverable skills with their source paths. */
  "skills.scanSources": (input: SkillsScanSourcesInput) => Promise<{ sources: ExternalSkillInfo[] }>;
  /** Import (copy) selected skills from external tool directories into
   *  ~/.mcode/skills. Already-existing skills are skipped. Returns per-skill
   *  imported / skipped / error lists. */
  "skills.import": (input: SkillsImportInput) => Promise<{
    imported: string[];
    skipped: string[];
    errors: Array<{ name: string; error: string }>;
  }>;
  // MCP management (settings panel)
  /** List all MCP servers across the three sources (user config file, project
   *  .mcp.json, built-in mcode-browser) with their enabled state. */
  "mcp.list": (input: McpListInput) => Promise<{ servers: McpServerEntry[] }>;
  /** Enable/disable a server. User scope moves the config between the config
   *  file and the management stash; project/builtin update the management
   *  state. Takes effect on the next turn. */
  "mcp.toggle": (input: McpToggleInput) => Promise<{ ok: boolean; error?: string }>;
  /** Add a user-scope server (writes into ~/.mcode/.claude.json). */
  "mcp.save": (input: McpSaveInput) => Promise<{ ok: boolean; error?: string }>;
  /** Remove a user-scope server (from both the config file and the stash). */
  "mcp.remove": (input: McpRemoveInput) => Promise<{ ok: boolean; error?: string }>;
  /** Scan the local Claude CLI config (~/.claude.json) for servers available
   *  for import (global + per-project entries). Read-only. */
  "mcp.scanImport": (input: McpScanImportInput) => Promise<{ sources: McpImportSource[] }>;
  /** Import selected servers into the user scope. Already-existing names are
   *  skipped. Returns per-server imported / skipped / error lists. */
  "mcp.import": (input: McpImportInput) => Promise<{
    imported: string[];
    skipped: string[];
    errors: Array<{ name: string; error: string }>;
  }>;
  /** Output styles (settings panel): list built-in + user styles. The
   *  selection itself is persisted via the generic setting.get/set channels
   *  under AGENT_OUTPUT_STYLE_SETTING_KEY. */
  "outputStyle.list": (
    input: OutputStyleListInput,
  ) => Promise<{ styles: OutputStyleEntry[] }>;
  // Usage stats (settings panel)
  /** Aggregate the persisted per-turn usage history into summary / per-model /
   *  per-day views for the requested time range. Read-only. */
  "usage.stats": (input: UsageStatsInput) => Promise<UsageStatsResult>;
  // Language servers (LSP)
  /** List all language servers and their install/running state. */
  "lsp.list": () => Promise<{ languages: LspLanguageState[] }>;
  /** Install a language server via its package manager (npm/pip/go/brew). */
  "lsp.install": (input: LspInstallInput) => Promise<LspOpResult>;
  /** Install from a user-downloaded archive/binary (manual download fallback
   *  for when the package-manager install fails due to network issues). */
  "lsp.installFromFile": (input: LspInstallFromFileInput) => Promise<LspOpResult>;
  /** Uninstall a language server. */
  "lsp.uninstall": (input: LspUninstallInput) => Promise<LspOpResult>;
  /** Enable/disable a language (disabling kills any running server). Returns
   *  the refreshed state list. */
  "lsp.toggle": (input: LspToggleInput) => Promise<{ languages: LspLanguageState[] }>;
  /** Set a custom server path / args override. Returns the refreshed list. */
  "lsp.setPath": (input: LspSetPathInput) => Promise<{ languages: LspLanguageState[] }>;
  /** Verify the server binary runs (--version or --help probe). */
  "lsp.healthCheck": (input: LspHealthCheckInput) => Promise<LspOpResult>;
  /** Restart a language server for one workspace (stop + clear the crash-loop
   *  guard + immediately relaunch). Clicking a startup-failure notice calls
   *  this after the user fixes the environment. */
  "lsp.restart": (input: LspRestartInput) => Promise<LspOpResult>;
  /** Open a document in the server (textDocument/didOpen). Lazily starts the
   *  server for (workspacePath, language) on first call. */
  "lsp.openDocument": (input: LspOpenDocInput) => Promise<void>;
  /** Close a document (textDocument/didClose). */
  "lsp.closeDocument": (input: LspCloseDocInput) => Promise<void>;
  /** Notify the server of a full-content change (textDocument/didChange). */
  "lsp.didChange": (input: LspDidChangeInput) => Promise<void>;
  /** Notify the server of a save (textDocument/didSave). */
  "lsp.didSave": (input: LspDidSaveInput) => Promise<void>;
  /** Forward an arbitrary LSP request (definition/references/hover/...) to the
   *  server and await its response. */
  "lsp.request": (input: LspRequestInput) => Promise<LspRequestResult>;
  // ── Mobile companion (LAN pairing + device management) ──
  /** Begin a pairing session: returns QR URL + 6-digit code + endpoint.
   *  Optional `host` overrides auto-detected LAN IP (for multi-NIC machines
   *  where the phone can only reach one interface). */
  "mobile.startPairing": (input?: {
    host?: string;
    mode?: "lan" | "remote";
    endpoint?: string;
    /** Void the pending pairing (if any) and generate a fresh nonce + code.
     *  Without this the call reuses the pending pairing within its TTL, which
     *  is what the manual "refresh QR" buttons need to bypass. */
    force?: boolean;
  }) => Promise<{ pairing: PairingStartResult }>;
  /** Read the current pending pairing (for the dialog to rehydrate after a
   *  close/reopen). Null when no pairing is active. */
  "mobile.getPairing": () => Promise<{ pairing: { code: string; expiresAt: number } | null }>;
  /** Cancel the active pairing (clears the nonce). */
  "mobile.cancelPairing": () => Promise<{ ok: true }>;
  /** List paired devices (token stripped). */
  "mobile.listDevices": () => Promise<{ devices: PairedDevice[] }>;
  /** Revoke a paired device; its token stops working immediately. */
  "mobile.revokeDevice": (input: { deviceId: string }) => Promise<{ ok: true }>;
  /** Server status (running, port, endpoint, candidate LAN IPs) for the dialog. */
  "mobile.getStatus": () => Promise<{
    running: boolean;
    port: number;
    endpoint: string;
    lanIp: string | null;
    lanIps: string[];
  }>;
  /** Count of paired devices that are currently "active" (made a request
   *  within {@link MOBILE_ACTIVE_WINDOW_MS}). */
  "mobile.getActiveCount": () => Promise<{ count: number }>;
  // ── Relay (SSH-based remote access) ──
  /** Save VPS connection config to settings (persisted across restarts). */
  "relay.saveConfig": (input: RelayVpsConfigInput) => Promise<{ ok: true }>;
  /** Read the saved VPS config (passwords included — main→renderer only). */
  "relay.getConfig": () => Promise<{ config: RelayVpsConfig | null }>;
  /** Connect to the VPS: SSH + deploy forwarder + reverse tunnel. */
  "relay.connect": () => Promise<{ ok: boolean; error?: string }>;
  /** Disconnect from the VPS (forwarder keeps running on the VPS). */
  "relay.disconnect": () => Promise<{ ok: true }>;
  /** Read the current relay status. */
  "relay.status": () => Promise<RelayStatus>;
}

/** The channel names used in invoke/handle and send/on. Keep these centralized
 * so the preload allowlist and the main handlers never drift. */
export const IPC = {
  // invoke/handle (RPC)
  CLAUDE_START_SESSION: "claude:startSession",
  CLAUDE_SEND_TURN: "claude:sendTurn",
  CLAUDE_INTERRUPT: "claude:interrupt",
  CLAUDE_APPROVE: "claude:approve",
  CLAUDE_RESPOND_QUESTION: "claude:respondQuestion",
  CLAUDE_RESPOND_PLAN_APPROVAL: "claude:respondPlanApproval",
  CLAUDE_REWIND_TURN: "claude:rewindTurn",
  PROJECT_CREATE: "project:create",
  PROJECT_LIST: "project:list",
  PROJECT_SESSIONS: "project:sessions",
  PROJECT_DELETE: "project:delete",
  PROJECT_ARCHIVE: "project:archive",
  PROJECT_SET_GROUP: "project:setGroup",
  PROJECT_REORDER: "project:reorder",
  SESSION_DELETE: "session:delete",
  SESSION_ARCHIVE: "session:archive",
  SESSION_RENAME: "session:rename",
  SESSION_PIN: "session:pin",
  SESSION_LIST_PINNED: "session:listPinned",
  SESSION_SEARCH: "session:search",
  SESSION_MESSAGES: "session:messages",
  SESSION_SAVE_MESSAGES: "session:saveMessages",
  SESSION_UPSERT_MESSAGES: "session:upsertMessages",
  SESSION_TRUNCATE_AND_INSERT_MESSAGES: "session:truncateAndInsertMessages",
  SESSION_UPDATE_SETTINGS: "session:updateSettings",
  PROVIDER_LIST: "provider:list",
  // Settings
  SETTING_GET: "setting:get",
  SETTING_SET: "setting:set",
  SETTING_GET_MANY: "setting:getMany",
  // Voice input
  VOICE_START: "voice:start",
  VOICE_FEED: "voice:feed",
  VOICE_STOP: "voice:stop",
  VOICE_CANCEL: "voice:cancel",
  /** Main → renderer push for live ASR results. */
  VOICE_RESULT: "voice:result",
  /** List catalog + downloaded models + active selection. */
  VOICE_MODEL_LIST: "voice:modelList",
  /** Begin downloading a catalog model. */
  VOICE_DOWNLOAD_MODEL: "voice:downloadModel",
  /** Cancel an in-flight model download. */
  VOICE_CANCEL_MODEL_DOWNLOAD: "voice:cancelModelDownload",
  /** Select a downloaded model as the active voice model. */
  VOICE_SELECT_MODEL: "voice:selectModel",
  /** Delete a downloaded model's local files. */
  VOICE_REMOVE_MODEL: "voice:removeModel",
  /** Read the current voice model root directory. */
  VOICE_GET_MODEL_DIR: "voice:getModelDir",
  /** Change the voice model root directory (or reset to default). */
  VOICE_SET_MODEL_DIR: "voice:setModelDir",
  /** Main → renderer push for model download progress. */
  VOICE_DOWNLOAD_PROGRESS: "voice:downloadProgress",
  // Notifications
  NOTIFICATION_GET_PREFS: "notification:getPrefs",
  NOTIFICATION_SET_PREFS: "notification:setPrefs",
  NOTIFICATION_FOCUS_SESSION: "notification:focusSession",
  // Custom models (user-defined Anthropic-compatible endpoints)
  CUSTOM_MODEL_LIST: "customModel:list",
  CUSTOM_MODEL_SAVE: "customModel:save",
  CUSTOM_MODEL_DELETE: "customModel:delete",
  CUSTOM_MODEL_TEST: "customModel:test",
  CUSTOM_MODEL_GET_TOKEN: "customModel:getToken",
  // Pi models (visual editor for ~/.pi/agent/models.json)
  PI_MODELS_LIST: "piModels:list",
  PI_MODELS_SAVE: "piModels:save",
  PI_MODELS_DELETE: "piModels:delete",
  PI_MODELS_GET_API_KEY: "piModels:getApiKey",
  PI_MODELS_LIST_AVAILABLE: "piModels:listAvailable",
  // Theme / color scheme
  THEME_GET: "theme:get",
  THEME_SET: "theme:set",
  // File read (on-demand diff rendering)
  FILE_READ: "file:readFile",
  // File read as base64 data URL (image preview)
  FILE_READ_BINARY: "file:readBinary",
  // OS dialog image picker → base64 images (composer 图片 button)
  FILE_PICK_IMAGES: "file:pickImages",
  // Clipboard-pasted external file → temp path (composer paste)
  CLIPBOARD_SAVE_FILE: "clipboard:saveFile",
  // Image data URL → OS clipboard (image lightbox 复制)
  CLIPBOARD_WRITE_IMAGE: "clipboard:writeImage",
  // File tree listing + writing (P4 IDE right panel)
  FILE_LIST_DIR: "file:listDir",
  FILE_SEARCH: "file:search",
  FILE_WRITE: "file:writeFile",
  // Create a directory (file-tree "新建文件夹")
  FILE_MKDIR: "file:mkdir",
  // Delete a file or directory (file-tree "删除" — moves to system trash)
  FILE_DELETE: "file:delete",
  // Rename a file or directory in place (file-tree "重命名")
  FILE_RENAME: "file:rename",
  FILE_GREP: "file:grep",
  RG_STATUS: "rg:status",
  RG_INSTALL: "rg:install",
  // Git operations (P4 Git panel)
  GIT_DISCOVER_REPOS: "git:discoverRepos",
  GIT_STATUS: "git:status",
  GIT_STAGE: "git:stage",
  GIT_UNSTAGE: "git:unstage",
  GIT_COMMIT: "git:commit",
  GIT_PUSH: "git:push",
  GIT_PULL: "git:pull",
  GIT_DIFF: "git:diff",
  GIT_DISCARD: "git:discard",
  GIT_GENERATE_COMMIT: "git:generateCommitMessage",
  GIT_CANCEL_GENERATE_COMMIT: "git:cancelGenerateCommitMessage",
  GIT_RESOLVE_CONFLICTS: "git:resolveConflicts",
  GIT_LOG: "git:log",
  GIT_SHOW_COMMIT: "git:showCommit",
  GIT_SHOW_FILE: "git:showFile",
  GIT_LIST_BRANCHES: "git:listBranches",
  GIT_CHECKOUT: "git:checkout",
  // Integrated terminal (P4 IDE right panel)
  TERMINAL_CREATE: "terminal:create",
  TERMINAL_WRITE: "terminal:write",
  TERMINAL_RESIZE: "terminal:resize",
  TERMINAL_KILL: "terminal:kill",
  TERMINAL_LIST: "terminal:list",
  // Embedded browser (WebContentsView + DOM element picker)
  BROWSER_CREATE: "browser:create",
  BROWSER_LOAD_URL: "browser:loadUrl",
  BROWSER_GO_BACK: "browser:goBack",
  BROWSER_GO_FORWARD: "browser:goForward",
  BROWSER_RELOAD: "browser:reload",
  BROWSER_SET_BOUNDS: "browser:setBounds",
  BROWSER_SET_PICK_MODE: "browser:setPickMode",
  BROWSER_SHOW: "browser:show",
  BROWSER_HIDE: "browser:hide",
  BROWSER_CLOSE: "browser:close",
  BROWSER_SET_DEVICE: "browser:setDevice",
  BROWSER_CLEAR_CACHE: "browser:clearCache",
  // Address history + credential vault (embedded browser)
  BROWSER_HISTORY_REMOVE: "browser:historyRemove",
  BROWSER_HISTORY_CLEAR: "browser:historyClear",
  BROWSER_CREDENTIALS_LIST: "browser:credentialsList",
  BROWSER_CREDENTIALS_SAVE: "browser:credentialsSave",
  BROWSER_CREDENTIALS_REMOVE: "browser:credentialsRemove",
  BROWSER_CREDENTIALS_FILL: "browser:credentialsFill",
  BROWSER_AUTH_RESPOND: "browser:authRespond",
  // App / runtime info (About panel)
  APP_INFO: "app:info",
  // Auto-update (electron-updater)
  APP_CHECK_FOR_UPDATES: "app:checkForUpdates",
  APP_DOWNLOAD_UPDATE: "app:downloadUpdate",
  APP_QUIT_AND_INSTALL: "app:quitAndInstall",
  // Open a project root in the OS file manager (main refuses non-project paths)
  SHELL_OPEN_PATH: "shell:openPath",
  // Reveal a file/dir inside a project root in the OS file manager (selects it)
  SHELL_SHOW_ITEM_IN_FOLDER: "shell:showItemInFolder",
  // Open a file inside a project root with the OS default application
  SHELL_OPEN_FILE: "shell:openFile",
  // Native multi-file picker (project-external files allowed) for the composer
  DIALOG_PICK_FILES: "dialog:pickFiles",
  // Skill discovery for the composer `/` menu (scans ~/.claude/skills + project)
  SKILLS_LIST: "skills:list",
  // Skill management (settings panel): read / save / delete a single skill
  SKILLS_READ: "skills:read",
  SKILLS_SAVE: "skills:save",
  SKILLS_DELETE: "skills:delete",
  // Skill import (settings panel): scan external tools + copy into ~/.mcode/skills
  SKILLS_SCAN_SOURCES: "skills:scanSources",
  SKILLS_IMPORT: "skills:import",
  // MCP management (settings panel): list / toggle / add / remove / import
  MCP_LIST: "mcp:list",
  MCP_TOGGLE: "mcp:toggle",
  MCP_SAVE: "mcp:save",
  MCP_REMOVE: "mcp:remove",
  MCP_SCAN_IMPORT: "mcp:scanImport",
  MCP_IMPORT: "mcp:import",
  // Output styles (settings panel): list built-in + user styles
  OUTPUT_STYLE_LIST: "outputStyle:list",
  // Usage stats (settings panel): aggregated token/cost usage over time ranges
  USAGE_STATS: "usage:stats",
  // Language servers (LSP): install/enable/sync/request
  LSP_LIST: "lsp:list",
  LSP_INSTALL: "lsp:install",
  LSP_INSTALL_FROM_FILE: "lsp:installFromFile",
  LSP_UNINSTALL: "lsp:uninstall",
  LSP_TOGGLE: "lsp:toggle",
  LSP_SET_PATH: "lsp:setPath",
  LSP_HEALTH_CHECK: "lsp:healthCheck",
  LSP_RESTART: "lsp:restart",
  LSP_OPEN_DOC: "lsp:openDocument",
  LSP_CLOSE_DOC: "lsp:closeDocument",
  LSP_DID_CHANGE: "lsp:didChange",
  LSP_DID_SAVE: "lsp:didSave",
  LSP_REQUEST: "lsp:request",
  // Mobile companion (LAN pairing + device management) — invoke/handle (RPC).
  MOBILE_START_PAIRING: "mobile:startPairing",
  MOBILE_GET_PAIRING: "mobile:getPairing",
  MOBILE_CANCEL_PAIRING: "mobile:cancelPairing",
  MOBILE_LIST_DEVICES: "mobile:listDevices",
  MOBILE_REVOKE_DEVICE: "mobile:revokeDevice",
  MOBILE_GET_STATUS: "mobile:getStatus",
  MOBILE_GET_ACTIVE_COUNT: "mobile:getActiveCount",
  // Relay (SSH-based remote access) — invoke/handle (RPC).
  RELAY_SAVE_CONFIG: "relay:saveConfig",
  RELAY_GET_CONFIG: "relay:getConfig",
  RELAY_CONNECT: "relay:connect",
  RELAY_DISCONNECT: "relay:disconnect",
  RELAY_STATUS: "relay:status",
  // Relay push events (main → renderer).
  RELAY_EVENT: "relay:event",
  // send/on (push events)
  CLAUDE_EVENT: "claude:event",
  SESSION_TITLE_UPDATED: "session:titleUpdated",
  TERMINAL_DATA: "terminal:data",
  TERMINAL_EXIT: "terminal:exit",
  LSP_EVENT: "lsp:event",
  BROWSER_EVENT: "browser:event",
  THEME_CHANGED: "theme:changed",
  UPDATE_AVAILABLE: "update:available",
  UPDATE_DOWNLOAD_PROGRESS: "update:downloadProgress",
  UPDATE_DOWNLOADED: "update:downloaded",
  WINDOW_FOCUS_CHANGED: "window:focusChanged",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
