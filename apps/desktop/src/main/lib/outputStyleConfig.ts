/**
 * Output-style discovery + selection for Claude sessions (settings panel).
 *
 * An "output style" rewrites the claude CLI's system prompt to change HOW the
 * model responds. The CLI takes it as the `outputStyle` setting — passed per
 * turn on `--settings` by ClaudeAgentSdkProvider (read per-turn because the
 * CLI reads the style once at session start and has no runtime switch). The
 * CLI matches style names exactly:
 *  - built-ins: "default" (lowercase), "Explanatory", "Learning",
 *    "Proactive", "Concise" (verified against the 2.1.220 binary strings and
 *    live probes; an unknown name is NOT fatal — the CLI falls back to the
 *    default style);
 *  - custom: the frontmatter `name` of a markdown file under
 *    ~/.mcode/output-styles/ (the user scope under the redirected
 *    CLAUDE_CONFIG_DIR — files in ~/.claude are invisible to Mcode sessions).
 *    Verified live: frontmatter names containing spaces match verbatim.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_OUTPUT_STYLE_SETTING_KEY,
  type OutputStyleEntry,
} from "@contracts/ipc";
import { MCODE_CONFIG_DIR } from "@main/providers/claude-sdk/customEnv.js";
import { probeClaudeCliVersion, resolveClaudeExecutable } from "@main/lib/claudeExecutable.js";
import { awaitDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";

/** User-scope output-style directory under Mcode's redirected config root. */
const USER_STYLE_DIR = join(MCODE_CONFIG_DIR, "output-styles");

/** Built-in styles shipped inside the claude binary. `minCliVersion` gates
 *  styles the user's CLI may predate (Concise landed in 2.1.237) so the panel
 *  never offers a style the running CLI would silently ignore. */
const BUILTIN_STYLES: Array<{ id: string; minCliVersion?: string }> = [
  { id: "default" },
  { id: "Explanatory" },
  { id: "Learning" },
  { id: "Proactive" },
  { id: "Concise", minCliVersion: "2.1.237" },
];

/** Compare dotted numeric versions ("2.1.218" >= "2.1.237" → false). */
function versionAtLeast(actual: string, min: string): boolean {
  const a = actual.split(".").map((n) => parseInt(n, 10) || 0);
  const b = min.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Version of the user's Claude CLI (`claude --version`, cached), or null
 *  when it is not installed / unreadable — then no gating (an unknown style
 *  falls back harmlessly). */
async function cliVersion(): Promise<string | null> {
  const executable = resolveClaudeExecutable();
  if (!executable) return null;
  return probeClaudeCliVersion(executable).catch(() => null);
}

/**
 * Parse the YAML frontmatter of an output-style markdown file. Same
 * hand-rolled line scan as skills.ts (we only need `name` / `description`,
 * no yaml dependency).
 */
function parseStyleFrontmatter(md: string): { name?: string; description?: string } {
  if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) return {};
  const lines = md.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return {};
  const out: { name?: string; description?: string } = {};
  for (const raw of lines.slice(1, end)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (m[1].toLowerCase() === "name" && val) out.name = val;
    else if (m[1].toLowerCase() === "description" && val) out.description = val;
  }
  return out;
}

/** Scan ~/.mcode/output-styles/*.md. The frontmatter `name` is the value the
 *  CLI matches on; the filename (sans extension) is the fallback when the
 *  file has no frontmatter name. Unreadable files degrade to that same
 *  fallback instead of failing the whole list. */
function listUserStyles(): OutputStyleEntry[] {
  let files: string[];
  try {
    files = readdirSync(USER_STYLE_DIR);
  } catch {
    return []; // directory missing — no custom styles yet
  }
  const out: OutputStyleEntry[] = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    const fallback = file.replace(/\.md$/i, "");
    let name = fallback;
    let description: string | undefined;
    try {
      const fm = parseStyleFrontmatter(readFileSync(join(USER_STYLE_DIR, file), "utf-8"));
      if (fm.name?.trim()) name = fm.name.trim();
      description = fm.description?.trim() || undefined;
    } catch {
      /* unreadable — keep the filename fallback */
    }
    out.push(description ? { id: name, source: "user", description } : { id: name, source: "user" });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** All selectable styles for the settings panel: version-gated built-ins in
 *  declared order, then user styles sorted by name. A user style whose name
 *  equals a built-in id shadows it (the injected value is just the name, and
 *  duplicate Select values would be ambiguous). */
export async function listOutputStyles(): Promise<OutputStyleEntry[]> {
  const version = await cliVersion();
  const userStyles = listUserStyles();
  const userIds = new Set(userStyles.map((s) => s.id));
  const builtins = BUILTIN_STYLES.filter(
    (s) =>
      !userIds.has(s.id) && (!s.minCliVersion || !version || versionAtLeast(version, s.minCliVersion)),
  ).map((s): OutputStyleEntry => ({ id: s.id, source: "builtin" }));
  return [...builtins, ...userStyles];
}

/** The persisted selection (AGENT_OUTPUT_STYLE_SETTING_KEY). Empty/null =
 * never configured → inject nothing. */
export async function getOutputStyleSetting(): Promise<string | null> {
  await awaitDb();
  return SettingRepo.get(AGENT_OUTPUT_STYLE_SETTING_KEY) || null;
}
