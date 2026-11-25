/**
 * Headless smoke for renderer/lib/fileCitation.ts (the parser for
 * model-emitted `::zcode-file-citation{…}` directives) and
 * renderer/lib/markdownFileCitations.ts (the rehype plugin that restores the
 * placeholders).
 *
 * The first two samples are stored assistant text, copied verbatim from the
 * app database (2026-11-24: GLM-5.3-Flash and MiniMax-M3.1-Flash-Preview via
 * custom endpoints) — including the malformed single-colon directive the
 * issue was reported with. The markdown section drives the REAL react-markdown
 * pipeline to prove what the design is for: the cited path survives parsing
 * untouched, where rendering the raw directive mangles it.
 *
 * Pure modules — no stubs needed.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  FILE_CITATION_NAME,
  FILE_CITATION_PLACEHOLDER_RE,
  fileCitationLocation,
  flattenFileCitations,
  preprocessFileCitations,
  splitTextByFileCitations,
  type FileCitation,
  type FileCitationSegment,
} from "@renderer/lib/fileCitation.js";
import { FILE_CITATION_CLASS, rehypeFileCitations } from "@renderer/lib/markdownFileCitations.js";

let failed = 0;
let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  } else {
    passed += 1;
    console.log(`ok: ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, a === e ? msg : `${msg} — got ${a}, expected ${e}`);
}

// ── Samples copied from stored replies ─────────────────────────────────
// (String.raw: the single backslashes are what the model wrote.)
const REAL_OUTPUT_SQL = String.raw`D:\workspace\jtf\sql\update_meal_balance_2024-2025-xia.sql`;
const REAL_SOURCE_XLS = String.raw`C:\Users\86134\Desktop\餐费余额导入模板-2024-2025下.xls`;
/** The reported message: a standard directive, then one with a full-width
 *  colon in the prose and only ONE ASCII colon starting the directive. */
const REAL_1 =
  `脚本已生成：::zcode-file-citation{path="${REAL_OUTPUT_SQL}" purpose="output"}` +
  `，数据来源 ：:zcode-file-citation{path="${REAL_SOURCE_XLS}" purpose="source" artifact_kind="workbook" sheet="餐费余额" range="A1:E91"}。`;
const REAL_OUTPUT_XLSX = String.raw`D:\workspace\jtf\教育缴退费系统与SAP接口结构清单20261014_V0.2.xlsx`;
const REAL_2 = `已生成 ::zcode-file-citation{path="${REAL_OUTPUT_XLSX}" purpose="output"}`;

const DIRECTIVE = `::zcode-file-citation{path="a.sql" purpose="output"}`;
const PLAIN = '没有引用的普通回复，含 D:\\path\\a.sql 与 ::before{content:""}';

const citationsOf = (text: string): FileCitation[] =>
  splitTextByFileCitations(text)
    .filter((s): s is Extract<FileCitationSegment, { kind: "citation" }> => s.kind === "citation")
    .map((s) => s.citation);
/** The first citation in `text` (undefined when there is none). */
const first = (text: string): FileCitation | undefined => citationsOf(text)[0];
/** True when the scanner found nothing to lift: the text comes back whole. */
function untouched(text: string): boolean {
  const segs = splitTextByFileCitations(text);
  const only = segs.length === 1 ? segs[0] : undefined;
  return only?.kind === "text" && only.text === text;
}
/** The scanner's last segment. */
const lastOf = (text: string): FileCitationSegment | undefined => {
  const segs = splitTextByFileCitations(text);
  return segs[segs.length - 1];
};

// ── The real pipeline: preprocess → react-markdown → plugin ────────────

/** Stands in for Markdown.tsx's `span` override: a citation placeholder
 *  becomes `<x-citation index>`; every other span is rendered as itself. */
const SMOKE_COMPONENTS = {
  span(props: Record<string, unknown>) {
    const className = props["className"];
    if (typeof className === "string" && className.split(/\s+/).includes(FILE_CITATION_CLASS)) {
      return createElement("x-citation", { index: props["data-index"] });
    }
    return createElement("span", { className }, props["children"] as never);
  },
} as unknown as Components;

function render(source: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeFileCitations()], components: SMOKE_COMPONENTS },
      source,
    ),
  );
}

/** What Markdown.tsx does: lift the citations, render what is left. */
function renderCiting(source: string, streaming = false): { html: string; citations: FileCitation[] } {
  const { text, citations } = preprocessFileCitations(source, { hideTrailingPartial: streaming });
  return { html: render(text), citations };
}

