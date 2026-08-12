/**
 * Skill bridge: make Mcode's skill directories and `/name` trigger syntax work
 * with the Pi SDK.
 *
 * Pi's skill mechanism is structurally different from Claude's, and the project
 * was originally wired only for Claude, so skills silently no-op under the Pi
 * provider. Three mismatches had to be fixed together (any one alone leaves the
 * feature broken):
 *
 *   1. **Path mismatch.** Pi's `DefaultResourceLoader` scans `<agentDir>/skills`
 *      (`~/.pi/agent/skills`) and `<cwd>/.pi/skills` (`CONFIG_DIR_NAME=".pi"`),
 *      but Mcode stores user skills in `~/.mcode/skills` and project skills in
 *      `<cwd>/.claude/skills` (see `ipc/skills.ts:resolveSkillRoot`). Pi scans
 *      none of them, so `getSkills()` returns an empty set.
 *
 *   2. **Trigger syntax mismatch.** Pi only recognizes `/skill:name`
 *      (`agent-session.js:_expandSkillCommand` gates on
 *      `text.startsWith("/skill:")`). The composer serializes a skill pill as a
 *      bare `/name` (`ComposerEditor.tsx` `renderText`), so Pi falls through to
 *      `expandPromptTemplate` and ships the literal `/name` to the LLM.
 *
 *   3. **`req.skills` dropped.** Unlike Claude's `Options.skills` allowlist, Pi
 *      has no skill option on `createAgentSession`; the only hook is
 *      `resourceLoader`, and `skillsOverride` is the name-based filter.
 *
 * The bridge:
 *   - {@link buildPiSkillLoader} constructs a `DefaultResourceLoader` whose
 *     `additionalSkillPaths` pulls in the two Mcode roots (Pi's own defaults are
 *     kept so existing `~/.pi` users aren't disrupted), and whose
 *     `skillsOverride` narrows the discovered set to the user-selected names
 *     when `req.skills` is non-empty.
 *   - {@link rewriteSkillPrefix} rewrites a leading `/name` to `/skill:name` for
 *     the names the loader actually resolved, so Pi's `_expandSkillCommand`
 *     recognizes the invocation.
 *
 * This module is provider-internal: the renderer/contracts/IPC layers are
 * provider-neutral and don't change (skill pills render off the `skillNames`
 * persisted on the message text block at send time, independent of the
 * provider).
 */
import { homedir } from "node:os";
import path from "node:path";
import { bashPathHintFor, detectBashEnv } from "@main/lib/bashEnv.js";

/** Suffix-free access to the Pi SDK module type (the provider already loads it
 *  via `loadPiSdk()` and hands us the resolved module). */
type PiSdk = typeof import("@earendil-works/pi-coding-agent");
/** The loader type `createAgentSession` accepts. We return the concrete class so
 *  the provider can also call `getSkills()` to learn the resolved names for the
 *  prompt rewrite. */
export type PiResourceLoader = import("@earendil-works/pi-coding-agent").DefaultResourceLoader;

/** The two Mcode skill roots, mirroring `ipc/skills.ts:resolveSkillRoot`. Kept
 *  here (rather than importing from the IPC module) so the provider layer stays
 *  decoupled from IPC handler internals — and because these are plain path
 *  computations with no IPC dependency. */
function mcodeSkillRoots(cwd: string): string[] {
  return [path.join(homedir(), ".mcode", "skills"), path.join(cwd, ".claude", "skills")];
}

export interface BuildPiSkillLoaderOptions {
  sdk: PiSdk;
  /** Project working directory (the session's `cwd`). */
  cwd: string;
  /** Skill names the user picked in the composer (no leading `/`). When
   *  non-empty, the loader narrows the discovered skills to this set (mirrors
   *  Claude's `Options.skills` allowlist). Empty/undefined → all discovered
   *  skills (mirrors Claude's `"all"` sentinel). */
  allowNames?: string[];
  /** Inline extensions to inject via the loader's `extensionFactories` option.
   *  The loader runs each factory during `getExtensions()` (before
   *  `_refreshToolRegistry`), so `pi.registerTool` / `pi.on` are wired before
   *  the first turn. Mcode passes its host-bridging extension (approval,
   *  AskUserQuestion, system-prompt injection) here. */
  extensionFactories?: import("@earendil-works/pi-coding-agent").InlineExtension[];
}

