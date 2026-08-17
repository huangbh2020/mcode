import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
// Monaco worker config (local instance, no CDN). Must run before any <Editor>
// mounts. See monacoSetup.ts. Same side-effect import as FileEditor - since
// PlanViewer can render without FileEditor ever mounting (plan tab active,
// no file open), we need the worker setup here too.
import "@renderer/lib/monacoSetup.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useMonacoTheme } from "../ide/FileEditor.js";
import {
  IconClipboard,
  IconPencil,
  IconCheck,
  IconX,
  IconDeviceFloppy,
  IconEye,
} from "@renderer/lib/icons.js";
import { Markdown } from "./Markdown.js";

/**
 * Plan content viewer rendered in the center-pane editor column (replacing
 * FileEditor when a plan is being viewed). Shows the full plan markdown in a
 * scrollable reading view with a header bar containing the title + actions.
 *
 * Two modes:
 *  - Read (default): renders the plan markdown via <Markdown>.
 *  - Edit: renders a Monaco editor (markdown language) so the user can edit
 *    the plan text. Saving (Ctrl+S or the 保存 button) writes the edited text
 *    back:
 *      * If a plan approval is pending (isApprovalPending), the draft is staged
 *        into planApprovalDraftBySession - PlanApprovalPrompt picks it up and
 *        the user still confirms via 批准并执行. Editing never auto-approves.
 *      * Otherwise (viewing a historical/frozen plan), the local view text is
 *        updated (planDrawerPlanBySession) so the reading view reflects edits.
 *
 * Triggered when the user clicks a plan card in the message stream, a plan
 * title in the activity popover, or the "编辑计划" action in the approval
 * prompt - all of which call openPlanDrawer, storing the plan text in
 * planDrawerPlanBySession. EditorColumn renders this component instead of
 * FileEditor when planTabActive is true and that field is non-null.
 *
 * Closing (X button or Escape in read mode) clears the plan view, falling
 * back to the file editor (if a file was previously active) or hiding the
 * editor column. In edit mode, Escape cancels the edit first (mirrors the
 * FileEditor / dialog convention).
 *
 * Theme: neutral surface matching the editor column. The Markdown body uses
 * `prose-plan` styling, consistent with the inline PlanStreamBlock preview.
 */

/** Unique Monaco model path for the plan editor. Using a stable path keeps a
 *  single model so undo history persists across read/edit toggles within one
 *  open. The .md extension sets the language to markdown. */
const PLAN_EDITOR_PATH = "__plan__.md";

