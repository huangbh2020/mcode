/**
 * Headless smoke for main/lib/commitTrailers.ts — the post-generation cleanup
 * behind git:generateCommitMessage. Covers: the Claude trailer forms the
 * model actually emits (the exact "Co-Authored-By: Claude Code
 * <noreply@anthropic.com>" from user reports, emoji + markdown-link variant,
 * bare "Generated with Claude Code"), human co-author preservation, dangling
 * separator repair, mid-message gap collapse, and clean-message passthrough.
 * Pure module — no stubs needed.
 */
import { stripCommitAttributionTrailers } from "@main/lib/commitTrailers.js";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

function main(): void {
  // 1. The exact trailer from user reports: subject/body intact, trailer gone,
  //    the two-newline separator before it not left dangling at the end.
  let m = stripCommitAttributionTrailers(
    "feat(chat): 优化消息块折叠展示\n\n详细说明正文。\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>",
  );
  assert(
    m === "feat(chat): 优化消息块折叠展示\n\n详细说明正文。",
    "claude-code Co-Authored-By trailer stripped, separator repaired",
  );

  // 2. Name "Claude" without "Code".
  m = stripCommitAttributionTrailers("fix: a\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
  assert(m === "fix: a", "Co-Authored-By: Claude <noreply@anthropic.com> stripped");

  // 3. Anthropic noreply email under any name.
  m = stripCommitAttributionTrailers("fix: a\n\nCo-Authored-By: Assistant <noreply@anthropic.com>");
  assert(m === "fix: a", "noreply@anthropic.com email matched regardless of name");

  // 4. Emoji + markdown-link "Generated with" form.
  m = stripCommitAttributionTrailers(
    "fix: a\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
  );
  assert(m === "fix: a", "emoji + linked Generated-with form stripped alongside trailer");

  // 5. Bare "Generated with Claude Code" (no emoji).
  m = stripCommitAttributionTrailers("fix: a\n\nGenerated with Claude Code");
  assert(m === "fix: a", "bare Generated-with-Claude-Code line stripped");

  // 6. Human co-authorship preserved — including a person whose NAME contains
  //    "Claude" but has their own email.
  m = stripCommitAttributionTrailers(
    "fix: a\n\nCo-Authored-By: Alice <alice@example.com>\nCo-Authored-By: John Claude <john@example.com>",
  );
  assert(
    m === "fix: a\n\nCo-Authored-By: Alice <alice@example.com>\nCo-Authored-By: John Claude <john@example.com>",
    "human co-author lines preserved (incl. name containing Claude, own email)",
  );

  // 7. Non-attribution "generated with" body line survives (no claude mention).
  m = stripCommitAttributionTrailers("fix: a\n\nDocs generated with sphinx.");
  assert(m === "fix: a\n\nDocs generated with sphinx.", "claude-free generated-with body line preserved");

  // 8. Mid-message removal collapses the opened gap to a single blank line.
  m = stripCommitAttributionTrailers(
    "fix: a\n\nGenerated with Claude Code\n\n- item one\n- item two",
  );
  assert(m === "fix: a\n\n- item one\n- item two", "mid-message trailer removal collapses the gap");

  // 9. Clean message passthrough: subject + blank + body unchanged.
  const clean = "feat(ui): 新增面板\n\n- 支持折叠\n- 支持展开";
  assert(stripCommitAttributionTrailers(clean) === clean, "clean message byte-identical");

  // 10. Trailing whitespace-only trim on clean messages.
  assert(
    stripCommitAttributionTrailers("fix: a\n\nbody\n") === "fix: a\n\nbody",
    "trailing newline trimmed",
  );

  if (failed > 0) {
    console.error(`${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("commit-trailers smoke: all assertions passed");
}

main();
