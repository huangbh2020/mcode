/** Stubs for the electron-adjacent modules agent-skills-smoke must neutralize.
 *  Everything here is imported by the modules under test via @main/* aliases
 *  (see run.sh) and replaced by these pure-node stand-ins. */

/** Mutable fixture registry — main.ts points ProjectRepo.list() at the temp
 *  project root before exercising the skills scan. */
let projects: Array<{ id: string; path: string }> = [];

export const ProjectRepo = {
  list(): Array<{ id: string; path: string }> {
    return projects;
  },
};

/** main.ts calls this to register the temp project fixture. */
export function setSmokeProjects(list: Array<{ id: string; path: string }>): void {
  projects = list;
}

/** skills.ts only calls log.warn (defensive scan-failure path). */
export const log = {
  warn: (_msg: string) => {},
  info: (_msg: string) => {},
  error: (_msg: string) => {},
};

/** No enabled plugins in the smoke — plugin roots would only add entries. */
export async function getEnabledPluginSkillRoots(): Promise<string[]> {
  return [];
}
