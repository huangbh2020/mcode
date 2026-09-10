/**
 * Plugin subsystem contracts (cross-process, no runtime logic).
 *
 * A plugin is a declarative capability pack (docs/plugin-feasibility.md) — a
 * directory with a manifest at `.claude-plugin/plugin.json` (the Claude-ecos
 * layout; `.zcode-plugin` / `.codex-plugin` manifests are detected as
 * compatible alternatives) carrying skills / commands / agents / hooks / MCP
 * servers. Mcode installs plugins into its own cache
 * (`~/.mcode/plugins/<name>/<version>/`), persists the enabled set in the
 * settings table, and translates per provider at turn start:
 *
 *   - Claude: SDK-native `options.plugins` (skills/commands/agents loaded by
 *     the CLI engine; `skipMcpDiscovery` keeps MCP host-managed; hooks are
 *     held OFF in v1 via `disableAllHooks` — the panel states this openly)
 *   - Codex:  skills via the `skills/extraRoots/set` RPC + MCP materialized
 *     into `<CODEX_HOME>/config.toml` under the same `<plugin>__<server>` name
 *   - Pi:     skills via the resource loader's additional skill paths only
 *
 * This module holds the manifest/marketplace zod schemas, the settings-panel
 * state types and the RPC input schemas. ipc.ts re-exports them and wires the
 * `plugins.*` channels; keep this file electron-free (pure zod + types).
 */
import { z } from "zod";

/* ── Settings keys (settings table) ── */

/** Enabled plugin names. Value = JSON.stringify(string[]). A name whose
 *  directory vanished from disk is ignored until reinstalled (reinstalling
 *  restores the enabled state). */
export const PLUGINS_ENABLED_SETTING_KEY = "plugins.enabled";

/** User-added plugin marketplaces. Value = JSON.stringify(PluginMarketplaceRecord[]). */
export const PLUGINS_MARKETPLACES_SETTING_KEY = "plugins.marketplaces";

/** Plugin-contributed MCP servers the user turned OFF in the MCP panel
 *  (namespaced `<plugin>__<server>` names). Value = JSON.stringify(string[]). */
export const PLUGINS_MCP_DISABLED_SETTING_KEY = "plugins.mcpDisabled";

/* ── Manifest (plugin.json) ── */

/** Where a plugin's manifest is looked up, in probe order. The Claude layout
 *  is the canonical format (largest ecosystem); the other two are
 *  structurally identical, so a single parser covers all three. */
export const PLUGIN_MANIFEST_DIRS = [".claude-plugin", ".zcode-plugin", ".codex-plugin"] as const;

/** Plugin name charset — also guards the on-disk directory name (no path
 *  separators, no leading dot). */
export const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Plugin manifest (`.claude-plugin/plugin.json` & compatible shapes).
 *  Component fields are directory/file names RELATIVE to the plugin root;
 *  component paths that escape the plugin root are rejected by the resolver
 *  (not by the schema — the schema only checks shape). Unknown fields pass
 *  through so future manifest keys survive a round-trip.
 *
 *  Component paths accept Claude's full form: a single relative path OR an
 *  array of them (official-marketplace manifests use both — rejecting arrays
 *  made such plugins uninstallable). Resolvers normalize to string[]. */
