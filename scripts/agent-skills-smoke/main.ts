/**
 * Headless smoke for the project-level agent-skill drop-in sources
 * (`.agent/skills` + `.agents/skills`):
 *
 *   1. lib/agentSkills.ts — resolveAgentSkillInjections (dir listing rules:
 *      dot-prefixed / file entries skipped, empty/missing → null, hooks
 *      detection, per-root namespace = dir basename, `.agents` wins the
 *      qualifiedNames collision), agentSkillsRoots, and agentSkillEditRoot
 *      (edit in place → existing root → canonical `.agent/skills`).
 *   2. ipc/skills.ts — listSkillsForProject's "agent" scan across both
 *      roots: agent-source skills are named by DIRECTORY name (the CLI
 *      registers plugin-adopted skills as `<ns>:<dirName>`, frontmatter
 *      `name` is ignored — so the listing must match), the drop-in roots
 *      override a same-named `.claude/skills` skill, `.agents` wins a
 *      same-name collision between the two drop-in roots, project source
 *      still prefers frontmatter `name`, and the display sort is
 *      project → agent → global.
 *   3. readSkillForProject — the "agent" source resolves from either root
 *      and is guarded by the known-project check like "project".
 *
 * No Electron, no DB, no SDK: repositories/logger/pluginManager are stubbed
 * (stubs.ts) and the fixtures live in a mkdtemp dir. Assertions target only
 * `zzsmoke*`-prefixed names so a real ~/.mcode/skills on the dev machine can
 * never collide.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentSkillEditRoot,
  agentSkillsRoot,
  agentSkillsRoots,
  resolveAgentSkillInjections,
} from "@main/lib/agentSkills.js";
import { listSkillsForProject, readSkillForProject } from "@main/ipc/skills.js";
import { setSmokeProjects } from "./stubs.js";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) passed++;
  else failures.push(label);
}
function eq(a: unknown, b: unknown, label: void | string): void {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa === sb) passed++;
  else failures.push(`${String(label)} — got ${sa}, want ${sb}`);
}

/* ── 1. agentSkillsRoots + resolveAgentSkillInjections ── */

eq(
  agentSkillsRoots("C:\\proj").map((p) => p.replace(/\\/g, "/")),
  ["C:/proj/.agents/skills", "C:/proj/.agent/skills"],
  "agentSkillsRoots = [.agents, .agent] priority order",
);
eq(agentSkillsRoot("C:\\proj").replace(/\\/g, "/"), "C:/proj/.agent/skills", "agentSkillsRoot stays the canonical .agent/skills");

