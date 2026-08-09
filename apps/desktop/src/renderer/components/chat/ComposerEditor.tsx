/**
 * Tiptap-based rich-text composer replacing the plain `<textarea>`.
 *
 * ## Why
 *
 * The composer needs inline, atomic "skill pills" — a `/skill` selected from
 * the slash picker becomes an undeletable-in-parts chip that lives inline with
 * the typed text (like a Slack @mention). A plain textarea can't embed rich
 * nodes, so we switch to a contenteditable powered by Tiptap. Tiptap gives us a
 * real document model (ProseMirror), proper IME/selection handling, and a
 * clean serialization path — all of which are painful to hand-roll.
 *
 * ## Design
 *
 * The skill pill is a custom Mention-style node (`name: "skill"`), `atom: true`
 * so a single backspace removes it whole. We do NOT use Tiptap's Suggestion
 * popup: the parent still owns the `SlashCommandPicker` and trigger detection
 * (reading the editor's text + caret). On pick the parent calls
 * `editorRef.insertSkill(skill)`, which replaces the `/query` token with the
 * pill node + a trailing space.
 *
 * `@` mentions and long-paste promotion stay as chip-above-editor tags in the
 * parent — unchanged from the textarea era. This component only owns the text
 * + skill pills.
 *
 * ## Serialization
 *
 * On send the parent reads `editorRef.serialize()` → `{ text, skillNames }`:
 *   - `text` has skill nodes inlined as `/name` (via the node's `renderText`),
 *     preserving their position in the sentence.
 *   - `skillNames` is the list of embedded skill names (for stream rendering).
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Mention, type MentionNodeAttrs } from "@tiptap/extension-mention";
import { cn } from "@renderer/lib/cn.js";
import type { SkillInfo } from "@contracts/ipc";

/** Result of serializing the editor's document for sending. */
export interface ComposerSerialization {
  /** Plain text with skill pills inlined as `/name` at their positions. */
  text: string;
  /** Names of the skills embedded in the document, in document order. */
  skillNames: string[];
}

/** Imperative handle the parent uses to drive the editor. */
export interface ComposerEditorHandle {
  focus: () => void;
  /** Blur the editor. */
  blur: () => void;
  /** Clear all content. */
  clear: () => void;
  /** Replace all content with plain text (no skill pills), focus the editor,
   *  and place the caret at the end. Used by suggestion prompts. */
  setText: (text: string) => void;
  /** Get the bounding rect of the editor element (for picker anchoring). */
  getRect: () => DOMRect | null;
  /**
   * Replace the text range [start, end) with a skill pill + trailing space,
   * then place the caret right after the space. `start`/`end` are offsets
   * into the editor's plain-text representation (as produced by
   * `getTextWithSkills`).
   */
  insertSkill: (skill: SkillInfo, start: number, end: number) => void;
  /** Insert a command pill (e.g. `/init`) at the plain-text range [start, end),
   *  replacing the trigger token. Same atomic pill rendering as a skill, but
   *  used for built-in commands so they show up as inline color blocks in the
   *  composer instead of being executed immediately or replacing all text. */
  insertCommandPill: (name: string, start: number, end: number) => void;
  /** Delete the text in the plain-text range [start, end), then place the
   *  caret at `start`. Used to remove a `/query` or `@query` trigger token. */
  deleteTextRange: (start: number, end: number) => void;
  /** Serialize the current document for sending. */
  serialize: () => ComposerSerialization;
  /** Current plain text (skills inlined as `/name`), for trigger detection. */
  getTextWithSkills: () => string;
  /** Current caret offset in the plain-text representation. -1 if unknown. */
  getCaretOffset: () => number;
  /** Focus the editor and collapse the caret to the given plain-text offset. */
  setCaretOffset: (offset: number) => void;
  /** Returns the [start, end) plain-text intervals occupied by skill/command
   *  pills. The caller uses this to skip pill text (which serializes as
   *  `/name`) when scanning for a trigger `/`, so a pill's leading slash is
   *  never mistaken for a freshly-typed slash trigger. */
  getPillRanges: () => Array<[number, number]>;
}

