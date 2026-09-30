/**
 * Headless smoke for the project-level `.agent/skills` skill source:
 *
 *   1. lib/agentSkills.ts — resolveAgentSkillInjection (dir listing rules:
 *      dot-prefixed / file entries skipped, empty/missing → null, hooks
 *      detection) and agentSkillsRoot.
 *   2. ipc/skills.ts — listSkillsForProject's new "agent" scan: agent-source
 *      skills are named by DIRECTORY name (the CLI registers plugin-adopted
 *      skills as `.agent:<dirName>`, frontmatter `name` is ignored — so the
 *      listing must match), agent root overrides a same-named `.claude/skills`
 *      skill, project source still prefers frontmatter `name`, and the
 *      display sort is project → agent → global.
 *   3. readSkillForProject — the "agent" source resolves and is guarded by
 *      the known-project check like "project".
 *
 * No Electron, no DB, no SDK: repositories/logger/pluginManager are stubbed
 * (stubs.ts) and the fixtures live in a mkdtemp dir. Assertions target only
 * `zzsmoke*`-prefixed names so a real ~/.mcode/skills on the dev machine can
 * never collide.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSkillsRoot, resolveAgentSkillInjection } from "@main/lib/agentSkills.js";
import { listSkillsForProject, readSkillForProject } from "@main/ipc/skills.js";
import { setSmokeProjects } from "./stubs.js";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) passed++;
  else failures.push(label);
}
function eq(a: unknown, b: unknown, label: string): void {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa === sb) passed++;
  else failures.push(`${label} — got ${sa}, want ${sb}`);
}

/* ── 1. agentSkillsRoot + resolveAgentSkillInjection ── */

eq(agentSkillsRoot("C:\\proj").replace(/\\/g, "/"), "C:/proj/.agent/skills", "agentSkillsRoot joins .agent/skills");

const base = mkdtempSync(join(tmpdir(), "mcode-agent-skills-smoke-"));
try {
  eq(await resolveAgentSkillInjection(join(base, "missing")), null, "missing cwd → null");

  const emptyProj = join(base, "empty");
  mkdirSync(join(emptyProj, ".agent", "skills"), { recursive: true });
  eq(await resolveAgentSkillInjection(emptyProj), null, "empty skills dir → null");

  const proj = join(base, "proj");
  const skillsDir = join(proj, ".agent", "skills");
  mkdirSync(join(skillsDir, "real-skill"), { recursive: true });
  writeFileSync(join(skillsDir, "real-skill", "SKILL.md"), "---\nname: fm-name\ndescription: d\n---\nbody");
  writeFileSync(join(skillsDir, "loose-file.txt"), "not a skill");
  mkdirSync(join(skillsDir, ".hidden"), { recursive: true });
  const inj = await resolveAgentSkillInjection(proj);
  ok(inj != null, "agent injection found");
  eq(inj ? [...inj.names].sort() : null, ["real-skill"], "names = skill dirs only (files + dot-dirs skipped)");
  eq(inj?.dir.replace(/\\/g, "/"), proj.replace(/\\/g, "/") + "/.agent", "dir points at <cwd>/.agent");
  eq(inj?.hasHooks, false, "no hooks.json → hasHooks false");

  const hookProj = join(base, "hooked");
  mkdirSync(join(hookProj, ".agent", "skills", "s"), { recursive: true });
  mkdirSync(join(hookProj, ".agent", "hooks"), { recursive: true });
  writeFileSync(join(hookProj, ".agent", "hooks", "hooks.json"), "{}");
  eq((await resolveAgentSkillInjection(hookProj))?.hasHooks, true, "hooks.json present → hasHooks true");

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

  setSmokeProjects([{ id: "p1", path: project }]);
  const skills = await listSkillsForProject(project);
  const smoke = skills.filter((s) => s.name.startsWith("zzsmoke"));

  const both = smoke.filter((s) => s.name === "zzsmokeboth");
  eq(both.length, 1, "same-name project+agent skills dedupe to one entry");
  eq(both[0]?.source, "agent", "agent root overrides .claude/skills for the same name");
  eq(both[0]?.description, "from agent dir", "agent entry carries the agent SKILL.md metadata");

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

  // Display order: project entries before agent entries before global ones.
  const idxProject = skills.findIndex((s) => s.name === "zzsmokefmname-fm");
  const idxAgent1 = skills.findIndex((s) => s.name === "zzsmokeboth");
  const idxAgent2 = skills.findIndex((s) => s.name === "zzsmokefmname2");
  ok(idxProject < idxAgent1 && idxAgent1 <= idxAgent2, "sort order project → agent (alphabetical)");

  /* ── 3. readSkillForProject for the agent source ── */

  const content = await readSkillForProject(project, "agent", "zzsmokeboth");
  ok(content.includes("agent-body"), "read agent skill returns its SKILL.md");
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
