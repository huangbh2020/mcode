/**
 * Drag-and-drop insertion text for terminal surfaces — the PTY counterpart of
 * the composer's file-tag drop zone. The file tree stashes the dragged
 * absolute path in FILE_DRAG_MIME (FileTree's dragstart); dropping it onto a
 * terminal types the reference straight into whatever is reading stdin
 * (claude's input box, or the shell prompt of the IDE terminal).
 *
 * Terminal SESSIONS use mention mode (`@D:\abs\path.ts`) to match the GUI
 * composer's file-tag form (makeFileTag emits `@<absolute path>` lines, and
 * claude's input resolves absolute @-references). The bottom IDE terminal
 * uses bare paths — there `@` would just be a literal character for the
 * shell. Paths containing whitespace are double-quoted (PowerShell-safe);
 * a trailing space keeps the user's continued typing natural.
 */
import { FILE_DRAG_MIME } from "@renderer/lib/contentTag.js";

/** True when the text is safe unquoted on a shell/claude input line. */
function needsQuotes(s: string): boolean {
  return /\s/.test(s);
}

/** Build the text typed into the PTY for one dropped payload. */
export function terminalDropInsertText(paths: readonly string[], mention: boolean): string {
  const refs = paths
    .filter((p) => p.length > 0)
    .map((p) => {
      const ref = mention ? `@${p}` : p;
      return needsQuotes(ref) ? `"${ref}"` : ref;
    });
  if (refs.length === 0) return "";
  return `${refs.join(" ")} `;
}

/**
 * Extract the dropped payload from a DataTransfer: the file tree's custom
 * MIME first, then plain text (a useful paste-like fallback for any
 * draggable text). Returns null when the drop carries neither.
 */
export function extractDropPayload(dt: DataTransfer): { kind: "file" | "text"; value: string } | null {
  try {
    const file = dt.getData(FILE_DRAG_MIME);
    if (file) return { kind: "file", value: file };
    const text = dt.getData("text/plain");
    if (text) return { kind: "text", value: text };
  } catch {
    /* some payloads throw on getData — treat as empty */
  }
  return null;
}
