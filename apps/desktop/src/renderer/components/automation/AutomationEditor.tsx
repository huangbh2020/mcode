/**
 * AutomationEditor — create/edit dialog for scheduled tasks, launched from
 * the right panel's sched tab (header「新建」/ row click「编辑」). Saves through
 * the same automation.save channel as the composer flow (id present =
 * update in place; main recomputes nextRunAt) minus the composer-only
 * receipt message. Form fields mirror the task's definition: title, prompt,
 * skills (SDK allowlist), file references, execution config (controlled
 * four-slot — never the global composer slots), trigger rule (ScheduleEditor
 * with its live next-run preview) and retention.
 *
 * Edit policy (2026-09-20): editing opens up ONLY the schedule rule, the
 * execution four-slot (SDK / model / effort / permission) and the task
 * content (title + prompt). Skills, file references and retention are part
 * of the task's identity — they render read-only (no chips add/remove, no
 * input) and the save payload echoes the ORIGINAL row's values for them, so
 * a stale draft can never rewrite what it must not touch.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Automation, AutomationSchedule } from "@contracts/automation";
import type { AutomationSaveInput } from "@contracts/ipc";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { Input } from "@renderer/components/ui/input.js";
import { IconClock, IconPlus, IconSend2, IconX } from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { ComposerEditor, type ComposerEditorHandle } from "@renderer/components/chat/ComposerEditor.js";
import {
  EffortChip,
  PermissionChip,
} from "@renderer/components/chat/EffortPermissionControl.js";
import { ModelDropdown } from "@renderer/components/chat/ModelDropdown.js";
import { ProviderDropdown } from "@renderer/components/chat/ProviderDropdown.js";
import { ScheduleEditor } from "./ScheduleEditor.js";
import { describeSchedule } from "./automationFormat.js";
import { SlashCommandPicker } from "@renderer/components/chat/SlashCommandPicker.js";
import { FileMentionPicker } from "@renderer/components/chat/FileMentionPicker.js";

interface EditorDraft {
  title: string;
  prompt: string;
  skillNames: string[];
  filePaths: string[];
  providerId: string;
  model: string;
  customModelId: string | null;
  effort: string;
  permissionMode: string;
  schedule: AutomationSchedule;
  keepRuns: number;
}

const DEFAULT_DRAFT: EditorDraft = {
  title: "",
  prompt: "",
  skillNames: [],
  filePaths: [],
  providerId: "claude-sdk",
  model: "default",
  customModelId: null,
  effort: "default",
  permissionMode: "acceptEdits",
  schedule: { type: "daily", time: "09:00" },
  keepRuns: 20,
};

export function AutomationEditor({
  open,
  task,
  onClose,
  onSaved,
  scopeSessionId,
}: {
  open: boolean;
  /** Edit target; null = create mode. */
  task: Automation | null;
  onClose: () => void;
  /** Fired after a successful save with the fresh row (lets the host select
   *  a newly created task). */
  onSaved?: (saved: Automation) => void;
  /** The session the panel is scoped to (create-mode owner). Falls back to
   *  the active session; an automation-kind scope resolves to its parent. */
  scopeSessionId?: string | null;
}) {
  const { t } = useI18n();
  const providers = useSessionStore((s) => s.providers);
  const projects = useSessionStore((s) => s.projects);
  const skills = useSessionStore((s) => s.skills);
  const saveAutomation = useSessionStore((s) => s.saveAutomation);

  const [draft, setDraft] = useState<EditorDraft>(DEFAULT_DRAFT);
  const [saving, setSaving] = useState(false);
  const [showError, setShowError] = useState(false);
  /* Schedule panel collapse — mirrors the chat composer's ScheduleChip: the
   * rule lives behind a chip above the card; the panel starts open on create
   * (the user must pick a rule) and collapsed on edit. Reset per open. */
  const [schedOpen, setSchedOpen] = useState(false);

  /** Edit mode gates the mutable surface: only schedule + exec four-slot +
   *  content (title/prompt) stay editable; skills / files / retention are
   *  locked (read-only display, original values echoed on save). */
  const editing = task != null;

  /* Owner (project + initiator) is derived once per dialog open, not
   * editable: the project decides where runs execute, the initiator only
   * feeds the left-bar badge / filter. Create falls back to the active chat
   * session's project, then the first project. Exec config defaults to the
   * CURRENT composer slots so a panel-created task runs on the same
   * endpoint the user is actually using — hardcoding claude-sdk/default
   * produced runs against default credential discovery ("Not logged in"
   * on custom-endpoint setups). */
  const owner = useMemo(() => {
    if (task) {
      return {
        projectId: task.projectId,
        parentSessionId: task.parentSessionId,
        exec: null,
      };
    }
    const st = useSessionStore.getState();
    const sid = scopeSessionId ?? st.activeSessionId;
    const scope = sid ? st.getSessionById(sid) : undefined;
    // An automation-kind scope (its transcript tab) re-aims at the
    // session that spawned the task.
    const chat =
      scope?.kind === "automation"
        ? (scope.parentSessionId ? st.getSessionById(scope.parentSessionId) : undefined)
        : scope;
    return {
      projectId: chat?.projectId ?? st.projects[0]?.id ?? null,
      parentSessionId: chat && chat.kind === "chat" ? chat.id : null,
      exec: {
        providerId: st.providerId,
        model: st.model,
        customModelId: st.customModelId,
        effort: st.effort,
        permissionMode: st.permissionMode,
      },
    };
    // Re-derive per open / edit-target only.
  }, [open, task, scopeSessionId]);

  const project = projects.find((p) => p.id === owner.projectId) ?? null;
  const parentTitle = owner.parentSessionId
    ? (useSessionStore.getState().getSessionById(owner.parentSessionId)?.title ?? null)
    : null;

  /* Fresh draft per open / per edited task (scheduler pushes replace the
   * automations array, so identity-on-open is the right re-init signal). */
  const editorRef = useRef<ComposerEditorHandle>(null);
  useEffect(() => {
    if (!open) return;
    // The chat composer is an imperative Tiptap host that starts empty —
    // seed the task's prompt after each open (retry once in case the editor
    // instance isn't up yet on the same tick).
    const seed = task?.prompt ?? "";
    if (!seed) return;
    const apply = (): boolean => {
      if (!editorRef.current) return false;
      editorRef.current.setText(seed);
      return true;
    };
    if (!apply()) {
      const timer = window.setTimeout(() => apply(), 50);
      return () => window.clearTimeout(timer);
    }
  }, [open, task]);

  useEffect(() => {
    if (!open) return;
    setShowError(false);
    setSchedOpen(!task);
    setDraft(
      task
        ? {
            title: task.title,
            prompt: task.prompt,
            skillNames: [...task.skillNames],
            filePaths: [...task.filePaths],
            providerId: task.providerId,
            model: task.model,
            customModelId: task.customModelId,
            effort: task.effort,
            permissionMode: task.permissionMode,
            schedule: task.schedule,
            keepRuns: task.keepRuns,
          }
        : { ...DEFAULT_DRAFT, ...(owner.exec ?? {}) },
    );
  }, [open, task, owner]);

  const draftProvider = providers.find((p) => p.id === draft.providerId);
  const draftPermModes = (draftProvider?.capabilities.permissionModes ?? []).filter(
    (m) => m.value !== "plan",
  );
  const hasEffort = (draftProvider?.capabilities.thinkingLevels?.length ?? 0) > 0;
  const hasPerm = draftPermModes.length > 0;

  const switchProvider = (nextId: string): void => {
    const next = providers.find((p) => p.id === nextId);
    const efforts = next?.capabilities.thinkingLevels ?? [];
    const perms = (next?.capabilities.permissionModes ?? []).filter((m) => m.value !== "plan");
    setDraft((d) => ({
      ...d,
      providerId: nextId,
      model: "default",
      customModelId: null,
      effort: efforts.some((e) => e.value === d.effort)
        ? d.effort
        : (efforts[0]?.value ?? "default"),
      permissionMode: perms.some((m) => m.value === d.permissionMode)
        ? d.permissionMode
        : "acceptEdits",
    }));
  };

  /* Skills: "+" opens the slash picker (skills only — built-in commands are
   * chat behaviors). Picked names ride the SDK allowlist, so they are kept
   * as chips; "/name" is never injected into the prompt text. */
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const skillAnchorRef = useRef<HTMLButtonElement | null>(null);
  const fileAnchorRef = useRef<HTMLButtonElement | null>(null);

  const promptOk = draft.prompt.trim().length > 0;
  const ownerOk = owner.projectId !== null;

  const save = async (): Promise<void> => {
    if (!promptOk || !ownerOk || saving) {
      setShowError(true);
      return;
    }
    setSaving(true);
    try {
      const title =
        draft.title.trim() ||
        (draft.prompt.trim().slice(0, 40) + (draft.prompt.trim().length > 40 ? "…" : "")) ||
        t("automation.formUntitled");
      const input: AutomationSaveInput = {
        ...(task ? { id: task.id } : {}),
        projectId: owner.projectId,
        ...(owner.parentSessionId && !task ? { parentSessionId: owner.parentSessionId } : {}),
        title,
        prompt: draft.prompt.trim(),
        // Locked fields in edit mode: echo the ORIGINAL row's values (the UI
        // already renders them read-only; this guards against any stale-draft
        // drift ever rewriting what the edit policy forbids).
        skillNames: task ? task.skillNames : draft.skillNames,
        filePaths: task ? task.filePaths : draft.filePaths,
        providerId: draft.providerId,
        model: draft.model,
        customModelId: draft.customModelId,
        effort: draft.effort,
        permissionMode: draft.permissionMode,
        schedule: draft.schedule,
        // Editing never flips the switch — enable/disable is a dedicated
        // footer action, not a side effect of editing.
        enabled: task ? task.enabled : true,
        keepRuns: task ? task.keepRuns : draft.keepRuns,
      };
      const saved = await saveAutomation(input);
      if (saved) {
        onSaved?.(saved);
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  const fieldLabel = "text-[11px] font-semibold text-content-muted";
  const chipBtn =
    "flex items-center gap-0.5 rounded-full border border-dashed border-input-edge px-2 py-0.5 text-[10.5px] text-content-subtle hover:border-accent hover:text-accent";
  /** Section label; locked sections carry the「创建后不可修改」hint in edit
   *  mode so the read-only chips don't read as a rendering bug. */
  const sectionLabel = (key: "automation.fieldSkills" | "automation.fieldFiles" | "automation.fieldKeep") => (
    <span className={fieldLabel}>
      {t(key)}
      {editing && (
        <span className="ml-1 font-normal text-content-subtle">
          · {t("automation.editLocked")}
        </span>
      )}
    </span>
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[86vh] w-[520px] flex-col">
          <Dialog.Title className="px-4 pb-1 pt-3.5">
            {task ? t("automation.editorEditTitle") : t("automation.editorCreateTitle")}
          </Dialog.Title>
          <Dialog.Close />

          {/* data-chat-root brings the [data-chat-root]-scoped composer styles
              (composer-card / minipill / action-row polish) into the dialog —
              the same scope ChatPane's root declares. */}
          <div
            data-chat-root
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3"
          >
            {/* owner line */}
            <div className="rounded-lg border border-edge bg-surface-muted px-2.5 py-1.5 text-[11px] text-content-muted">
              {ownerOk ? (
                <>
                  {t("automation.ownerProject")}: {project?.name ?? owner.projectId}
                  {" · "}
                  {t("automation.ownerParent")}: {parentTitle ?? t("automation.ownerNone")}
                </>
              ) : (
                <span className="text-warning">{t("automation.needProject")}</span>
              )}
            </div>

            {/* title */}
            <label className="flex flex-col gap-1">
              <span className={fieldLabel}>{t("automation.fieldName")}</span>
              <Input
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder={t("automation.editorTitlePlaceholder")}
                className="w-full"
              />
            </label>

            {/* Chips row (chat-composer layout): the schedule chip + skill /
                file chips park ABOVE the input card — same px-1 pb-1 spacing
                as the chat composer's chip strip. Edit mode: no add/remove
                (locked fields render as plain chips). */}
            <div className="flex flex-wrap items-center gap-1 px-1 pb-1">
              <button
                type="button"
                onClick={() => setSchedOpen((o) => !o)}
                title={describeSchedule(draft.schedule)}
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-md border border-dashed px-1.5 text-[11px] transition-colors",
                  schedOpen
                    ? "border-accent text-accent"
                    : "border-edge text-content-muted hover:border-accent hover:text-accent",
                )}
              >
                <IconClock size={12} />
                <span className="max-w-[110px] truncate">
                  {describeSchedule(draft.schedule)}
                </span>
              </button>

              {draft.skillNames.map((name) => (
                <span
                  key={name}
                  className="flex items-center gap-1 rounded-full border border-edge bg-surface-muted px-2 py-0.5 text-[10.5px] text-content-muted"
                >
                  /{name}
                  {!editing && (
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          skillNames: d.skillNames.filter((s) => s !== name),
                        }))
                      }
                      className="rounded-full p-0.5 hover:bg-surface-hover hover:text-content"
                    >
                      <IconX size={9} />
                    </button>
                  )}
                </span>
              ))}
              {!editing && (
                <button
                  ref={skillAnchorRef}
                  type="button"
                  onClick={() => setSkillPickerOpen(true)}
                  className={chipBtn}
                >
                  <IconPlus size={10} />
                </button>
              )}

              {draft.filePaths.map((p) => (
                <span
                  key={p}
                  className="flex max-w-[220px] items-center gap-1 rounded-full border border-edge bg-surface-muted px-2 py-0.5 text-[10.5px] text-content-muted"
                >
                  <span className="truncate">@{p}</span>
                  {!editing && (
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((d) => ({ ...d, filePaths: d.filePaths.filter((f) => f !== p) }))
                      }
                      className="shrink-0 rounded-full p-0.5 hover:bg-surface-hover hover:text-content"
                    >
                      <IconX size={9} />
                    </button>
                  )}
                </span>
              ))}
              {!editing && (
                <button
                  ref={fileAnchorRef}
                  type="button"
                  onClick={() => setFilePickerOpen(true)}
                  className={chipBtn}
                >
                  <IconPlus size={10} />
                </button>
              )}
            </div>

            {/* Trigger-rule panel — collapsed behind the schedule chip above */}
            {schedOpen && (
              <div className="rounded-lg border border-edge bg-surface-muted/40 p-2">
                <ScheduleEditor
                  schedule={draft.schedule}
                  onChange={(schedule) => setDraft((d) => ({ ...d, schedule }))}
                />
              </div>
            )}

            {/* Composer card — a faithful copy of the chat composer's input
                box: same composer-card / composer-action-row / minipill
                class hooks, so every polish layer in styles.css applies via
                the data-chat-root scope on the dialog body. Stripped of the
                chat extras (no queue, no voice mic, no provider lock chip,
                no context ring, no orch toggle); the send button saves. */}
            <div
              className={cn(
                "composer-card relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-edge-input bg-surface transition-all duration-200",
                "focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgb(var(--accent)/0.12)]",
                showError && !promptOk && "border-danger",
              )}
            >
              <ComposerEditor
                ref={editorRef}
                editable
                placeholder={t("automation.promptPlaceholder")}
                onChange={(text) => setDraft((d) => ({ ...d, prompt: text }))}
                onEnter={() => void save()}
                className="px-3 pt-2.5 text-sm leading-relaxed text-content"
              />
              {showError && !promptOk && (
                <span className="px-3 pb-1 text-[10.5px] text-danger">
                  {t("automation.editorPromptRequired")}
                </span>
              )}
              <div className="composer-action-row flex flex-wrap items-center justify-between gap-2 px-2.5 pb-2 pt-1.5">
                <div className="composer-chips flex min-w-0 flex-1 items-center gap-1">
                  <div className="composer-minipill" data-compact="0">
                    {/* SDK segment — the chat provider picker bound to the draft */}
                    <ProviderDropdown
                      segment
                      controller={{
                        providerId: draft.providerId,
                        onChange: (pid) => switchProvider(pid),
                      }}
                    />

                    <span className="composer-minipill-mid" aria-hidden="true" />

                    {/* model segment — the chat model menu bound to the draft */}
                    <ModelDropdown
                      controller={{
                        providerId: draft.providerId,
                        model: draft.model,
                        customModelId: draft.customModelId,
                        onPick: (customModelId, modelId) =>
                          setDraft((d) => ({ ...d, customModelId, model: modelId })),
                      }}
                    />

                    {hasEffort && (
                      <>
                        <span className="composer-minipill-mid" aria-hidden="true" />
                        {/* effort segment — the chat level grid bound to the draft */}
                        <EffortChip
                          controller={{
                            providerId: draft.providerId,
                            value: draft.effort,
                            onChange: (v) => setDraft((d) => ({ ...d, effort: v })),
                          }}
                        />
                      </>
                    )}

                    {hasPerm && (
                      <>
                        <span className="composer-minipill-mid" aria-hidden="true" />
                        {/* permission segment — chat's mode grid; `plan` is
                            filtered out (unattended runs must not land in
                            plan mode) */}
                        <PermissionChip
                          controller={{
                            providerId: draft.providerId,
                            value: draft.permissionMode,
                            onChange: (v) => setDraft((d) => ({ ...d, permissionMode: v })),
                            modes: draftPermModes,
                          }}
                        />
                      </>
                    )}
                  </div>
                </div>
                {/* Right cluster — chat composer's send slot, repurposed as
                    the save action (Enter in the editor saves too). */}
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={saving || !promptOk}
                    title={t("automation.save")}
                    aria-label={t("automation.save")}
                    data-ready={promptOk && !saving ? "1" : "0"}
                    className="composer-send inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent text-surface shadow-sm transition-all duration-150 ease-out hover:scale-110 hover:brightness-110 hover:shadow-md hover:shadow-accent/20 active:scale-95 active:brightness-95 disabled:scale-100 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-content-subtle disabled:shadow-none disabled:hover:scale-100"
                  >
                    <IconSend2 size={16} />
                  </button>
                </div>
              </div>
            </div>

            {/* retention — read-only text in edit mode */}
            <div className="flex flex-col gap-1">
              {sectionLabel("automation.fieldKeep")}
              <div className="flex items-center gap-1.5">
                {editing ? (
                  <span className="text-[11px] text-content-muted">
                    {task?.keepRuns} {t("automation.fieldKeepUnit")}
                  </span>
                ) : (
                  <>
                    <Input
                      type="number"
                      min={1}
                      max={200}
                      value={draft.keepRuns}
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        setDraft((d) => ({
                          ...d,
                          keepRuns: Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : d.keepRuns,
                        }));
                      }}
                      className="w-16"
                    />
                    <span className="text-[11px] text-content-subtle">
                      {t("automation.fieldKeepUnit")}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* footer — cancel only: save lives in the composer's send slot */}
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-edge px-4 py-2.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-input-edge px-3 py-1 text-[11.5px] font-semibold text-content-muted hover:bg-surface-hover hover:text-content"
            >
              {t("common.cancel")}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>

      {/* pickers anchor to their "+" buttons; they own their capture-keyboard
          keybindings and stopPropagation, so the dialog's Esc stays clean. */}
      <SlashCommandPicker
        open={skillPickerOpen}
        query=""
        skills={skills}
        anchorRect={skillAnchorRef.current?.getBoundingClientRect() ?? null}
        busy={false}
        showBuiltIns={false}
        onPickSkill={(skill) => {
          setDraft((d) =>
            d.skillNames.includes(skill.name)
              ? d
              : { ...d, skillNames: [...d.skillNames, skill.name] },
          );
          setSkillPickerOpen(false);
        }}
        onPickCommand={() => setSkillPickerOpen(false)}
        onClose={() => setSkillPickerOpen(false)}
      />
      <FileMentionPicker
        open={filePickerOpen}
        projectPath={project?.path ?? null}
        anchorRect={fileAnchorRef.current?.getBoundingClientRect() ?? null}
        mode="attach"
        excludePaths={draft.filePaths}
        onPick={(files) => {
          setDraft((d) => ({
            ...d,
            filePaths: [...d.filePaths, ...files.map((f) => f.path).filter((p) => !d.filePaths.includes(p))],
          }));
          setFilePickerOpen(false);
        }}
        onClose={() => setFilePickerOpen(false)}
      />
    </Dialog.Root>
  );
}