export const PluginManifestSchema = z
  .object({
    name: z.string().regex(PLUGIN_NAME_RE),
    version: z.string().optional(),
    description: z.string().optional(),
    author: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    /** Skills directory name(s) (default "skills"). */
    skills: z.union([z.string(), z.array(z.string())]).optional(),
    /** Commands directory name(s) (default "commands"). */
    commands: z.union([z.string(), z.array(z.string())]).optional(),
    /** Agents directory name(s) (default "agents"). */
    agents: z.union([z.string(), z.array(z.string())]).optional(),
    /** Hooks definition file(s), relative (default "hooks/hooks.json"). */
    hooks: z.union([z.string(), z.array(z.string())]).optional(),
    /** MCP servers definition file(s), relative (default ".mcp.json" at root). */
    mcpServers: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/* ── Marketplace manifest (marketplace.json) ── */

/** One entry of a marketplace's `plugins[]`. `source` follows the Claude
 *  marketplace shape (verified against anthropics/claude-plugins-official,
 *  292 entries: 152 url / 88 git-subdir / 52 relative paths): a relative path
 *  string, a GitHub repo reference, a git URL (optionally a subdir + ref/sha),
 *  or a direct archive URL. Unknown shapes fail this schema — the manager
 *  skips such entries individually instead of dropping the whole catalog. */
export const PluginMarketEntrySourceSchema = z.union([
  z.string(),
  z
    .object({ source: z.literal("github"), repo: z.string().min(1) })
    .passthrough(),
  z
    .object({ source: z.literal("git"), url: z.string().min(1), ref: z.string().optional() })
    .passthrough(),
  z
    .object({
      source: z.literal("git-subdir"),
      url: z.string().min(1),
      path: z.string().min(1),
      ref: z.string().optional(),
      /** Pinned commit; recorded but not enforced by v1 (the install-review
       *  dialog is the integrity gate). */
      sha: z.string().optional(),
    })
    .passthrough(),
  z
    .object({ source: z.literal("url"), url: z.string().min(1) })
    .passthrough(),
]);
export type PluginMarketEntrySource = z.infer<typeof PluginMarketEntrySourceSchema>;

export const PluginMarketEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.string().optional(),
    source: PluginMarketEntrySourceSchema,
  })
  .passthrough();

/** `.claude-plugin/marketplace.json` (root-level `marketplace.json` is
 *  accepted as a fallback by the manager). */
export const PluginMarketplaceManifestSchema = z
  .object({
    name: z.string().optional(),
    owner: z.string().optional(),
    plugins: z.array(PluginMarketEntrySchema),
  })
  .passthrough();
export type PluginMarketplaceManifest = z.infer<typeof PluginMarketplaceManifestSchema>;

/* ── Component summaries (install review + panel display) ── */

/** A skill contributed by the plugin (from SKILL.md frontmatter). */
export interface PluginSkillSummary {
  name: string;
  description: string;
}

/** A slash command contributed by the plugin (from commands/*.md frontmatter).
 *  v1: loaded natively by the Claude engine; a host-side composer expansion
 *  (provider-neutral) is planned for v2. */
export interface PluginCommandSummary {
  name: string;
  description: string;
}

/** A subagent definition (agents/*.md frontmatter) — Claude sessions only. */
export interface PluginAgentSummary {
  name: string;
  description: string;
}

/** One hook command as declared by the plugin. v1 parses and SHOWS these but
 *  never executes them (see pluginManager docs) — the panel labels them
 *  explicitly so users don't assume the automation is live. */
export interface PluginHookSummary {
  event: string;
  matcher?: string;
  command: string;
}

/** Transport kind of a plugin MCP server, mirroring the MCP panel. */
export type PluginMcpKind = "stdio" | "http" | "sse";

/** One MCP server contributed by the plugin. `detail` is secret-free
 *  (command line or URL) — env values never enter it. */
export interface PluginMcpServerSummary {
  name: string;
  kind: PluginMcpKind;
  detail: string;
}

/** Everything the install-review dialog and the plugin row expand needs. */
export interface PluginComponents {
  skills: PluginSkillSummary[];
  commands: PluginCommandSummary[];
  agents: PluginAgentSummary[];
  hooks: PluginHookSummary[];
  mcpServers: PluginMcpServerSummary[];
}

/* ── Panel state ── */

/** Where an installed plugin came from (recorded in .mcode-install.json). */
export type PluginSourceKind = "local-dir" | "local-zip" | "git" | "marketplace" | "unknown";

export interface PluginSourceInfo {
  kind: PluginSourceKind;
  /** Path / URL / `marketplace:<name>` — display + future update checks. */
  ref: string;
}

