/* 把 src/ 下的模块拼成单文件 prototypes/settings-redesign.html。
 * 无外部依赖:只做「去掉 import/export 关键字 + 按依赖顺序拼接」的极简打包,
 * 并做一次语法检查(node --check),避免稿子打开是白屏。
 *   node prototypes/settings-redesign/build.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "src");
const read = (f) => readFileSync(join(src, f), "utf8");

/* 依赖顺序:被依赖的先出现(拼接后是同一作用域的声明) */
const MODULES = ["icons.js", "data.js", "primitives.js", "blocks.js", "render.js", "app.js"];

const strip = (code) =>
  code
    .replace(/^\s*import\s+[^;]*?;\s*$/gm, "")
    .replace(/^\s*import\s+"[^"]*";\s*$/gm, "")
    .replace(/^export\s+(const|let|function|class)\b/gm, "$1")
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, "");

const bundle = MODULES.map((m) => `\n/* ── ${m} ── */\n${strip(read(m))}`).join("\n");

/* 语法自检:解析失败就直接失败,不要产出白屏稿 */
const tmp = join(here, ".bundle.check.js");
writeFileSync(tmp, bundle);
try {
  execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
} catch (err) {
  console.error("语法检查失败:\n" + (err.stderr?.toString() || err.message));
  process.exit(1);
}

const html = read("shell.html")
  .replace("/*__CSS__*/", () => read("app.css"))
  .replace("/*__JS__*/", () => `\n${bundle}\n`);

const out = join(here, "..", "settings-redesign.html");
writeFileSync(out, html);

import { rmSync } from "node:fs";
rmSync(tmp);
console.log(`✓ ${out}  ${(html.length / 1024).toFixed(0)} KB  (${html.split("\n").length} 行)`);
