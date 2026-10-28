/**
 * Headless smoke for the PDF preview's main-side asset pipeline:
 *  - `readPdfjsAssetGuarded` (ipc/files.ts): serves bundled pdf.js CMaps /
 *    standard fonts / wasm as base64 over IPC; validates the asset NAME
 *    charset (path traversal / separators / empty / dots-only all refuse) and
 *    resolves everything inside the installed pdfjs-dist package root.
 *  - `MEDIA_CONTENT_TYPES` carries `.pdf` → application/pdf (mobile /api/media
 *    inlines PDFs for free).
 *  - The contract schema rejects unknown kinds / non-string names.
 *
 * The bundle is emitted INSIDE apps/desktop (see run.sh) so the handler's
 * `createRequire(import.meta.url)` resolves the workspace node_modules — the
 * same trick terminal-session-smoke uses for node-pty.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  readPdfjsAssetGuarded,
} from "@main/ipc/files.js";
import { MEDIA_CONTENT_TYPES } from "@main/lib/appResourceProtocol.js";
import { FileReadPdfjsAssetSchema } from "@contracts/ipc";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

function parseOrUndefined(raw: unknown): "ok" | "throw" {
  try {
    FileReadPdfjsAssetSchema.parse(raw);
    return "ok";
  } catch {
    return "throw";
  }
}

async function main(): Promise<void> {
  /* ── real assets round-trip against the on-disk package ── */
  const req = createRequire(import.meta.url);
  const pkgRoot = dirname(req.resolve("pdfjs-dist/package.json"));

  // 1. A real CJK CMap — the file Chinese PDFs need most often.
  const cmap = await readPdfjsAssetGuarded("cmap", "UniGB-UCS2-H.bcmap");
  const cmapDisk = readFileSync(join(pkgRoot, "cmaps", "UniGB-UCS2-H.bcmap"));
  assert(cmap.data.length > 0, "real cmap serves non-empty base64");
  assert(
    Buffer.from(cmap.data, "base64").equals(cmapDisk),
    "cmap base64 round-trips byte-identical to the on-disk file",
  );

  // 2. A real standard font.
  const font = await readPdfjsAssetGuarded("font", "FoxitSerif.pfb");
  assert(font.data.length > 0, "real standard font serves non-empty base64");

  // 3. A real wasm — first 4 bytes must be the wasm magic `\0asm`.
  const wasm = await readPdfjsAssetGuarded("wasm", "qcms_bg.wasm");
  const wasmBytes = Buffer.from(wasm.data, "base64");
  assert(wasmBytes.length > 4, "real wasm serves non-empty base64");
  assert(
    wasmBytes[0] === 0x00 && wasmBytes[1] === 0x61 && wasmBytes[2] === 0x73 && wasmBytes[3] === 0x6d,
    "wasm payload starts with the \\0asm magic",
  );

  /* ── hostile / unknown names all degrade to "" (never throw, never read) ── */
  const badNames = [
    "../package.json", // parent traversal
    "..\\..\\package.json", // windows-style traversal
    "a/b", // forward separator
    "a\\b", // back separator
    "a:b", // drive-letter colon
    "", // empty
    ".", // bare dot
    "..", // bare dots — charset-legal, must still refuse
    "cmaps%2F..", // percent-encoded smuggle (% outside the charset)
    "name with spaces", // spaces outside the charset
    "NoSuchCMap-xyz.bcmap", // charset-legal but absent → empty, not throw
  ];
  for (const name of badNames) {
    const r = await readPdfjsAssetGuarded("cmap", name);
    assert(r.data === "", `refuses/empties hostile name ${JSON.stringify(name)}`);
  }

  /* ── MIME table ── */
  assert(
    MEDIA_CONTENT_TYPES[".pdf"] === "application/pdf",
    "MEDIA_CONTENT_TYPES maps .pdf → application/pdf",
  );

  /* ── contract schema ── */
  assert(
    parseOrUndefined({ kind: "cmap", name: "UniGB-UCS2-H.bcmap" }) === "ok",
    "schema accepts a valid request",
  );
  assert(
    parseOrUndefined({ kind: "evil", name: "x" }) === "throw",
    "schema rejects an unknown kind",
  );
  assert(
    parseOrUndefined({ kind: "cmap", name: 42 }) === "throw",
    "schema rejects a non-string name",
  );
  assert(
    parseOrUndefined({ name: "x" }) === "throw",
    "schema rejects a missing kind",
  );

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nall pdfjs-asset smoke assertions passed");
}

void main();
