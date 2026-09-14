// 渲染小红书配图:每张 1080×1440(2x 输出后降采样)
// 用法:node render.mjs cover full kraft detail workflow
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/maiwy/.claude/skills/gstack/node_modules/playwright-core");

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = join(DIR, "out");
mkdirSync(OUT, { recursive: true });

const shots = process.argv.slice(2);
if (!shots.length) {
  console.error("usage: node render.mjs <shot> [shot...]");
  process.exit(1);
}

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({
  viewport: { width: 1080, height: 1440 },
  deviceScaleFactor: 2,
});

for (const shot of shots) {
  const hi = join(OUT, `${shot}@2x.png`);
  await page.goto(`file://${join(DIR, "render.html")}?shot=${shot}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: hi });

  const final = join(OUT, `${shot}.png`);
  rmSync(final, { force: true });
  execFileSync("sips", ["-z", "1440", "1080", hi, "--out", final], { stdio: "ignore" });
  rmSync(hi, { force: true });
  console.log(`${final}`);
}

await browser.close();