/** One installed plugin row. `rootDir` is the versioned install directory. */
export interface PluginState {
  name: string;
  version: string;
  description: string;
  rootDir: string;
  /** Enabled plugins are delivered to providers at the NEXT turn start
   * (each turn rebuilds provider options — no live reload needed). */
  enabled: boolean;
  installedAt: string;
  source: PluginSourceInfo;
  components: PluginComponents;
}

/** A marketplace added by the user. The cloned/copied tree lives under
 *  `~/.mcode/plugins/marketplaces/<name>/`. */
export interface PluginMarketplaceRecord {
  name: string;
  source: { kind: "git" | "local"; ref: string };
  addedAt: string;
}

/** A marketplace listing entry for the Discover tab. `installed` is computed
 *  against the installed plugin set (matched by name). */
export interface PluginMarketEntry {
  marketplace: string;
  name: string;
  description: string;
  version: string;
  installed: boolean;
}

/** Marketplace panel state (records joined with their parsed manifests). */
export interface PluginMarketplaceState {
  name: string;
  sourceKind: "git" | "local";
  sourceRef: string;
  addedAt: string;
  plugins: PluginMarketEntry[];
}

/* ── RPC input schemas ── */

export const PluginsListSchema = z.object({});
export type PluginsListInput = z.infer<typeof PluginsListSchema>;

/** Install from a user-picked local path (plugin directory or .zip archive).
 *  The install lands DISABLED; the renderer shows the component-review dialog
 *  on success and calls setEnabled when the user approves. */
export const PluginsInstallLocalSchema = z.object({
  localPath: z.string().min(1),
});
export type PluginsInstallLocalInput = z.infer<typeof PluginsInstallLocalSchema>;

/** Install by cloning a git repository (shallow). `ref` selects a branch/tag. */
export const PluginsInstallGitSchema = z.object({
  url: z.string().min(1),
  ref: z.string().optional(),
});
export type PluginsInstallGitInput = z.infer<typeof PluginsInstallGitSchema>;

/** Install an entry of a user-added marketplace (resolved from its manifest
 *  source: relative path / github repo / git url). */
export const PluginsInstallMarketplaceSchema = z.object({
  marketplace: z.string().min(1),
  name: z.string().min(1),
});
export type PluginsInstallMarketplaceInput = z.infer<typeof PluginsInstallMarketplaceSchema>;

export const PluginsSetEnabledSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_RE),
  enabled: z.boolean(),
});
export type PluginsSetEnabledInput = z.infer<typeof PluginsSetEnabledSchema>;

/** Uninstall: deletes every installed version + clears enable/disable state.
 *  Rejected while any turn is running (a live turn may reference the files). */
export const PluginsRemoveSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_RE),
});
export type PluginsRemoveInput = z.infer<typeof PluginsRemoveSchema>;

export const PluginsMarketplaceListSchema = z.object({});
export type PluginsMarketplaceListInput = z.infer<typeof PluginsMarketplaceListSchema>;

/** Add a marketplace by git URL or local directory (cloned/copied under
 *  `~/.mcode/plugins/marketplaces/`). `name` overrides the manifest's own
 *  name when provided. */
export const PluginsMarketplaceAddSchema = z.object({
  kind: z.enum(["git", "local"]),
  /** git URL, or absolute local directory path. */
  ref: z.string().min(1),
  name: z.string().regex(PLUGIN_NAME_RE).optional(),
});
export type PluginsMarketplaceAddInput = z.infer<typeof PluginsMarketplaceAddSchema>;

export const PluginsMarketplaceRemoveSchema = z.object({
  name: z.string().min(1),
});
export type PluginsMarketplaceRemoveInput = z.infer<typeof PluginsMarketplaceRemoveSchema>;

/** Re-fetch a marketplace (git: fresh shallow clone; local: re-copy). */
export const PluginsMarketplaceRefreshSchema = z.object({
  name: z.string().min(1),
});
export type PluginsMarketplaceRefreshInput = z.infer<typeof PluginsMarketplaceRefreshSchema>;