interface ComposerEditorProps {
  /** Placeholder shown when empty. */
  placeholder: string;
  /** Whether the editor accepts input (false = read-only / locked). */
  editable: boolean;
  /** Called on every content change with the current plain-text-with-skills. */
  onChange: (text: string) => void;
  /** Called when the user presses Enter without Shift (the parent decides
   *  send vs enqueue based on session state). Shift+Enter inserts a newline
   *  and is NOT reported. */
  onEnter: () => void;
  /** Called with a paste that should be promoted to a tag (long / multi-line).
   *  Short pastes are inserted inline as plain text by default. */
  onPromotePaste?: (text: string) => void;
  /** Threshold check — if true, the paste is forwarded to onPromotePaste
   *  instead of inserted inline. */
  shouldPromotePaste?: (text: string) => boolean;
  /** Called when the paste carries external file items (an image copied from
   *  a browser, a file copied in Finder, a screenshot). The parent turns them
   *  into file tags; any text in the same paste is ignored (a real file
   *  copy's text/plain is just the file name). */
  onPasteFiles?: (files: File[]) => void;
  /** CSS class on the editor host. */
  className?: string;
}

/**
 * Custom Mention node for skills. We extend Mention (rather than configuring
 * it) so the node type has its own name ("skill"), keeping it decoupled from a
 * potential future @-mention node. `atom: true` is inherited from Mention,
 * which makes the pill a single atomic unit for deletion/selection.
 *
 * `renderText` is what `editor.getText()` emits for the node — `/name` — so
 * serialization naturally inlines the skill invocation in place.
 */
const SkillPill = Mention.extend({
  name: "skill",
  // Render the pill: a non-editable span with the sparkles icon + /name.
  // We keep the default parseHTML (span[data-type="skill"]) so the editor can
  // rehydrate pills if we ever round-trip HTML.
  renderHTML({ node, HTMLAttributes }) {
    const name = node.attrs.label ?? node.attrs.id ?? "";
    // CRITICAL: the `class` lives in `this.options.HTMLAttributes` (configured
    // below). The `HTMLAttributes` argument only carries per-instance attributes
    // (data-id, data-label, etc.) — it does NOT include the configured class.
    // Concatenate the class explicitly so the pill renders with its style
    // instead of as plain text. Mirrors what Tiptap's `mergeAttributes` would
    // do, but we inline it to avoid pulling in `@tiptap/core` as a direct
    // dependency.
    const baseClass = (this.options.HTMLAttributes as { class?: string }).class ?? "";
    const extraClass = (HTMLAttributes as { class?: string }).class ?? "";
    const className = [baseClass, extraClass].filter(Boolean).join(" ");
    return [
      "span",
      {
        "data-type": "skill",
        ...HTMLAttributes,
        ...(className ? { class: className } : {}),
      },
      `/${name}`,
    ];
  },
}).configure({
  // Suppress the built-in suggestion popup — the parent drives the
  // SlashCommandPicker and trigger detection itself. We provide a no-op render
  // so the suggestion plugin never creates any UI; we only need the node type
  // (atom: true, inline) from Mention, not its suggestion machinery.
  suggestion: {
    char: "/",
    render: () => ({
      onStart: () => {},
      onUpdate: () => {},
      onExit: () => {},
    }),
  },
  renderText: ({ node }) => `/${node.attrs.label ?? node.attrs.id ?? ""}`,
  HTMLAttributes: {
    // Opaque accent fill (same pairing as the send button) so the skill pill
    // reads as a solid, distinct color block inline with the text rather than
    // a faint tint. text-surface gives high contrast on the accent background.
    // Tight padding + sub-1em font keeps the pill height roughly aligned with
    // the surrounding text line rather than towering above it.
    class: cn(
      "skill-pill inline-flex items-center gap-0.5 rounded border border-accent bg-accent px-1 py-px align-baseline shadow-sm transition-colors",
      "text-[0.8em] font-semibold text-surface hover:brightness-110",
    ),
  },
});

