/**
 * Headless smoke test for the plugin subsystem (docs/plugin-feasibility.md v1).
 *
 * Covers: manifest discovery across the three layouts, component summaries
 * (skills/commands/agents/hooks/MCP), install from local dir / zip / git /
 * marketplace, enable+delivery queries (skill roots, namespaced MCP entries,
 * per-server denylist), path-escape guards, uninstall cleanup, and
 * marketplace add/list/refresh/remove.
 *
 * Run via run.sh: esbuild-bundled with SettingRepo stubbed (stub-repositories)
 * and HOME redirected to a scratch dir, so ~/.mcode/plugins is faked.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SettingRepo } from "./stub-repositories.js";

import {
  findPluginManifest,
  pluginSkillsDir,
  summarizeComponents,
} from "../../src/main/plugins/pluginManifest.js";
import {
  installFromLocal,
  installFromGit,
  installFromMarketplace,
  setPluginEnabled,
  removePlugin,
  listPlugins,
  getEnabledPlugins,
  getEnabledPluginSkillRoots,
  getPluginMcpServers,
  setPluginMcpDisabled,
  listPluginMcpPanelEntries,
  addMarketplace,
  listMarketplaces,
  refreshMarketplace,
  removeMarketplace,
} from "../../src/main/plugins/pluginManager.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, extra = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`);
  }
}
function eq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, label, a === e ? "" : `got ${a}, want ${e}`);
}

/* ── fixtures ── */

const base = path.join(tmpdir(), `mcode-plugins-smoke-${Date.now()}`);
const fixtureDir = path.join(base, "fixtures");
mkdirSync(path.join(fixtureDir, "demo-plugin", ".claude-plugin"), { recursive: true });
mkdirSync(path.join(fixtureDir, "demo-plugin", "skills", "pdf-helper"), { recursive: true });
mkdirSync(path.join(fixtureDir, "demo-plugin", "skills", "web-tester"), { recursive: true });
mkdirSync(path.join(fixtureDir, "demo-plugin", "commands"), { recursive: true });
mkdirSync(path.join(fixtureDir, "demo-plugin", "agents"), { recursive: true });
mkdirSync(path.join(fixtureDir, "demo-plugin", "hooks"), { recursive: true });

writeFileSync(
  path.join(fixtureDir, "demo-plugin", ".claude-plugin", "plugin.json"),
  JSON.stringify(
    {
      name: "demo-plugin",
      version: "1.2.3",
      description: "Smoke demo plugin",
      author: { name: "smoke" },
    },
    null,
    2,
  ),
);
writeFileSync(
  path.join(fixtureDir, "demo-plugin", "skills", "pdf-helper", "SKILL.md"),
  `---
name: pdf-helper
description: Generate PDF documents
---
# pdf-helper`,
);
writeFileSync(
  path.join(fixtureDir, "demo-plugin", "skills", "web-tester", "SKILL.md"),
  `---
name: web-tester
description: GUI web testing
---
body`,
);
writeFileSync(
  path.join(fixtureDir, "demo-plugin", "commands", "deploy-check.md"),
  `---
description: Pre-deploy verification
---
Run these checks`,
);
writeFileSync(
  path.join(fixtureDir, "demo-plugin", "agents", "code-reviewer.md"),
  `---
description: Reviews code changes
---
You are a reviewer`,
);
writeFileSync(
  path.join(fixtureDir, "demo-plugin", "hooks", "hooks.json"),
  JSON.stringify(
    {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] },
      ],
      PostToolUse: [{ hooks: [{ type: "command", command: "npm run lint" }] }],
    },
    null,
    2,
  ),
);
writeFileSync(
  path.join(fixtureDir, "demo-plugin", ".mcp.json"),
  JSON.stringify({ mcpServers: { fetcher: { command: "node", args: ["server.js"] } } }, null, 2),
);

/* marketplace fixture with a relative-path entry + a github entry. Relative
 * sources resolve INSIDE the marketplace tree, so the plugin dir is copied in. */
