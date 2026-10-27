/**
 * Deterministic cleanup for LLM-generated commit messages: strip attribution
 * trailers the model habitually appends — "Co-Authored-By: Claude Code
 * <noreply@anthropic.com>", "🤖 Generated with [Claude Code](…)", etc.
 *
 * Root cause: the commit-message generation path (ipc/git.ts) replaces the
 * CLI's default system prompt entirely, but the model's training bias toward
 * signing commit messages persists — a prompt-side prohibition alone proved
 * insufficient, so the trailers are also removed here after generation.
 *
 * Human co-authorship is preserved: only lines naming Claude / Anthropic's
 * noreply address match. "Co-Authored-By: John Claude <john@x.com>" survives.
 */

const TRAILER_RES: RegExp[] = [
  // Co-Authored-By where the name starts with Claude… or the email is
  // Anthropic's noreply. Anchored so real people named e.g. "John Claude"
  // with their own email are untouched.
  /^co-authored-by:\s*(?:claude\b[^<]*<[^>]*>|[^<]*<noreply@anthropic\.com>)$/i,
  // "🤖 Generated with [Claude Code](https://…)" / "Generated with Claude Code"
  // and created/written/powered variants — requires a claude mention so a
  // legitimate "Generated with babel" line in a body survives.
  /^(?:\p{Extended_Pictographic}\s*)?(?:generated|created|written|powered)\s+with\b.*claude/iu,
];

/** Remove attribution-trailer lines and repair the gaps their removal leaves:
 *  the two-newline separator before a trailer would otherwise dangle at the
 *  end, and mid-message removals collapse to a single blank line. A clean
 *  message (subject + blank line + body) is returned unchanged apart from
 *  trailing whitespace. */
export function stripCommitAttributionTrailers(message: string): string {
  const lines = message.split("\n").filter(
    (line) => !TRAILER_RES.some((re) => re.test(line.trim())),
  );
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
