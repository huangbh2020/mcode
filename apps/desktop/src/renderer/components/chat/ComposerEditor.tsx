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
 * `@file` references with the inline-mention setting on (issue #22 follow-up)
 * become the same kind of atomic node (`name: "fileMention"`, rendered as
 * `@<basename>`): the pill lives inline where the user typed the reference,
 * serializes back to the same `@basename` marker text, and a single Backspace
 * removes the whole reference (the parent mirrors the removal into its
 * file-tag state, so the attachment disappears with the pill). Long pastes
 * stay as chip-above-editor tags in the parent — this component only owns the
 * text + the two pill node types.
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
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Mention, type MentionNodeAttrs } from "@tiptap/extension-mention";
import { cn } from "@renderer/lib/cn.js";
import type { SkillInfo } from "@contracts/ipc";

/** Sync the `is-empty` class the placeholder CSS rule keys on (styles.css).
 *  Tiptap v3 adds no such class on its own (and no Placeholder extension is
 *  installed), so without this the rule never matches and the placeholder
 *  text stays invisible. */
function syncEmptyClass(ed: Editor): void {
  ed.view.dom.classList.toggle("is-empty", ed.isEmpty);
}

/** Result of serializing the editor's document for sending. */
export interface ComposerSerialization {
  /** Plain text with skill pills inlined as `/name` and file pills as
   *  `@<basename>` at their positions. */
  text: string;
  /** Names of the skills embedded in the document, in document order. */
  skillNames: string[];
}

/** One inline file reference for the file-mention pill. `path` is the
 *  absolute file path (stored as the node id and shown on hover), `label`
 *  is the display basename (what the serialized `@<basename>` marker
 *  carries — must be the FULL basename, matching the stream-side
 *  marker-matching rule). */
export interface FilePillEntry {
  path: string;
  label: string;
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
  /** Insert plain text at the current caret position without clearing
   *  existing content. Focuses the editor first so the selection is valid.
   *  Used by the "expand tag to editor" action. */
  insertText: (text: string) => void;
  /** Serialize the current document as HTML (skill pills included as
   *  `<span data-type="skill">`). Used to persist the composer draft. */
  getHTML: () => string;
  /** Replace all content with HTML (e.g. a restored composer draft), focus
   *  the editor, and place the caret at the end. Skill pills round-trip via
   *  the node's parseHTML. */
  setHTML: (html: string) => void;
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
  /** Insert atomic file-mention pills (`@<basename>`, hover shows the full
   *  path) replacing the plain-text range [start, end) — typically the
   *  `@query` trigger token — then park the caret after the last pill. */
  insertFilePills: (files: FilePillEntry[], start: number, end: number) => void;
  /** Append atomic file-mention pills at the end of the document WITHOUT
   *  stealing focus or moving the caret — used by drop / attach flows where
   *  the user may be typing elsewhere (or nowhere) in the editor. */
  appendFilePills: (files: FilePillEntry[]) => void;
  /** Convert plain `@<basename>` markers in the text into file pills IN PLACE
   *  (first whole-name match per file, same boundary rule as the stream-side
   *  matcher); files with no marker are appended at the end. Used when a
   *  draft / queued prompt is restored: the persisted text carries markers,
   *  and the live composer shows them as atomic references again. */
  convertFileMarkersToPills: (files: FilePillEntry[]) => void;
  /** Absolute paths (node ids) of the file-mention pills currently in the
   *  document, in document order. The parent diffs this against its file-tag
   *  state to mirror pill deletions (Backspace removes the whole reference). */
  getFilePillPaths: () => string[];
  /** Delete the text in the plain-text range [start, end), then place the
   *  caret at `start`. Used to remove a `/query` or `@query` trigger token. */
  deleteTextRange: (start: number, end: number) => void;
  /** Replace the plain-text range [start, end) with plain text in a single
   *  chained transaction, leaving the caret after the inserted text. Used by
   *  live voice dictation to update the composer's tail in place as the
   *  transcript streams in (partial results revise themselves, so the tail is
   *  rewritten rather than appended). */
  replaceTextRange: (start: number, end: number, text: string) => void;
  /** Serialize the current document for sending. */
  serialize: () => ComposerSerialization;
  /** Current plain text (skills inlined as `/name`), for trigger detection. */
  getTextWithSkills: () => string;
  /** Current caret offset in the plain-text representation. -1 if unknown. */
  getCaretOffset: () => number;
  /** Focus the editor and collapse the caret to the given plain-text offset. */
  setCaretOffset: (offset: number) => void;
  /** Returns the [start, end) plain-text intervals occupied by skill/command
   *  and file-mention pills. The caller uses this to skip pill text (which
   *  serializes as `/name` / `@name`) when scanning for a trigger `/` or `@`,
   *  so a pill's leading trigger char is never mistaken for a freshly-typed
   *  trigger. */
  getPillRanges: () => Array<[number, number]>;
}