const mpDir = path.join(fixtureDir, "marketplace");
mkdirSync(path.join(mpDir, ".claude-plugin"), { recursive: true });
execSync(`cp -R "${path.join(fixtureDir, "demo-plugin")}" "${mpDir}/"`);
writeFileSync(
  path.join(mpDir, ".claude-plugin", "marketplace.json"),
  JSON.stringify(
    {
      name: "test-mp",
      owner: "smoke",
      plugins: [
        { name: "demo-plugin", description: "Demo entry", version: "1.2.3", source: "./demo-plugin" },
        { name: "gh-plugin", description: "GitHub entry", source: { source: "github", repo: "octocat/hello" } },
      ],
    },
    null,
    2,
  ),
);

/* git-source fixture: a local repo cloned via file:// */
const gitRepo = path.join(base, "git-repo");
mkdirSync(path.join(gitRepo, ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(gitRepo, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "git-plugin", version: "0.1.0", description: "from git" }),
);
execSync("git init -q . && git add -A && git -c user.email=s@smoke -c user.name=smoke commit -qm init", {
  cwd: gitRepo,
});

/* git-subdir fixture: a repo whose plugin lives in a subdirectory — the
 * official marketplace's dominant shape ({source:"git-subdir", url, path}) */
const subdirRepo = path.join(base, "subdir-repo");
mkdirSync(path.join(subdirRepo, "plugins", "inner", ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(subdirRepo, "plugins", "inner", ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "subdir-plugin", version: "2.2.0", description: "from git-subdir" }),
);
execSync("git init -q . && git add -A && git -c user.email=s@smoke -c user.name=smoke commit -qm init", {
  cwd: subdirRepo,
});

/* official-style marketplace: git-subdir + url + one UNKNOWN source shape —
 * the unknown entry must be skipped without blanking the catalog */
const officialMpDir = path.join(fixtureDir, "official-mp");
mkdirSync(path.join(officialMpDir, ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(officialMpDir, ".claude-plugin", "marketplace.json"),
  JSON.stringify({
    name: "official-style",
    owner: { name: "smoke" },
    renames: { old: "new-name" },
    plugins: [
      {
        name: "subdir-plugin",
        description: "git-subdir entry",
        category: "dev",
        source: {
          source: "git-subdir",
          url: `file://${subdirRepo}`,
          path: "plugins/inner",
          ref: undefined,
          sha: "deadbeef",
        },
      },
      {
        name: "remote-plugin",
        description: "url entry (not installed in smoke)",
        source: { source: "url", url: "https://example.com/x.zip" },
      },
      {
        name: "future-shape",
        description: "unknown source shape",
        source: { source: "npm", package: "some-plugin" },
      },
    ],
  }),
);

/* zcode-layout plugin (manifest at .zcode-plugin) */
mkdirSync(path.join(fixtureDir, "zcode-plugin", ".zcode-plugin"), { recursive: true });
writeFileSync(
  path.join(fixtureDir, "zcode-plugin", ".zcode-plugin", "plugin.json"),
  JSON.stringify({ name: "zcode-plugin", version: "2.0.0" }),
);

/* escaping-manifest plugin (component path must be rejected) */
mkdirSync(path.join(fixtureDir, "escape-plugin", ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(fixtureDir, "escape-plugin", ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "escape-plugin", skills: "../../fixtures/demo-plugin/skills" }),
);

/* invalid-name plugin (zod must reject) */
mkdirSync(path.join(fixtureDir, "badname-plugin", ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(fixtureDir, "badname-plugin", ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "../evil" }),
);

/* monorepo layout: README + LICENSE (flat files) + one plugin dir — the
 * official-repo shape where the plugin lives in a child directory */
mkdirSync(path.join(fixtureDir, "mono-repo", "plugin", ".claude-plugin"), { recursive: true });
writeFileSync(path.join(fixtureDir, "mono-repo", "README.md"), "# mono-repo\n");
writeFileSync(path.join(fixtureDir, "mono-repo", "LICENSE"), "MIT");
writeFileSync(
  path.join(fixtureDir, "mono-repo", "plugin", ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "mono-plugin", version: "1.0.0", description: "from monorepo" }),
);