export const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  ComposerEditorProps
>(function ComposerEditor(
  {
    placeholder,
    editable,
    onChange,
    onEnter,
    onPromotePaste,
    shouldPromotePaste,
    onPasteFiles,
    className,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Mirror the callbacks in refs so the editor (created once) always calls the
  // latest closures without needing to recreate the editor.
  const onChangeRef = useRef(onChange);
  const onEnterRef = useRef(onEnter);
  const onPromotePasteRef = useRef(onPromotePaste);
  const shouldPromotePasteRef = useRef(shouldPromotePaste);
  const onPasteFilesRef = useRef(onPasteFiles);
  onChangeRef.current = onChange;
  onEnterRef.current = onEnter;
  onPromotePasteRef.current = onPromotePaste;
  shouldPromotePasteRef.current = shouldPromotePaste;
  onPasteFilesRef.current = onPasteFiles;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // The composer is a single-line-ish input that soft-wraps. Shift+Enter
        // inserts a hard break; StarterKit's default is already enabled, so we
        // just accept defaults here.
      }),
      SkillPill,
    ],
    content: "",
    editable,
    editorProps: {
      attributes: {
        class: cn(
          "composer-prose outline-none",
          "min-h-[3rem] leading-relaxed",
        ),
        "aria-label": placeholder,
        "data-placeholder": placeholder,
      },
      // Force every paste to plain text: contenteditable would otherwise insert
      // rich HTML from external sources (browsers, other apps). If the paste is
      // bulky (per shouldPromotePaste) we hand it to the parent as a tag and
      // suppress insertion entirely. External file items (images / files copied
      // from the OS) take priority over any text in the same paste — the parent
      // turns them into file tags.
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length > 0) {
          event.preventDefault();
          onPasteFilesRef.current?.(files);
          return true;
        }
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const promote = shouldPromotePasteRef.current?.(text);
        if (promote && onPromotePasteRef.current) {
          event.preventDefault();
          onPromotePasteRef.current(text);
          return true;
        }
        if (!text) return false;
        event.preventDefault();
        // Insert as plain text, preserving the current selection.
        view.dispatch(view.state.tr.insertText(text));
        return true;
      },
      // Enter sends (parent decides send vs enqueue); Shift+Enter = newline.
      // Suppress Enter during IME composition (so confirming a candidate
      // doesn't send the message).
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          onEnterRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      onChangeRef.current(textWithSkills(editor));
    },
  });

  // Keep editable in sync with the prop without recreating the editor.
  useEffect(() => {
    if (editor) editor.setEditable(editable);
  }, [editor, editable]);

  /** Plain-text representation of the doc: text nodes verbatim, skill nodes as
   *  `/name`. Walks the doc so node order is preserved relative to text. */
  function textWithSkills(ed: typeof editor): string {
    if (!ed) return "";
    const { doc } = ed.state;
    let out = "";
    doc.descendants((node) => {
      if (node.isText) {
        out += node.text ?? "";
      } else if (node.type.name === "skill") {
        out += `/${node.attrs.label ?? node.attrs.id ?? ""}`;
        return false; // don't descend into the pill
      } else if (node.type.name === "hardBreak") {
        // Shift+Enter (and multi-line pastes — ProseMirror converts the
        // newlines to hardBreak nodes) must survive serialization or the
        // sent message collapses into one line.
        out += "\n";
      }
      return true;
    });
    return out;
  }

  /** Plain-text offset of the current selection. Maps the ProseMirror
   *  position to an offset in the `textWithSkills` string by walking the doc
   *  up to the selection. Returns -1 when the selection is inside a pill (no
   *  meaningful text offset) or the editor isn't focused. */
  function caretOffset(ed: typeof editor): number {
    if (!ed) return -1;
    const { doc, selection } = ed.state;
    const head = selection.from;
    let offset = 0;
    let found = -1;
    doc.nodesBetween(0, head, (node, pos) => {
      if (found !== -1) return false;
      const end = pos + node.nodeSize;
      if (node.isText) {
        if (head <= end) {
          found = offset + (head - pos);
          return false;
        }
        offset += node.text?.length ?? 0;
      } else if (node.type.name === "skill") {
        // A pill contributes `/name` chars.
        offset += `/${node.attrs.label ?? node.attrs.id ?? ""}`.length;
        return false;
      } else if (node.type.name === "hardBreak") {
        // Mirrors textWithSkills: a hard break serializes as "\n".
        offset += 1;
      }
      return true;
    });
    return found === -1 ? offset : found;
  }

  /** Convert a plain-text offset (in the `textWithSkills` space) back to a
   *  ProseMirror document position. Used by insertSkill to map the
   *  trigger-token range into the doc. */
  function textOffsetToPos(ed: typeof editor, offset: number): number {
    if (!ed) return 0;
    const { doc } = ed.state;
    let pos = 0;
    let acc = 0;
    doc.descendants((node, p) => {
      if (acc >= offset) return false;
      if (node.isText) {
        const len = node.text?.length ?? 0;
        if (acc + len >= offset) {
          pos = p + (offset - acc);
          acc = offset;
          return false;
        }
        acc += len;
      } else if (node.type.name === "skill") {
        const len = `/${node.attrs.label ?? node.attrs.id ?? ""}`.length;
        if (acc + len >= offset) {
          // Snap to the pill's end — pills are atomic.
          pos = p + node.nodeSize;
          acc = offset;
          return false;
        }
        acc += len;
      } else if (node.type.name === "hardBreak") {
        // Mirrors textWithSkills: a hard break serializes as "\n".
        if (acc + 1 >= offset) {
          pos = p + 1;
          acc = offset;
          return false;
        }
        acc += 1;
      }
      return true;
    });
    if (acc < offset) pos = doc.content.size; // past the end
    return pos;
  }

  /** Shared pill-insertion logic for both skills and built-in commands.
   *  Replaces the plain-text range [start, end) with an atomic `skill` node
   *  (rendered as `/name`) + a trailing space, then parks the caret after the
   *  space so the user can keep typing. The node type is the same for both -
   *  a built-in command pill is visually identical to a skill pill. */
  function insertPillAt(
    ed: NonNullable<typeof editor>,
    name: string,
    start: number,
    end: number,
  ) {
    const from = textOffsetToPos(ed, start);
    const to = textOffsetToPos(ed, end);
    const attrs: MentionNodeAttrs = { id: name, label: name };
    ed.chain()
      .focus()
      .deleteRange({ from, to })
      .insertContentAt(from, [
        { type: "skill", attrs },
        { type: "text", text: " " },
      ])
      .run();
    // Park the caret right after the inserted space (pill nodeSize 1 + space 1).
    requestAnimationFrame(() => {
      if (!ed.isDestroyed) {
        ed.commands.focus();
        ed.commands.setTextSelection(from + 2);
      }
    });
  }

  useImperativeHandle(
    ref,
    (): ComposerEditorHandle => ({
      focus: () => editor?.commands.focus(),
      blur: () => editor?.commands.blur(),
      clear: () => editor?.commands.clearContent(true),
      setText: (text) => {
        if (!editor) return;
        editor.commands.clearContent(true);
        if (text) editor.commands.insertContent(text);
        editor.commands.focus("end");
      },
      getRect: () => hostRef.current?.getBoundingClientRect() ?? null,
      insertSkill: (skill, start, end) => {
        if (!editor) return;
        insertPillAt(editor, skill.name, start, end);
      },
      insertCommandPill: (name, start, end) => {
        if (!editor) return;
        insertPillAt(editor, name, start, end);
      },
      deleteTextRange: (start, end) => {
        if (!editor) return;
        const from = textOffsetToPos(editor, start);
        const to = textOffsetToPos(editor, end);
        editor
          .chain()
          .focus()
          .deleteRange({ from, to })
          .setTextSelection(from)
          .run();
      },
      setCaretOffset: (offset) => {
        if (!editor) return;
        const pos = textOffsetToPos(editor, offset);
        editor.chain().focus().setTextSelection(pos).run();
      },
      serialize: () => {
        if (!editor) return { text: "", skillNames: [] };
        const skillNames: string[] = [];
        editor.state.doc.descendants((node) => {
          if (node.type.name === "skill") {
            skillNames.push(node.attrs.label ?? node.attrs.id ?? "");
          }
        });
        return { text: textWithSkills(editor), skillNames };
      },
      getTextWithSkills: () => textWithSkills(editor),
      getCaretOffset: () => caretOffset(editor),
      getPillRanges: () => {
        if (!editor) return [];
        const ranges: Array<[number, number]> = [];
        let offset = 0;
        editor.state.doc.descendants((node) => {
          if (node.isText) {
            offset += node.text?.length ?? 0;
          } else if (node.type.name === "skill") {
            const len = `/${node.attrs.label ?? node.attrs.id ?? ""}`.length;
            ranges.push([offset, offset + len]);
            offset += len;
            return false; // don't descend into the pill
          }
          return true;
        });
        return ranges;
      },
    }),
    [editor],
  );

  return (
    <div
      ref={hostRef}
      className={cn("composer-host", className)}
    >
      <EditorContent editor={editor} />
    </div>
  );
});
