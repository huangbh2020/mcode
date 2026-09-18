/**
 * Headless smoke for the terminal shell resolver's "is the setting honored?"
 * answer (terminal/shellResolve.ts `resolveEffectiveShell`). Pure node — only
 * the logger import is stubbed (run.sh); no Electron, no node-pty, no DB.
 *
 * Why this contract is worth pinning: `terminal.create` falls back to the
 * platform default shell SILENTLY when `terminal.shell` does not resolve (a
 * terminal must always open), so a typo'd path used to be indistinguishable
 * from a working one and the setting looked dead. The settings panel now asks
 * resolveEffectiveShell and reports which shell a new terminal will really
 * spawn — these assertions are that answer's contract.
 */
import { resolveDefaultShell, resolveEffectiveShell } from "@main/terminal/shellResolve.js";
import { warnings } from "./stubs.js";

let failures = 0;
function check(name: string, cond: boolean, detail: string): void {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name} — ${detail}`);
}

const platformDefault = resolveDefaultShell(null).label;

// 1. Empty/absent setting → platform default, flagged "default".
for (const value of ["", "   ", null, undefined]) {
  const r = resolveEffectiveShell(value);
  check(
    `empty(${JSON.stringify(value)}) -> default`,
    r.source === "default" && r.shell.label === platformDefault,
    `${r.shell.label} (${r.source})`,
  );
}

// 2. Unresolvable setting → a shell is still returned (must always open) but
//    the source says "default", and the miss is logged. This is the pair the
//    settings panel turns into a visible warning.
warnings.length = 0;
const bogus = process.platform === "win32" ? "C:\\mcode-smoke-missing\\nope.exe" : "/mcode-smoke-missing/nope";
const miss = resolveEffectiveShell(bogus);
check("bogus -> default", miss.source === "default" && miss.shell.label === platformDefault, `${miss.shell.label} (${miss.source})`);
check(
  "bogus -> warned",
  warnings.some((w) => w.includes("terminal.shell override not found")),
  warnings.length > 0 ? warnings.join(" | ") : "(no warning logged)",
);

// 3. A real executable — the platform default's own path — is honored as the
//    setting: "configured" and "default" are distinguishable.
warnings.length = 0;
const hit = resolveEffectiveShell(platformDefault);
check("real path -> setting", hit.source === "setting", `${hit.shell.label} (${hit.source})`);
check("real path -> same binary", hit.shell.label === platformDefault, hit.shell.label);
check("real path -> no warning", warnings.length === 0, warnings.join(" | ") || "(clean)");

console.log(failures === 0 ? "\nsmoke: all assertions passed" : `\nsmoke: ${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