/**
 * Construct and reload a `DefaultResourceLoader` configured to discover Mcode's
 * skill directories in addition to Pi's own defaults, optionally filtered to an
 * allowlist of names.
 *
 * The returned loader is ready to pass as `createAgentSession({ resourceLoader
 * })` — the SDK skips its own default construction and does NOT call `reload()`
 * again when a loader is supplied (see `sdk.js` around line 75), so we reload
 * here exactly once.
 *
 * Never throws on a missing/unreadable skills dir: `DefaultResourceLoader`
 * treats unresolvable `additionalSkillPaths` as empty. The allowlist filter is a
 * best-effort name intersection; an unknown name in `allowNames` simply matches
 * nothing (the model then sees no such skill — same as Claude's allowlist).
 */
export async function buildPiSkillLoader(
  opts: BuildPiSkillLoaderOptions,
): Promise<PiResourceLoader> {
  const { sdk, cwd, allowNames, extensionFactories } = opts;
  const allow = allowNames && allowNames.length > 0 ? new Set(allowNames) : undefined;

  const loader = new sdk.DefaultResourceLoader({
    cwd,
    // `getAgentDir()` honors `PI_CODING_AGENT_DIR` and the package's
    // `piConfig.configDir`; hand-building `~/.pi/agent` would miss both.
    agentDir: sdk.getAgentDir(),
    // Inline extensions — the loader calls each factory during
    // `getExtensions()`, before `_refreshToolRegistry`, so `pi.registerTool`
    // / `pi.on` are live before the first agent turn. Mcode's extension
    // bridges host approval, AskUserQuestion, and system-prompt injection.
    extensionFactories: extensionFactories ?? [],
    // Pull in Mcode's two roots alongside Pi's defaults. We deliberately leave
    // `noSkills` unset so Pi's own `~/.pi/agent/skills` + `<cwd>/.pi/skills`
    // keep working — existing Pi users aren't disrupted.
    additionalSkillPaths: mcodeSkillRoots(cwd),
    // On Windows, append a path-style hint that matches the bash the SDK will
    // actually spawn — native (Git Bash: `/mnt/...` doesn't exist) or WSL
    // (`/mnt/...` is the only absolute form that resolves; `detectBashEnv`
    // mirrors the SDK's `getShellConfig` resolution, so on machines where Git
    // isn't at the hardcoded locations and its `usr\bin` isn't on PATH, `where
    // bash.exe` lands on the WSL launcher and every Bash call runs inside
    // WSL). The `createMntNormalizingReadTool` override is the silent-recovery
    // backstop; this hint attacks the root cause and also covers
    // Bash-redirected reads.
    ...(process.platform === "win32"
      ? { appendSystemPrompt: [bashPathHintFor(detectBashEnv("pi"))] }
      : {}),
    // Mirror Claude's allowlist semantics: when the user picked specific
    // skills, only those reach the model. Empty/undefined → no override, all
    // discovered skills are available (Claude's `"all"` analogue).
    ...(allow
      ? {
          skillsOverride: (base: {
            skills: import("@earendil-works/pi-coding-agent").Skill[];
            diagnostics: import("@earendil-works/pi-coding-agent").ResourceDiagnostic[];
          }) => ({
            skills: base.skills.filter((s) => allow.has(s.name)),
            diagnostics: base.diagnostics,
          }),
        }
      : {}),
  });
  await loader.reload();
  return loader;
}

/**
 * Rewrite a leading `/name` (a composer-emitted skill pill) into Pi's
 * `/skill:name` trigger form, but only for names the loader actually resolved.
 *
 * Why only the leading token: Pi's `_expandSkillCommand` itself only recognizes
 * `/skill:` at `text[0]` (`agent-session.js:951`), so rewriting mid-text would
 * have no effect on Pi and would only corrupt the user's message. A skill pill
 * embedded mid-sentence isn't expanded by Pi regardless; for those, Pi's
 * `formatSkillsForPrompt` already lists every discovered skill in the system
 * prompt and the model can load it via the `read` tool as a fallback.
 *
 * `knownNames` is the set of names the (allowlist-filtered) loader resolved —
 * the same set Pi's internal `find(s => s.name === skillName)` will search, so
 * the rewrite never produces a `/skill:` token Pi can't expand (which would
 * otherwise fall through to the LLM as a literal).
 *
 * The character class is deliberately wider than Pi's `^[a-z0-9-]+$` name
 * validation: Mcode skills may carry uppercase/underscores, and validation
 * failure only produces a *warning* (the skill still loads with its original
 * name), so we must match the raw name. The trailing negative lookahead
 * `(?![A-Za-z0-9_-])` stops the match at the token boundary so `/pdf-docs more`
 * isn't mistaken for skill `pdf` followed by `-docs`.
 */