export function PlanViewer({
  plan,
  sessionId,
  isApprovalPending,
  onClose,
}: {
  plan: string;
  sessionId: string;
  /** True when an ExitPlanMode approval is pending - saving in edit mode
   *  stages the draft for the approval sheet instead of just updating the
   *  local view. */
  isApprovalPending: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  // The in-progress edit text. Re-seeded from `plan` whenever editing opens or
  // the upstream plan text changes (e.g. a new approval_request supersedes).
  const [draft, setDraft] = useState(plan);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const updatePlanDrawerPlan = useSessionStore((s) => s.updatePlanDrawerPlan);
  const setPlanApprovalDraft = useSessionStore((s) => s.setPlanApprovalDraft);

  // Project root for the session owning this plan (so file paths mentioned in
  // the plan markdown resolve to the right project). Resolved via sessionId ->
  // projectId -> projects[].path, mirroring ChatPane's session-keyed lookup.
  const projectPath = useSessionStore((s) => {
    let pid: string | undefined;
    for (const list of Object.values(s.sessionsByProject)) {
      const found = list?.find((x) => x.id === sessionId);
      if (found) {
        pid = found.projectId;
        break;
      }
    }
    if (!pid) return null;
    return s.projects.find((p) => p.id === pid)?.path ?? null;
  });

  const theme = useMonacoTheme();

  // Keep the draft in sync with the upstream plan while NOT editing - so a
  // new plan.update / approval_request is reflected in the read view and the
  // edit seed is fresh when the user enters edit mode. While editing, the
  // draft is the source of truth (user edits win).
  useEffect(() => {
    if (!editing) setDraft(plan);
  }, [plan, editing]);

  const dirty = editing && draft !== plan;

  const handleSave = useCallback(() => {
    if (!editing) return;
    setSaveState("saving");
    try {
      // Always update the local view text so the read mode reflects edits.
      updatePlanDrawerPlan(sessionId, draft);
      // Stage into the approval draft so PlanApprovalPrompt picks it up. Do
      // this unconditionally (not only when isApprovalPending) - the draft is
      // harmless if no approval is pending, and if an approval arrives later
      // in the same view session the staged edit would be the user's intent.
      // But to avoid leaving a stale draft around for a historical plan, only
      // stage when an approval is actually pending.
      if (isApprovalPending) {
        setPlanApprovalDraft(sessionId, draft);
      }
      setSaveState("saved");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveState("idle"), 1500);
    } catch {
      setSaveState("error");
    }
  }, [editing, sessionId, draft, isApprovalPending, updatePlanDrawerPlan, setPlanApprovalDraft]);

  // Wire Ctrl+S / Cmd+S to save. Monaco passes its monaco namespace into
  // onMount, which is where we register the keybinding.
  const handleEditorMount = useCallback(
    (editor_: editor.IStandaloneCodeEditor, monaco: typeof import("monaco-editor")) => {
      editorRef.current = editor_;
      editor_.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void handleSave();
      });
    },
    [handleSave],
  );

  // Enter edit mode: seed the draft from the current plan text.
  const enterEdit = useCallback(() => {
    setDraft(plan);
    setEditing(true);
  }, [plan]);

  // Cancel edit: discard the draft and drop back to read mode.
  const cancelEdit = useCallback(() => {
    setDraft(plan);
    setEditing(false);
  }, [plan]);

  // Esc closes the plan view in read mode; in edit mode it cancels the edit
  // first (matches the dialog / drawer convention).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (editing) cancelEdit();
        else onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [editing, cancelEdit, onClose]);

  // Clear the saved-indicator timer on unmount.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header - sticky title bar with edit / save / close actions. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge px-3 py-2">
        <IconClipboard size={15} className="shrink-0 text-content-subtle" />
        <span className="text-xs font-semibold text-content">{t("chat.planViewer.title")}</span>
        {isApprovalPending && (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            {t("chat.plan.pendingReview")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {editing ? (
            <>
              <button
                type="button"
                onClick={cancelEdit}
                title={t("chat.planViewer.cancelEdit")}
                aria-label={t("chat.planViewer.cancelEdit")}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-content-muted transition-colors",
                  "hover:bg-surface-muted hover:text-content",
                )}
              >
                <IconX size={13} />
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!dirty}
                title={dirty ? t("chat.planViewer.saveTitle") : t("chat.planViewer.noChanges")}
                aria-label={t("common.save")}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] transition-colors",
                  dirty
                    ? "bg-accent/15 text-accent hover:bg-accent/25"
                    : "text-content-subtle",
                )}
              >
                <IconDeviceFloppy size={13} />
                {t("common.save")}
              </button>
              <button
                type="button"
                onClick={() => {
                  // Save before switching back to read mode so unsaved edits
                  // aren't silently dropped.
                  if (dirty) handleSave();
                  setEditing(false);
                }}
                title={t("chat.planViewer.finishTitle")}
                aria-label={t("chat.planViewer.finish")}
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-md text-content-muted transition-colors",
                  "hover:bg-surface-muted hover:text-content",
                )}
              >
                <IconEye size={14} />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={enterEdit}
              title={t("chat.plan.editPlan")}
              aria-label={t("chat.plan.editPlan")}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-content-muted transition-colors",
                "hover:bg-surface-muted hover:text-content",
              )}
            >
              <IconPencil size={13} />
              {t("common.edit")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title={t("chat.planViewer.close")}
            aria-label={t("chat.planViewer.close")}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-md text-content-muted transition-colors",
              "hover:bg-surface-muted hover:text-content",
            )}
          >
            <IconX size={15} />
          </button>
        </div>
      </div>
      {/* Body - editor (edit mode) or rendered markdown (read mode). */}
      <div className="relative min-h-0 flex-1">
        {editing ? (
          <Editor
            height="100%"
            path={PLAN_EDITOR_PATH}
            language="markdown"
            value={draft}
            theme={theme}
            onChange={(value) => setDraft(value ?? "")}
            onMount={handleEditorMount}
            loading={<div className="text-[11px] text-content-subtle">{t("chat.planViewer.loading")}</div>}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              tabSize: 2,
              automaticLayout: true,
              renderWhitespace: "selection",
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            }}
          />
        ) : (
          <div className="h-full overflow-auto p-4">
            <div className="prose-plan text-[13px] leading-relaxed text-content">
              <Markdown projectPath={projectPath}>{plan || t("chat.planViewer.empty")}</Markdown>
            </div>
          </div>
        )}
        {/* Save status toast - bottom-right, non-blocking. Mirrors FileEditor. */}
        {saveState !== "idle" && (
          <div
            className={cn(
              "pointer-events-none absolute bottom-3 right-3 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] shadow-sm",
              saveState === "saving" && "bg-surface text-content-muted",
              saveState === "saved" && "bg-accent/15 text-accent",
              saveState === "error" && "bg-danger/15 text-danger",
            )}
          >
            {saveState === "saving" && <IconCheck size={12} />}
            {saveState === "saved" && <IconCheck size={12} />}
            {saveState === "saving" && <span>{t("chat.planViewer.saving")}</span>}
            {saveState === "saved" && <span>{t("chat.planViewer.saved")}</span>}
            {saveState === "error" && <span>{t("chat.planViewer.saveFailed")}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