interface ComposerEditorProps {
  /** Placeholder shown when empty. */
  placeholder: string;
  /** Whether the editor accepts input (false = read-only / locked). */
  editable: boolean;
  /** Called on every content change with the current plain-text-with-skills.
   *  `textDelta` is the document size change of the transaction that produced
   *  it: negative = net deletion, >= 0 = neutral/insertion. The parent uses
   *  this to keep deletion keystrokes (Backspace shrinking the text toward an
   *  existing `@`/`/` token) from re-opening the inline pickers. */
  onChange: (text: string, textDelta: number) => void;
  /** Called when the user presses Enter without Shift (the parent decides
   *  send vs enqueue based on session state). Shift+Enter inserts a newline
   *  and is NOT reported. */
  onEnter: () => void;
  /** Called when the user presses the bare Up arrow while `historyNavEnabled`
   *  is true — the parent recalls an OLDER sent message into the editor. */
  onHistoryUp?: () => void;
  /** Called when the user presses the bare Down arrow while `historyNavEnabled`
   *  is true — the parent recalls a NEWER sent message (or exits recall). */
  onHistoryDown?: () => void;
  /** Whether the Up/Down arrows should be intercepted for history recall
   *  instead of normal caret navigation. True only when the composer is empty
   *  (or the parent is mid-recall and the user hasn't edited the text). */
  historyNavEnabled?: boolean;
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
  // Fully delete the pill on a single Backspace. The Mention extension's
  // default Backspace handler replaces the node with its `mentionSuggestionChar`
  // (which defaults to "@") instead of removing it — that's why deleting a pill
  // left a stray "@". With this enabled, Backspace inserts "" (clean removal).
  deleteTriggerWithBackspace: true,
  renderText: ({ node }) => `/${node.attrs.label ?? node.attrs.id ?? ""}`,
  HTMLAttributes: {
    // Lightweight inline mark: accent-colored text + a leading sparkles icon
    // (added via `.skill-pill::before` in styles.css). No background fill,
    // border, or shadow — the pill reads as colored text, not a chip, so it
    // stays unobtrusive inline with the surrounding prose.
    class: cn(
      "skill-pill inline-flex items-center gap-0.5 align-baseline transition-opacity",
      "text-[0.85em] font-semibold text-accent hover:opacity-70",
    ),
  },
});

/**
 * Atomic Mention node for inline `@file` references (inline-mention setting,
 * issue #22 follow-up). Same construction as SkillPill — own node name
 * ("fileMention"), `atom: true` so a single Backspace removes the whole
 * reference, `deleteTriggerWithBackspace` so no stray `@` survives.
 *
 * - attrs: `id` = absolute path, `label` = display basename.
 * - `renderText` emits `@<basename>`, so serialization keeps the EXACT marker
 *   text the stream-side inline renderer (Markdown.tsx) matches — a message
 *   sent from a pill composer inlines its file references unchanged.
 * - renderHTML adds `title` (full path) for hover, mirroring the stream-side
 *   pill; parseHTML keys on `span[data-type="fileMention"]` and reads
 *   data-id/data-label, so composer drafts round-trip pills via getHTML/setHTML.
 */
