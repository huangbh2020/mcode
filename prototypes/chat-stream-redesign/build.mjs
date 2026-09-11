/* 把 src/ 下的模块拼成单文件 prototypes/chat-stream-redesign.html。
 * 与 settings-redesign 同一配方:去掉 import/export 关键字后按依赖顺序拼接,
 * 拼完做一次 node --check,避免稿子打开是白屏。
 *   node prototypes/chat-stream-redesign/build.mjs
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "src");
const read = (f) => readFileSync(join(src, f), "utf8");

/* 依赖顺序:被依赖的先出现(拼接后是同一作用域的声明) */
const MODULES = ["icons.js", "data.js", "primitives.js", "blocks.js", "app.js"];

const strip = (code) =>
  code
    .replace(/^\s*import\s+[^;]*?;\s*$/gm, "")
    .replace(/^\s*import\s+"[^"]*";\s*$/gm, "")
    .replace(/^export\s+(const|let|function|class)\b/gm, "$1")
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, "");

const bundle = MODULES.map((m) => `\n/* ── ${m} ── */\n${strip(read(m))}`).join("\n");

const tmp = join(here, ".bundle.check.js");
writeFileSync(tmp, bundle);
try {
  execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
} catch (err) {
  console.error("语法检查失败:\n" + (err.stderr?.toString() || err.message));
  process.exit(1);
}
rmSync(tmp);

const html = read("shell.html")
  .replace("/*__CSS__*/", () => read("app.css"))
  .replace("/*__JS__*/", () => `\n${bundle}\n\nboot();\n`);

const out = join(here, "..", "chat-stream-redesign.html");
writeFileSync(out, html);
console.log(`✓ ${out}  ${(html.length / 1024).toFixed(0)} KB  (${html.split("\n").length} 行)`);