export function rewriteSkillPrefix(text: string, knownNames: Set<string>): string {
  if (!text.startsWith("/")) return text;
  // `/skill:name` is already Pi-native — leave it (and don't double-rewrite if
  // the user happened to type it literally). Also avoid matching `//` or path-
  // like prefixes.
  if (text.startsWith("/skill:")) return text;
  const m = text.match(/^\/([A-Za-z0-9][A-Za-z0-9_-]*)/);
  if (!m) return text;
  const name = m[1];
  if (!knownNames.has(name)) return text;
  // Preserve the boundary after the name (space, end, etc.) — only the leading
  // `/name` token is rewritten to `/skill:name`.
  return `/skill:${name}${text.slice(1 + name.length)}`;
}

/* ──────────────────── Windows WSL-path defense ──────────────────── */

/**
 * Translate a WSL-style `/mnt/<drive>/...` path to a native Windows
 * `<DRIVE>:\...` path. Returns the original string unchanged when it isn't a
 * `/mnt/<drive>/...` form.
 *
 * This is the read-side counterpart of `normalizeToolFilePath` in
 * `fileSnapshot.ts`, but stripped to JUST the WSL→Windows translation: read is
 * a non-mutating operation that legitimately reaches outside the project
 * (skills live under `~/.mcode/skills`, docs under `~/Documents`, …), so the
 * strict in-project guard that file-write tools enforce must NOT apply here.
 *
 * Root cause being mitigated: the Pi SDK injects skill `filePath`/`baseDir`
 * verbatim as native Windows paths (`agent-session.js:959`), but the model —
 * trained on Linux/WSL examples — rewrites them to `/mnt/c/...` when it later
 * issues a `read`. The SDK's read tool does zero `/mnt/` normalization (the
 * raw string reaches `fs.readFile` and fails), so we patch the path before
 * delegating.
 */
export function wslToWindowsPath(p: string): string {
  const wsl = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);
  if (!wsl) return p;
  return `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, "\\")}`;
}

/**
 * Wrap the SDK's built-in `read` tool so any WSL-style `/mnt/<drive>/...`
 * argument is translated to a native Windows path before the wrapped execute
 * runs. Mirrors `createGuardedFileTools` in this provider: a same-name
 * `customTools` entry overrides the built-in (`definitionRegistry.set`), and
 * the override is a pure passthrough when the path isn't a `/mnt/` form.
 *
 * Built from `sdk.createReadToolDefinition(cwd)` so the wrapped tool keeps the
 * SDK lazy-loaded (no module-level import that would pull it into startup).
 *
 * The `any`-parameterized type mirrors `AnyToolDef` in
 * `PiAgentSdkProvider.createGuardedFileTools`: the SDK's concrete read schema
 * (`typeof readSchema`) doesn't structurally satisfy a fully-generic
 * `ToolDefinition` because `renderCall`/`renderResult` are contravariant in
 * their args, so we widen to `ToolDefinition<any, any, any>` for the override.
 */
export function createMntNormalizingReadTool(
  sdk: PiSdk,
  cwd: string,
): import("@earendil-works/pi-coding-agent").ToolDefinition<any, any, any> {
  type AnyToolDef = import("@earendil-works/pi-coding-agent").ToolDefinition<any, any, any>;
  const base = sdk.createReadToolDefinition(cwd) as AnyToolDef;
  return {
    ...base,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const raw = (params as { path?: unknown } | null | undefined)?.path;
      if (typeof raw === "string" && raw.length > 0) {
        const fixed = wslToWindowsPath(raw);
        if (fixed !== raw) {
          params = { ...(params as object), path: fixed };
        }
      }
      return base.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/**
 * System-prompt hints for the Pi agent's bash environment now live in
 * `@main/lib/bashEnv.ts` (`bashPathHintFor` + `detectBashEnv("pi")`) — the
 * detector mirrors the SDK's `getShellConfig` resolution, and the hint text
 * differs between native Windows bash and WSL bash (the two shells genuinely
 * differ in which path forms resolve). The `createMntNormalizingReadTool`
 * defense-in-depth recovers silently when the model still emits a `/mnt/`
 * path, but the hint cuts how often that happens (and also covers
 * Bash-redirected reads, which the tool override can't intercept).
 */