const FilePill = Mention.extend({
  name: "fileMention",
  renderHTML({ node, HTMLAttributes }) {
    const label = node.attrs.label ?? node.attrs.id ?? "";
    const baseClass = (this.options.HTMLAttributes as { class?: string }).class ?? "";
    const extraClass = (HTMLAttributes as { class?: string }).class ?? "";
    const className = [baseClass, extraClass].filter(Boolean).join(" ");
    return [
      "span",
      {
        "data-type": "fileMention",
        ...HTMLAttributes,
        ...(className ? { class: className } : {}),
        title: node.attrs.id ?? undefined,
      },
      `@${label}`,
    ];
  },
}).configure({
  // No-op suggestion, same rationale as SkillPill — the parent's
  // FileMentionPicker owns trigger detection and the popup UI.
  suggestion: {
    char: "@",
    render: () => ({
      onStart: () => {},
      onUpdate: () => {},
      onExit: () => {},
    }),
  },
  deleteTriggerWithBackspace: true,
  renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id ?? ""}`,
  HTMLAttributes: {
    // Same lightweight accent-text family as the skill pill (and the
    // stream-side `.file-pill-inline`) — no glyph, the `@` in the label
    // already marks it as a file reference.
    class: cn(
      "file-pill inline-flex items-center align-baseline transition-opacity",
      "text-[0.85em] font-semibold text-accent hover:opacity-70",
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
    onHistoryUp,
    onHistoryDown,
    historyNavEnabled,
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
  const onHistoryUpRef = useRef(onHistoryUp);
  const onHistoryDownRef = useRef(onHistoryDown);
  const historyNavEnabledRef = useRef(historyNavEnabled);
  const onPromotePasteRef = useRef(onPromotePaste);
  const shouldPromotePasteRef = useRef(shouldPromotePaste);
  const onPasteFilesRef = useRef(onPasteFiles);
  onChangeRef.current = onChange;
  onEnterRef.current = onEnter;
  onHistoryUpRef.current = onHistoryUp;
  onHistoryDownRef.current = onHistoryDown;
  historyNavEnabledRef.current = historyNavEnabled;
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
      FilePill,
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
        // Bare Up/Down arrows (no modifier keys) are history recall when the
        // parent enables it (composer empty, or mid-recall and the text
        // hasn't been manually edited). Intercept and hand off; otherwise
        // let ProseMirror keep them as caret / line navigation.
        if (
          historyNavEnabledRef.current &&
          (event.key === "ArrowUp" || event.key === "ArrowDown") &&
          !event.shiftKey &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.isComposing
        ) {
          event.preventDefault();
          if (event.key === "ArrowUp") onHistoryUpRef.current?.();
          else onHistoryDownRef.current?.();
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor }) => {
      // Initial empty-doc state: the placeholder must be visible before the
      // first keystroke (and before focus — the home composer starts
      // unfocused).
      syncEmptyClass(editor);
    },
    onUpdate: ({ editor, transaction }) => {
      syncEmptyClass(editor);
      // Net document-size delta of THIS transaction (before = pre-transaction
      // doc). Negative means the edit shrank the text (deletion keystrokes,
      // cut, etc.) — the parent's picker trigger detection treats those as
      // close/maintain-only, never as a fresh `@`/`/` trigger.
      onChangeRef.current(
        textWithSkills(editor),
        transaction.doc.content.size - transaction.before.content.size,
      );
    },
  });

  // Keep editable in sync with the prop without recreating the editor.
  useEffect(() => {
    if (editor) editor.setEditable(editable);
  }, [editor, editable]);

  // data-placeholder / aria-label are captured once at editor creation
  // (editorProps.attributes) — patch the DOM attributes when the prop flips
  // (idle → queued → locked) so the placeholder always matches the state.
  useEffect(() => {
    if (!editor) return;
    editor.view.dom.setAttribute("data-placeholder", placeholder);
    editor.view.dom.setAttribute("aria-label", placeholder);
  }, [editor, placeholder]);

  /** Serialized text of an atomic pill node: `/name` for skills/commands,
   *  `@name` for file mentions. Mirrors each node's `renderText` so every
   *  offset-mapping helper below agrees with `getTextWithSkills`. */
  function pillText(node: { type: { name: string }; attrs: Record<string, unknown> }): string {
    const label = (node.attrs.label as string | null) ?? (node.attrs.id as string | null) ?? "";
    return node.type.name === "fileMention" ? `@${label}` : `/${label}`;
  }

  /** Plain-text representation of the doc: text nodes verbatim, skill nodes as
   *  `/name`, file-mention nodes as `@name`. Walks the doc so node order is
   *  preserved relative to text. */
  function textWithSkills(ed: typeof editor): string {
    if (!ed) return "";
    const { doc } = ed.state;
    let out = "";
    doc.descendants((node) => {
      if (node.isText) {
        out += node.text ?? "";
      } else if (node.type.name === "skill" || node.type.name === "fileMention") {
        out += pillText(node);
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
      } else if (node.type.name === "skill" || node.type.name === "fileMention") {
        // A pill contributes its full serialized text (`/name` / `@name`).
        offset += pillText(node).length;
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
      } else if (node.type.name === "skill" || node.type.name === "fileMention") {
        const len = pillText(node).length;
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
    const attrs: MentionNodeAttrs = { id: name, label: name, mentionSuggestionChar: "/" };
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

  /** ProseMirror content for a run of file pills, each followed by a trailing
   *  space so the user can keep typing after the last one (same shape as
   *  insertPillAt's skill insertion). */
  function filePillContent(files: FilePillEntry[]) {
    return files.flatMap((f) => [
      {
        type: "fileMention",
        attrs: {
          id: f.path,
          label: f.label,
          mentionSuggestionChar: "@",
        } satisfies MentionNodeAttrs,
      },
      { type: "text", text: " " },
    ]);
  }

  /** Insert file pills replacing the plain-text range [start, end) — the
   *  `@query` trigger token. Focuses the editor and parks the caret after the
   *  last pill's trailing space (2 PM positions per pill: node + space). */
  function insertFilePillsAt(
    ed: NonNullable<typeof editor>,
    files: FilePillEntry[],
    start: number,
    end: number,
  ) {
    const from = textOffsetToPos(ed, start);
    const to = textOffsetToPos(ed, end);
    ed.chain()
      .focus()
      .deleteRange({ from, to })
      .insertContentAt(from, filePillContent(files))
      .run();
    requestAnimationFrame(() => {
      if (!ed.isDestroyed) {
        ed.commands.focus();
        ed.commands.setTextSelection(from + files.length * 2);
      }
    });
  }

  /** Append file pills at the end of the document without stealing focus or
   *  moving the caret — used by drop / attach / queue-drain flows where the
   *  user may be typing elsewhere (or nothing at all). `updateSelection:false`
   *  is what keeps the caret put: insertContentAt otherwise jumps the
   *  selection to the end of the inserted content. */
  function appendFilePillsAt(ed: NonNullable<typeof editor>, files: FilePillEntry[]) {
    if (files.length === 0) return;
    // textOffsetToPos(0) on an EMPTY doc resolves to position 0 ("before the
    // paragraph"), which is not a valid inline insert spot — appending to an
    // empty doc inserts at doc.content.size (the paragraph's end) instead.
    const at = ed.isEmpty
      ? ed.state.doc.content.size
      : textOffsetToPos(ed, textWithSkills(ed).length);
    ed.chain()
      .insertContentAt(at, filePillContent(files), { updateSelection: false })
      .run();
  }

  /** Convert plain `@<basename>` markers into file pills in place. The match
   *  uses the SAME whole-name boundary rule as the stream-side inline renderer
   *  (Markdown.tsx: `@name(?![A-Za-z0-9_-])`) so a converted pill occupies
   *  exactly the text the marker occupied. Replacements run right-to-left —
   *  earlier offsets stay valid because a pill serializes to the same-length
   *  `@name` text, but computing fresh positions per replacement is the
   *  robust way. Files with no marker in the text are appended at the end. */
  function convertFileMarkersToPillsImpl(
    ed: NonNullable<typeof editor>,
    files: FilePillEntry[],
  ) {
    if (files.length === 0) return;
    const text = textWithSkills(ed);
    type Found = { file: FilePillEntry; start: number; end: number };
    const found: Found[] = [];
    const missing: FilePillEntry[] = [];
    for (const file of files) {
      if (!file.label) {
        missing.push(file);
        continue;
      }
      const escaped = file.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = new RegExp(`@${escaped}(?![A-Za-z0-9_-])`).exec(text);
      if (m) found.push({ file, start: m.index, end: m.index + m[0].length });
      else missing.push(file);
    }
    found.sort((a, b) => b.start - a.start);
    for (const { file, start, end } of found) {
      const from = textOffsetToPos(ed, start);
      const to = textOffsetToPos(ed, end);
      // updateSelection:false — conversions run during draft/queue restores;
      // each default-true insert would drag the caret to that marker (the
      // LEFTMOST one wins, since replacements run right-to-left), so the
      // restored caret would end up mid-text instead of at the end.
      ed.chain()
        .deleteRange({ from, to })
        .insertContentAt(
          from,
          {
            type: "fileMention",
            attrs: {
              id: file.path,
              label: file.label,
              mentionSuggestionChar: "@",
            } satisfies MentionNodeAttrs,
          },
          { updateSelection: false },
        )
        .run();
    }
    if (missing.length > 0) appendFilePillsAt(ed, missing);
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
      insertText: (text) => {
        if (!editor) return;
        editor.chain().focus().insertContent(text).run();
      },
      getHTML: () => editor?.getHTML() ?? "",
      setHTML: (html) => {
        if (!editor) return;
        editor.commands.setContent(html);
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
      insertFilePills: (files, start, end) => {
        if (!editor || files.length === 0) return;
        insertFilePillsAt(editor, files, start, end);
      },
      appendFilePills: (files) => {
        if (!editor) return;
        appendFilePillsAt(editor, files);
      },
      convertFileMarkersToPills: (files) => {
        if (!editor) return;
        convertFileMarkersToPillsImpl(editor, files);
      },
      getFilePillPaths: () => {
        if (!editor) return [];
        const paths: string[] = [];
        editor.state.doc.descendants((node) => {
          if (node.type.name === "fileMention" && node.attrs.id) {
            paths.push(node.attrs.id as string);
          }
        });
        return paths;
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
      replaceTextRange: (start, end, text) => {
        if (!editor) return;
        const from = textOffsetToPos(editor, start);
        const to = textOffsetToPos(editor, end);
        const at = Math.min(from, to);
        editor
          .chain()
          .focus()
          .deleteRange({ from: at, to: Math.max(from, to) })
          .insertContentAt(at, text)
          // Pure-text insertion advances the caret by the text length.
          .setTextSelection(at + text.length)
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
          } else if (node.type.name === "skill" || node.type.name === "fileMention") {
            const len = pillText(node).length;
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