const base = mkdtempSync(join(tmpdir(), "mcode-agent-skills-smoke-"));
try {
  eq(await resolveAgentSkillInjections(join(base, "missing")), null, "missing cwd → null");

  const emptyProj = join(base, "empty");
  mkdirSync(join(emptyProj, ".agent", "skills"), { recursive: true });
  eq(await resolveAgentSkillInjections(emptyProj), null, "empty skills dir → null");

  // The cross-tool `.agents` (plural) root alone — the shape skills dropped
  // in from Zcode & friends produce.
  const pluralProj = join(base, "plural");
  const pluralSkills = join(pluralProj, ".agents", "skills");
  mkdirSync(join(pluralSkills, "zzsmoke-plural"), { recursive: true });
  writeFileSync(join(pluralSkills, "zzsmoke-plural", "SKILL.md"), "---\nname: IGNORED\ndescription: d\n---\nbody");
  const pluralInj = await resolveAgentSkillInjections(pluralProj);
  ok(pluralInj != null, ".agents-only project → injection found");
  eq(pluralInj?.plugins.length, 1, ".agents-only → one plugin");
  eq(pluralInj?.plugins[0]?.dir.replace(/\\/g, "/"), pluralProj.replace(/\\/g, "/") + "/.agents", ".agents-only → dir points at <cwd>/.agents");
  eq(pluralInj?.plugins[0]?.namespace, ".agents", "namespace = dir basename (.agents)");
  eq(pluralInj?.plugins[0]?.names.has("zzsmoke-plural"), true, "plural root lists its skill dir");
  eq(pluralInj?.qualifiedNames.get("zzsmoke-plural"), ".agents:zzsmoke-plural", "qualifiedNames uses the .agents namespace");
  eq(pluralInj?.hasHooks, false, "no hooks.json → hasHooks false");

  // Singular root with a loose file + dot dir — entry rules unchanged.
  const proj = join(base, "proj");
  const skillsDir = join(proj, ".agent", "skills");
  mkdirSync(join(skillsDir, "zzsmoke-real"), { recursive: true });
  writeFileSync(join(skillsDir, "zzsmoke-real", "SKILL.md"), "---\nname: fm-name\ndescription: d\n---\nbody");
  writeFileSync(join(skillsDir, "loose-file.txt"), "not a skill");
  mkdirSync(join(skillsDir, ".hidden"), { recursive: true });
  const inj = await resolveAgentSkillInjections(proj);
  ok(inj != null, "agent injection found");
  eq(inj?.plugins.length, 1, "singular-only → one plugin");
  eq(inj ? [...inj.plugins[0]!.names].sort() : null, ["zzsmoke-real"], "names = skill dirs only (files + dot-dirs skipped)");
  eq(inj?.plugins[0]?.dir.replace(/\\/g, "/"), proj.replace(/\\/g, "/") + "/.agent", "dir points at <cwd>/.agent");
  eq(inj?.plugins[0]?.namespace, ".agent", "singular root → .agent namespace");
  eq(inj?.qualifiedNames.get("zzsmoke-real"), ".agent:zzsmoke-real", "qualifiedNames uses the .agent namespace");

  // Both roots: two plugins, priority order, `.agents` wins name collisions.
  const bothProj = join(base, "both");
  mkdirSync(join(bothProj, ".agents", "skills", "zzsmoke-dupe"), { recursive: true });
  writeFileSync(join(bothProj, ".agents", "skills", "zzsmoke-dupe", "SKILL.md"), "---\ndescription: plural\n---\n");
  mkdirSync(join(bothProj, ".agents", "skills", "zzsmoke-only-plural"), { recursive: true });
  mkdirSync(join(bothProj, ".agent", "skills", "zzsmoke-dupe"), { recursive: true });
  writeFileSync(join(bothProj, ".agent", "skills", "zzsmoke-dupe", "SKILL.md"), "---\ndescription: singular\n---\n");
  mkdirSync(join(bothProj, ".agent", "skills", "zzsmoke-only-singular"), { recursive: true });
  const bothInj = await resolveAgentSkillInjections(bothProj);
  eq(bothInj?.plugins.map((p) => p.namespace), [".agents", ".agent"], "both roots → two plugins, priority order");
  eq(bothInj?.qualifiedNames.get("zzsmoke-dupe"), ".agents:zzsmoke-dupe", "name in both roots → .agents qualifier wins");
  ok(bothInj?.qualifiedNames.has("zzsmoke-only-singular") === true, "singular-only name still qualified");

  const hookProj = join(base, "hooked");
  mkdirSync(join(hookProj, ".agents", "skills", "s"), { recursive: true });
  mkdirSync(join(hookProj, ".agents", "hooks"), { recursive: true });
  writeFileSync(join(hookProj, ".agents", "hooks", "hooks.json"), "{}");
  eq((await resolveAgentSkillInjections(hookProj))?.hasHooks, true, "hooks.json in .agents → hasHooks true");

  // Edit-root resolution: in place → existing convention → canonical.
  eq(
    (await agentSkillEditRoot(bothProj, "zzsmoke-dupe")).replace(/\\/g, "/"),
    bothProj.replace(/\\/g, "/") + "/.agents/skills",
    "edit root = the .agents root carrying the skill",
  );
  eq(
    (await agentSkillEditRoot(bothProj, "zzsmoke-only-singular")).replace(/\\/g, "/"),
    bothProj.replace(/\\/g, "/") + "/.agent/skills",
    "edit root = the .agent root carrying the skill",
  );
  const pluralOnlyEdit = await agentSkillEditRoot(pluralProj, "zzsmoke-new");
  eq(pluralOnlyEdit.replace(/\\/g, "/"), pluralProj.replace(/\\/g, "/") + "/.agents/skills", "new skill in a .agents project → .agents root (project convention)");
  eq(
    (await agentSkillEditRoot(join(base, "fresh"), "zzsmoke-new")).replace(/\\/g, "/"),
    join(base, "fresh").replace(/\\/g, "/") + "/.agent/skills",
    "new skill with no drop-in dirs → canonical .agent/skills",
  );

  /* ── 2. listSkillsForProject: the agent scan ── */

  const project = join(base, "listed");
  mkdirSync(join(project, ".claude", "skills", "zzsmokeboth"), { recursive: true });
  // No frontmatter name → project listing falls back to the dir name, so the
  // agent entry below (always dir-named) collides and must override it.
  writeFileSync(join(project, ".claude", "skills", "zzsmokeboth", "SKILL.md"), "---\ndescription: from claude dir\n---\nclaude-body");
  mkdirSync(join(project, ".claude", "skills", "zzsmokefmname"), { recursive: true });
  writeFileSync(join(project, ".claude", "skills", "zzsmokefmname", "SKILL.md"), "---\nname: zzsmokefmname-fm\ndescription: d\n---\n");
  mkdirSync(join(project, ".agent", "skills", "zzsmokeboth"), { recursive: true });
  writeFileSync(join(project, ".agent", "skills", "zzsmokeboth", "SKILL.md"), "---\nname: IGNORED\ndescription: from agent dir\n---\nagent-body");
  mkdirSync(join(project, ".agent", "skills", "zzsmokefmname2"), { recursive: true });
  writeFileSync(join(project, ".agent", "skills", "zzsmokefmname2", "SKILL.md"), "---\nname: zzsmokefmname2-fm\ndescription: d\n---\n");
  // The plural root: its own skill plus a same-name collision the `.agents`
  // entry must win.
  mkdirSync(join(project, ".agents", "skills", "zzsmokeplural"), { recursive: true });
  writeFileSync(join(project, ".agents", "skills", "zzsmokeplural", "SKILL.md"), "---\nname: IGNORED\ndescription: from plural dir\n---\nplural-body");
  mkdirSync(join(project, ".agents", "skills", "zzsmokeboth"), { recursive: true });
  writeFileSync(join(project, ".agents", "skills", "zzsmokeboth", "SKILL.md"), "---\nname: IGNORED\ndescription: from plural dir\n---\nplural-body");

  setSmokeProjects([{ id: "p1", path: project }]);
  const skills = await listSkillsForProject(project);
  const smoke = skills.filter((s) => s.name.startsWith("zzsmoke"));

  const both = smoke.filter((s) => s.name === "zzsmokeboth");
  eq(both.length, 1, "same-name project+agent skills dedupe to one entry");
  eq(both[0]?.source, "agent", "agent roots override .claude/skills for the same name");
  eq(both[0]?.description, "from plural dir", ".agents wins the same-name collision between the drop-in roots");

  eq(
    smoke.find((s) => s.name === "zzsmokefmname-fm")?.source,
    "project",
    "project source still prefers frontmatter name",
  );
  eq(
    smoke.find((s) => s.name === "zzsmokefmname2")?.source,
    "agent",
    "agent source lists by DIRECTORY name (frontmatter name ignored)",
  );
  eq(smoke.find((s) => s.name === "zzsmokeplural")?.source, "agent", ".agents-only skill listed under the agent source");

  // Display order: project entries before agent entries before global ones.
  const idxProject = skills.findIndex((s) => s.name === "zzsmokefmname-fm");
  const idxAgent1 = skills.findIndex((s) => s.name === "zzsmokeboth");
  const idxAgent2 = skills.findIndex((s) => s.name === "zzsmokefmname2");
  ok(idxProject < idxAgent1 && idxAgent1 <= idxAgent2, "sort order project → agent (alphabetical)");

  /* ── 3. readSkillForProject for the agent source ── */

  const content = await readSkillForProject(project, "agent", "zzsmokeboth");
  ok(content.includes("plural-body"), "read resolves the .agents copy (priority winner)");
  ok((await readSkillForProject(project, "agent", "zzsmokefmname2")).includes("zzsmokefmname2-fm"), "read falls through to the .agent root");
  eq(await readSkillForProject(join(base, "not-a-project"), "agent", "zzsmokeboth"), "", "agent read on unknown project → empty");

  /* ── report ── */
  if (failures.length > 0) {
    console.error(`agent-skills-smoke: ${failures.length}/${passed + failures.length} FAILED`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`agent-skills-smoke: ${passed}/${passed} passed`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