/* multi-plugin repo (two plugin children) — must name candidates, not install */
for (const sub of ["a", "b"]) {
  mkdirSync(path.join(fixtureDir, "multi-repo", sub, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(fixtureDir, "multi-repo", sub, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: `multi-${sub}`, version: "1.0.0" }),
  );
}

/* nested wrapper chain: wrap2/wrap/plugin/ (double archive nesting) */
mkdirSync(path.join(fixtureDir, "wrap2", "wrap", "plugin", ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(fixtureDir, "wrap2", "wrap", "plugin", ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "nested-plugin", version: "0.0.1" }),
);

/* zip of demo-plugin (wrapped in a top-level dir, GitHub-style) */
const zipPath = path.join(base, "demo-plugin.zip");
execSync(`zip -qr "${zipPath}" demo-plugin`, { cwd: fixtureDir });

/* ── 1. manifest discovery + component summary ── */
console.log("\n[1] manifest discovery & component summary");
const demoRoot = path.join(fixtureDir, "demo-plugin");
const resolved = findPluginManifest(demoRoot);
ok(resolved != null, "finds .claude-plugin manifest");
eq(resolved?.manifestDir, ".claude-plugin", "manifestDir is .claude-plugin");
eq(resolved?.manifest.name, "demo-plugin", "manifest name");

const comps = summarizeComponents(demoRoot, resolved!.manifest);
eq(
  comps.skills.map((s) => s.name),
  ["pdf-helper", "web-tester"],
  "skills parsed (2)",
);
ok(
  comps.skills[0].description === "Generate PDF documents",
  "skill description from frontmatter",
);
eq(comps.commands.length, 1, "commands parsed (1)");
eq(comps.commands[0].name, "deploy-check", "command name = file basename");
eq(comps.agents.length, 1, "agents parsed (1)");
eq(comps.hooks.length, 2, "hooks parsed (2)");
ok(comps.hooks[0].matcher === "Bash" && comps.hooks[0].command === "echo pre", "hook matcher+command");
eq(comps.mcpServers.length, 1, "mcp servers parsed (1)");
eq(comps.mcpServers[0].name, "fetcher", "mcp server name");
eq(comps.mcpServers[0].kind, "stdio", "mcp server kind stdio");
eq(comps.mcpServers[0].detail, "node server.js", "mcp detail is command line");

const zRes = findPluginManifest(path.join(fixtureDir, "zcode-plugin"));
ok(zRes != null && zRes.manifest.name === "zcode-plugin", ".zcode-plugin layout discovered");

const escSkills = pluginSkillsDir(path.join(fixtureDir, "escape-plugin"), {
  name: "escape-plugin",
  skills: "../../fixtures/demo-plugin/skills",
} as never);
ok(escSkills === null, "escaping skills path rejected (in-root guard)");

/* ── 2. install from local dir ── */
console.log("\n[2] install from local directory");
const localInstall = await installFromLocal(demoRoot);
ok(localInstall.ok, "install succeeds");
ok(!!localInstall.plugin, "returns plugin state");
eq(localInstall.plugin?.name, "demo-plugin", "plugin name");
eq(localInstall.plugin?.version, "1.2.3", "plugin version");
ok(!localInstall.plugin?.enabled, "installs DISABLED");
eq(localInstall.plugin?.source.kind, "local-dir", "source kind recorded");
ok(
  existsSync(path.join(localInstall.plugin!.rootDir, ".mcode-install.json")),
  "install record written",
);

/* ── 3. enable + delivery queries ── */
console.log("\n[3] enable + provider delivery queries");
eq(setPluginEnabled("demo-plugin", true).ok, true, "setEnabled ok");
const enabled = await getEnabledPlugins();
eq(enabled.length, 1, "one enabled plugin");
eq(enabled[0].name, "demo-plugin", "enabled name");
ok(enabled[0].hasHooks, "hasHooks true (hooks declared)");
const skillRoots = await getEnabledPluginSkillRoots();
eq(skillRoots.length, 1, "one plugin skill root");
ok(skillRoots[0].endsWith(path.join("demo-plugin", "1.2.3", "skills")), "skill root path");