function main(): void {
  // ── 1. The reported message ──────────────────────────────────────────
  const s1 = splitTextByFileCitations(REAL_1);
  eq(s1.map((s) => s.kind), ["text", "citation", "text", "citation", "text"], "real #1: text, citation, text, citation, text");
  eq(s1[0], { kind: "text", text: "脚本已生成：" }, "real #1: prose before the first citation");
  eq(s1[2], { kind: "text", text: "，数据来源 ：" }, "real #1: the full-width colon stays with the prose");
  eq(s1[4], { kind: "text", text: "。" }, "real #1: trailing prose");
  const c1 = citationsOf(REAL_1);
  eq(c1[0], { path: REAL_OUTPUT_SQL, purpose: "output", artifactKind: undefined, sheet: undefined, range: undefined }, "real #1: output citation, backslashes single");
  eq(c1[1], { path: REAL_SOURCE_XLS, purpose: "source", artifactKind: "workbook", sheet: "餐费余额", range: "A1:E91" }, "real #1: the single-colon source citation parses too");
  eq(
    s1.map((s) => (s.kind === "text" ? s.text : "§")).join(""),
    REAL_1.replace(/::?zcode-file-citation\{[^}]*\}/g, "§"),
    "real #1: segments cover the text with nothing lost in between",
  );
  eq(fileCitationLocation(c1[0]), "", "a plain file has no location");
  eq(fileCitationLocation(c1[1]), "餐费余额!A1:E91", "workbook citation → sheet!range");
  eq(splitTextByFileCitations(""), [], "empty text → no segments");

  // ── 2. Clipboard text ────────────────────────────────────────────────
  eq(
    flattenFileCitations(REAL_1),
    `脚本已生成：${REAL_OUTPUT_SQL}，数据来源 ：${REAL_SOURCE_XLS} (餐费余额!A1:E91)。`,
    "flatten: citations become paths, the excerpt in parentheses",
  );
  assert(flattenFileCitations(PLAIN) === PLAIN, "flatten: text without citations comes back as the same string");
  eq(flattenFileCitations(""), "", "flatten: empty text");

  // ── 3. The MiniMax sample ────────────────────────────────────────────
  eq(splitTextByFileCitations(REAL_2).map((s) => s.kind), ["text", "citation"], "real #2: text then citation");
  eq(first(REAL_2)?.path, REAL_OUTPUT_XLSX, "real #2: underscore in the file name is not emphasis");

  // ── 4. Look-alikes that must NOT match ───────────────────────────────
  for (const css of [
    '清除浮动用 .clearfix::after{content:"";display:table}',
    '::before{content:"x"} 与 a::after { content: "y" }',
    "CSS 伪元素 ::selection{background:red}",
  ]) {
    assert(untouched(css), `CSS pseudo-element left alone: ${css.slice(0, 26)}`);
  }
  assert(untouched("提到 zcode-file-citation 这个名字本身"), "the bare name without colons/braces is plain text");
  assert(untouched(PLAIN), "a ::before{…} in ordinary prose is plain text");

  // ── 5. Code is not cited ─────────────────────────────────────────────
  const codeSamples: Array<[string, string]> = [
    ["fenced block", "```text\n" + DIRECTIVE + "\n```\n"],
    ["tilde fence", "~~~\n" + DIRECTIVE + "\n~~~\n"],
    ["fenced block with prose around", "例如：\n\n```json\n{ \"cite\": \"" + DIRECTIVE + "\" }\n```\n\n如上。"],
    ["unclosed fence (still streaming)", "示例：\n```text\n" + DIRECTIVE],
    ["inline code", "写法是 `" + DIRECTIVE + "`，不要照抄"],
    ["inline code in a list item", "- 写法：`" + DIRECTIVE + "`"],
  ];
  for (const [label, code] of codeSamples) {
    assert(untouched(code), `code left alone — ${label}`);
  }
  eq(citationsOf("写法 `" + DIRECTIVE + "`，实际：\n\n" + DIRECTIVE).length, 1, "a directive after a closed inline span IS cited");
  eq(citationsOf("孤立的 ` 反引号，然后 " + DIRECTIVE).length, 1, "an unclosed backtick does not turn the rest of the paragraph into code");
  eq(citationsOf("转义 \\` 反引号，然后 " + DIRECTIVE).length, 1, "an escaped backtick is not a delimiter");

  // ── 6. Paths that Markdown would mangle ──────────────────────────────
  const HOSTILE = String.raw`C:\Users\u\.config\a[1] (v2)_x.sql`;
  eq(first(`::zcode-file-citation{path="${HOSTILE}"}`)?.path, HOSTILE, "hostile path kept verbatim: \\.[ _[]() and a space");
  const TICK = "D:\\a\\`b`.sql";
  eq(first(`::zcode-file-citation{path="${TICK}"}`)?.path, TICK, "a backtick in the path");
  eq(first(`::zcode-file-citation{path="reports/a|b.sql"}`)?.path, "reports/a|b.sql", "a pipe in the path");
  eq(first(String.raw`::zcode-file-citation{path="D:\\workspace\\a.sql"}`)?.path, String.raw`D:\workspace\a.sql`, "JSON-doubled separators after a drive letter are undone");
  eq(first(String.raw`::zcode-file-citation{path="\\server\share\a.sql"}`)?.path, String.raw`\\server\share\a.sql`, "a UNC prefix is kept");
  eq(first(String.raw`::zcode-file-citation{path="D:\a\"b.sql"}`)?.path, String.raw`D:\a"b.sql`, '\\\" is an escaped quote');
  eq(first(`::zcode-file-citation{path="/srv/app/x y.sql"}`)?.path, "/srv/app/x y.sql", "POSIX path unchanged");
  eq(first(`::zcode-file-citation{path="src/{a}/{b}.sql"}`)?.path, "src/{a}/{b}.sql", "braces inside quotes are data");

  // ── 7. Grammar variants ──────────────────────────────────────────────
  eq(first(`::zcode-file-citation {path="a.sql"}`)?.path, "a.sql", "blank space before {");
  eq(first(`:::zcode-file-citation{path="a.sql"}`)?.path, "a.sql", "three colons: the extra one is text, the directive is cited");
  eq(splitTextByFileCitations(`:::zcode-file-citation{path="a.sql"}`)[0], { kind: "text", text: ":" }, "…and the extra colon stays in the text");
  eq(first(`::zcode-file-citation{PATH="a.sql" Purpose="OUTPUT"}`)?.purpose, "OUTPUT", "attribute names are case-insensitive; values are not rewritten");
  eq(first(`::zcode-file-citation{purpose="source" path='b.sql'}`)?.path, "b.sql", "attribute order is free; single quotes accepted");
  eq(first(`::zcode-file-citation{path=c.sql purpose=output}`)?.purpose, "output", "bare values accepted");
  eq(first(`::zcode-file-citation{path="a.sql" line_start=10 school_year="2024-2025"}`)?.path, "a.sql", "unknown attributes are ignored");
  assert(untouched(`::zcode-file-citation{purpose="output"}`), "no path → not a citation, text unchanged");
  eq(
    splitTextByFileCitations(`前 ::zcode-file-citation{purpose="output"} 后 ${DIRECTIVE}`),
    [
      { kind: "text", text: `前 ::zcode-file-citation{purpose="output"} 后 ` },
      { kind: "citation", citation: { path: "a.sql", purpose: "output", artifactKind: undefined, sheet: undefined, range: undefined } },
    ],
    "a pathless directive does not stop the scan finding the next one",
  );
  eq(first(`**::zcode-file-citation{path="a.sql"}**`)?.path, "a.sql", "inside bold markers");
  eq(first(`- 条目：::zcode-file-citation{path="a.sql"}`)?.path, "a.sql", "inside a list item");

  // ── 8. Streaming: a directive that is still arriving ─────────────────
  // [label, text, what the unfinished tail is]
  const partials: Array<[string, string, string]> = [
    ["name incomplete", "数据来源：:zcode-fi", ":zcode-fi"],
    ["name complete, brace not yet", "数据来源：::zcode-file-citation", "::zcode-file-citation"],
    ["brace landed", "数据来源：::zcode-file-citation{", "::zcode-file-citation{"],
    ["body streaming", '数据来源：::zcode-file-citation{path="x.xls" purpose="sou', '::zcode-file-citation{path="x.xls" purpose="sou'],
  ];
  for (const [label, text, tail] of partials) {
    eq(lastOf(text), { kind: "partial", text: tail }, `partial — ${label}`);
    const hidden = preprocessFileCitations(text, { hideTrailingPartial: true });
    eq(hidden.text, "数据来源：", `…hidden while streaming — ${label}`);
    eq(hidden.citations.length, 0, `…and nothing is cited yet — ${label}`);
    assert(preprocessFileCitations(text).text === text, `…shown as-is once streaming ends — ${label}`);
  }
  for (const [label, text] of [
    ["sentence ending in an ASCII colon", "注意以下事项:"],
    ["colon + two letters", "比例 1:ab"],
    ["colon + a word that is not the name", "时间 10:zone"],
  ] as Array<[string, string]>) {
    assert(untouched(text), `not a partial — ${label}`);
  }
  assert(untouched("时间 ::zc"), "two letters into the name is not enough to count as a directive");
  eq(lastOf("时间 ::zco"), { kind: "partial", text: "::zco" }, "three letters into the name already counts");
  {
    // The whole reported message, one character at a time: a citation is
    // announced only once its closing brace has arrived — never half-parsed.
    let sawPartial = 0;
    let ok = true;
    for (let i = 1; i <= REAL_1.length; i++) {
      const prefix = REAL_1.slice(0, i);
      const { citations } = preprocessFileCitations(prefix, { hideTrailingPartial: true });
      const expected = (prefix.includes('purpose="output"}') ? 1 : 0) + (prefix.includes('range="A1:E91"}') ? 1 : 0);
      if (citations.length !== expected) {
        assert(false, `stream of real #1: ${citations.length} citation(s) at prefix length ${i}, expected ${expected}`);
        ok = false;
        break;
      }
      if (i < REAL_1.length && lastOf(prefix)?.kind === "partial") sawPartial += 1;
    }
    if (ok) assert(true, "stream of real #1: citations appear exactly when each directive closes");
    assert(sawPartial > 0, "stream of real #1: the unfinished tail was recognised as partial on the way");
  }
  {
    const fast = preprocessFileCitations(PLAIN);
    assert(fast.text === PLAIN && fast.citations.length === 0, "preprocess: a source without citations is returned as the same string");
    const both = preprocessFileCitations(REAL_1);
    eq(both.citations, c1, "preprocess: both citations lifted");
    assert(!both.text.includes(FILE_CITATION_NAME), "preprocess: no directive markup remains in the markdown source");
    eq((both.text.match(/\uE000/g) ?? []).length, 2, "preprocess: one placeholder per citation");
  }

  // ── 9. The real markdown pipeline ────────────────────────────────────
  {
    const { html, citations } = renderCiting(REAL_1);
    eq(citations, c1, "pipeline: the same two citations come through the markdown");
    assert(html.includes('<x-citation index="0"></x-citation>'), "pipeline: citation #0 restored in place");
    assert(html.includes('<x-citation index="1"></x-citation>'), "pipeline: citation #1 restored in place");
    assert(html.includes("脚本已生成："), "pipeline: prose before");
    assert(html.includes("，数据来源 ："), "pipeline: prose between");
    assert(html.endsWith("。</p>"), "pipeline: prose after");
    assert(!html.includes(FILE_CITATION_NAME), "pipeline: no directive markup reaches the DOM");
    assert(!html.includes("\uE000") && !html.includes("\uE001"), "pipeline: no placeholder character is left behind");
  }
  {
    // Why the citations are lifted out BEFORE parsing: rendered raw, the
    // path inside the directive does not survive Markdown.
    const rawDirective = `::zcode-file-citation{path="${HOSTILE}" purpose="output"}`;
    const raw = render(rawDirective);
    assert(raw.includes("u.config"), `raw rendering eats the backslash before the dot (${raw})`);
    assert(!raw.includes(String.raw`\.config`), "raw rendering: the original path is gone");
    const cited = renderCiting("已生成 " + rawDirective);
    eq(cited.citations[0]?.path, HOSTILE, "preprocessed: the cited path is exact");
    assert(cited.html.includes('<x-citation index="0"></x-citation>'), "preprocessed: restored as a citation");
    assert(!cited.html.includes("u.config"), "preprocessed: the mangled path is not in the output");
  }
  {
    const cited = renderCiting(`已生成 ::zcode-file-citation{path="${TICK}"}`);
    eq(cited.citations[0]?.path, TICK, "pipeline: a backtick in the path neither opens a code span nor splits the directive");
    assert(cited.html.includes("<x-citation") && !cited.html.includes("<code>"), "pipeline: …and no stray code span appears");
  }
  {
    // GFM tables split cells on every pipe — unless the pipe left with the
    // directive before parsing.
    const table = '| 文件 | 说明 |\n|---|---|\n| ::zcode-file-citation{path="a|b.sql"} | 导出 |\n| c.sql | 其它 |';
    const cited = renderCiting(table);
    assert(cited.html.includes("<table>"), "pipeline: the table is still a table");
    assert(/<td[^>]*><x-citation index="0"><\/x-citation><\/td>/.test(cited.html), `pipeline: the citation sits whole in its own cell (${cited.html})`);
    eq(cited.citations[0]?.path, "a|b.sql", "pipeline: the pipe inside the path is data");
  }
  {
    const bold = renderCiting(`**::zcode-file-citation{path="a.sql"}**`);
    assert(/<strong><x-citation index="0"><\/x-citation><\/strong>/.test(bold.html), `pipeline: inside bold the citation is still whole (${bold.html})`);
  }
  {
    // Hidden while streaming, present once the turn ends.
    const half = '数据来源：::zcode-file-citation{path="x.xls" purpose="sou';
    const live = renderCiting(half, true).html;
    assert(live.includes("数据来源：") && !live.includes(FILE_CITATION_NAME), "pipeline (streaming): the half directive is not rendered");
    assert(renderCiting(half, false).html.includes(FILE_CITATION_NAME), "pipeline (settled): a never-closed directive stays visible instead of vanishing");
  }
  {
    // Code showing the syntax is rendered as code, cited or not.
    const fenced = renderCiting("```\n" + DIRECTIVE + "\n```").html;
    assert(fenced.includes("<code") && fenced.includes(FILE_CITATION_NAME) && !fenced.includes("x-citation"), "pipeline: a directive in a fenced block is shown, not cited");
    const inline = renderCiting("写法 `" + DIRECTIVE + "`").html;
    assert(inline.includes("<code>") && inline.includes(FILE_CITATION_NAME) && !inline.includes("x-citation"), "pipeline: …likewise in inline code");
  }

  // ── 10. The rehype plugin on its own ─────────────────────────────────
  type Node = Record<string, unknown> & { children?: Node[] };
  const run = (tree: Node): void => {
    rehypeFileCitations()()(tree as never);
  };
  {
    const tree: Node = { type: "root", children: [{ type: "text", value: "a\uE0000\uE001b\uE00012\uE001c" }] };
    run(tree);
    const children = tree.children ?? [];
    eq(children.map((c) => c.type), ["text", "element", "text", "element", "text"], "plugin: text / placeholder / text / placeholder / text");
    eq(children[1].properties, { className: [FILE_CITATION_CLASS], dataIndex: "0" }, "plugin: the span carries the citation index");
    eq(children[3].properties, { className: [FILE_CITATION_CLASS], dataIndex: "12" }, "plugin: …multi-digit");
    eq(children[0].value, "a", "plugin: text before");
    eq(children[4].value, "c", "plugin: text after");
    eq((children[1].children as Array<{ value: string }>)[0].value, "\uE0000\uE001", "plugin: the span's own text is the placeholder, for a no-citation fallback");
  }
  {
    const text = { type: "text", value: "没有占位符" };
    const tree: Node = { type: "root", children: [{ type: "element", tagName: "p", children: [text] }] };
    run(tree);
    assert((tree.children?.[0].children as Node[])[0] === text, "plugin: a text node without placeholders is kept as the same object");
  }
  {
    // Nested: a placeholder inside a strong inside a paragraph. The walker
    // rebuilds the tree, so read the result back from the root.
    const tree: Node = {
      type: "root",
      children: [{ type: "element", tagName: "p", children: [{ type: "element", tagName: "strong", children: [{ type: "text", value: "\uE0003\uE001" }] }] }],
    };
    run(tree);
    const span = (tree.children?.[0].children as Node[])[0].children as Node[];
    eq(span[0].properties, { className: [FILE_CITATION_CLASS], dataIndex: "3" }, "plugin: placeholders are found at any depth");
    eq(span.map((c) => c.type), ["element"], "plugin: …and nothing else is left in the strong");
  }
  assert(FILE_CITATION_PLACEHOLDER_RE.source.includes("(\\d+)"), "the placeholder pattern captures the index as group 1");
  eq(FILE_CITATION_NAME, "zcode-file-citation", "the one recognised name");

  console.log(`\nfile-citation-smoke: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