const mcp = await getPluginMcpServers();
eq(mcp.length, 1, "one namespaced MCP entry");
eq(mcp[0][0], "demo-plugin__fetcher", "MCP name namespaced plugin__server");
eq(mcp[0][1].command, "node", "MCP config carried through");

const panel = await listPluginMcpPanelEntries();
eq(panel.length, 1, "one panel entry");
ok(panel[0].enabled, "panel entry enabled by default");

eq(setPluginMcpDisabled("demo-plugin__fetcher", true).ok, true, "denylist write ok");
eq((await getPluginMcpServers()).length, 0, "denied server excluded from delivery");
eq((await listPluginMcpPanelEntries())[0].enabled, false, "panel reflects disabled");
eq(setPluginMcpDisabled("demo-plugin__fetcher", false).ok, true, "denylist clear ok");
eq((await getPluginMcpServers()).length, 1, "re-enabled server delivered again");

/* ── 4. list state ── */
console.log("\n[4] listPlugins");
const listed = listPlugins();
eq(listed.length, 1, "one installed plugin listed");
eq(listed[0].enabled, true, "enabled flag persisted");
eq(listed[0].components.hooks.length, 2, "components in list");

/* ── 5. zip install (wrapper dir descent + same-version reinstall) ── */
console.log("\n[5] install from zip");
const zipInstall = await installFromLocal(zipPath);
ok(zipInstall.ok, "zip install succeeds", zipInstall.error ?? "");
eq(listPlugins().length, 1, "same-version reinstall replaced (still 1)");
ok((await getEnabledPlugins()).length === 1, "still enabled after reinstall");

/* ── 6. git install ── */
console.log("\n[6] install from git (file://)");
const gitInstall = await installFromGit(`file://${gitRepo}`);
ok(gitInstall.ok, "git install succeeds", gitInstall.error ?? "");
eq(gitInstall.plugin?.name, "git-plugin", "git plugin name");
ok(!existsSync(path.join(gitInstall.plugin!.rootDir, ".git")), ".git stripped from install");

/* ── 7. invalid manifests rejected ── */
console.log("\n[7] invalid plugins rejected");
const badName = await installFromLocal(path.join(fixtureDir, "badname-plugin"));
ok(!badName.ok, "illegal name rejected");
const noManifest = await installFromLocal(path.join(base, "not-a-plugin"));
ok(!noManifest.ok, "missing manifest rejected");
const escapeInstall = await installFromLocal(path.join(fixtureDir, "escape-plugin"));
ok(escapeInstall.ok, "escaping plugin still installs (components guarded)");
eq(escapeInstall.plugin?.components.skills.length, 0, "escaped skills NOT summarized");

/* ── 7b. real-world repository layouts ── */
console.log("\n[7b] repository layout tolerance");
const monoInstall = await installFromLocal(path.join(fixtureDir, "mono-repo"));
ok(monoInstall.ok, "monorepo (README+LICENSE+plugin/) installs inner plugin", monoInstall.error ?? "");
eq(monoInstall.plugin?.name, "mono-plugin", "monorepo plugin name");

const nestedInstall = await installFromLocal(path.join(fixtureDir, "wrap2"));
ok(nestedInstall.ok, "double-nested wrapper installs inner plugin", nestedInstall.error ?? "");
eq(nestedInstall.plugin?.name, "nested-plugin", "nested plugin name");

const multiInstall = await installFromLocal(path.join(fixtureDir, "multi-repo"));
ok(!multiInstall.ok, "multi-plugin repo rejected");
ok(
  (multiInstall.error ?? "").includes("多个插件") &&
    (multiInstall.error ?? "").includes("multi-a") &&
    (multiInstall.error ?? "").includes("multi-b"),
  "multi-plugin error lists candidate names",
  multiInstall.error ?? "",
);

const mpAsPlugin = await installFromLocal(mpDir);
ok(!mpAsPlugin.ok, "marketplace repo rejected as plugin");
ok(
  (mpAsPlugin.error ?? "").includes("插件市场"),
  "marketplace repo error redirects to marketplace flow",
  mpAsPlugin.error ?? "",
);

/* ── 8. marketplace lifecycle ── */
console.log("\n[8] marketplace lifecycle");
const mpAdd = await addMarketplace({ kind: "local", ref: mpDir });
ok(mpAdd.ok, "addMarketplace(local) ok", mpAdd.error ?? "");
const mps = listMarketplaces();
eq(mps.length, 1, "one marketplace listed");
eq(mps[0].name, "test-mp", "marketplace name from manifest");
eq(mps[0].plugins.length, 2, "two catalog entries");
eq(mps[0].plugins[0].installed, true, "demo-plugin entry marked installed");
eq(mps[0].plugins[1].installed, false, "gh-plugin entry not installed");

const mpInstall = await installFromMarketplace("test-mp", "demo-plugin");
ok(mpInstall.ok, "install marketplace entry ok", mpInstall.error ?? "");
eq(mpInstall.plugin?.source.kind, "marketplace", "source kind marketplace");

// github entry resolves to the right git URL (resolved lazily on install).
const ghResolveFail = await installFromMarketplace("test-mp", "gh-plugin");
ok(!ghResolveFail.ok, "github entry install fails (repo unreachable) but source resolved");

const mpRefresh = await refreshMarketplace("test-mp");
ok(mpRefresh.ok, "refresh ok", mpRefresh.error ?? "");

/* official-style marketplace: entry-level tolerance + git-subdir install */
console.log("\n[8b] official-style marketplace (git-subdir / url / unknown shapes)");
const officialAdd = await addMarketplace({ kind: "local", ref: officialMpDir });
ok(officialAdd.ok, "official-style marketplace added", officialAdd.error ?? "");
const allMps = listMarketplaces();
const official = allMps.find((m) => m.name === "official-style");
ok(!!official, "official-style listed");
eq(official?.plugins.length, 2, "unknown source shape skipped, 2 of 3 entries survive");
eq(
  official?.plugins.map((p) => p.name).sort(),
  ["remote-plugin", "subdir-plugin"],
  "git-subdir + url entries listed",
);

const subdirInstall = await installFromMarketplace("official-style", "subdir-plugin");
ok(subdirInstall.ok, "git-subdir entry installs", subdirInstall.error ?? "");
eq(subdirInstall.plugin?.name, "subdir-plugin", "git-subdir plugin name");
eq(subdirInstall.plugin?.version, "2.2.0", "git-subdir plugin version");
ok(subdirInstall.plugin?.source.kind === "marketplace", "git-subdir source kind recorded");
ok(
  !existsSync(path.join(subdirInstall.plugin!.rootDir, ".git")),
  "git-subdir install has no .git",
);
// Only the subdirectory ships — sibling repo content must not leak in.
ok(
  !existsSync(path.join(subdirInstall.plugin!.rootDir, "plugins")),
  "git-subdir installs ONLY the subdirectory",
);

removeMarketplace("official-style");
removePlugin("subdir-plugin");

/* ── 9. remove cleanup ── */
console.log("\n[9] remove cleanup");
setPluginMcpDisabled("demo-plugin__fetcher", true);
eq(removePlugin("demo-plugin").ok, true, "remove ok");
eq((await getEnabledPlugins()).length, 0, "no longer delivered");
eq(
  listPlugins().map((p) => p.name),
  ["escape-plugin", "git-plugin", "mono-plugin", "nested-plugin"],
  "remaining plugins",
);
// denylist cleanup: demo-plugin__ entries dropped by removePlugin
const denylisted = JSON.parse(SettingRepo.__dump()["plugins.mcpDisabled"] ?? "[]");
eq(denylisted.length, 0, "per-plugin MCP denylist cleared on remove");

const mpRemove = removeMarketplace("test-mp");
ok(mpRemove.ok, "marketplace removed");
eq(listMarketplaces().length, 0, "no marketplaces left");

/* ── summary ── */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
