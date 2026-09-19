/**
 * AutomationEditor — create/edit dialog for scheduled tasks, launched from
 * the right panel's sched tab (header「新建」/ footer「编辑」). Saves through
 * the same automation.save channel as the composer flow (id present =
 * update in place; main recomputes nextRunAt) minus the composer-only
 * receipt message. Form fields mirror the task's definition: title, prompt,
 * skills (SDK allowlist), file references, execution config (controlled
 * four-slot — never the global composer slots), trigger rule (ScheduleEditor
 * with its live next-run preview) and retention.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Automation, AutomationSchedule } from "@contracts/automation";
import type { AutomationSaveInput, ProviderInfo } from "@contracts/ipc";
import type { BuiltinModelOption } from "@contracts/provider";
import type { CustomModelPublic } from "@contracts/customModel";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { Input } from "@renderer/components/ui/input.js";
import { Select } from "@renderer/components/ui/select.js";
import { IconPlus, IconX } from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { ScheduleEditor } from "./ScheduleEditor.js";
import { SlashCommandPicker } from "@renderer/components/chat/SlashCommandPicker.js";
import { FileMentionPicker } from "@renderer/components/chat/FileMentionPicker.js";

interface ModelOption {
  id: string;
  label: string;
  customModelId: string | null;
}

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

/** Dictionary-backed effort labels; unknown capability values fall back to
 *  the provider's own label. */
const EFFORT_DICT_VALUES = ["default", "low", "medium", "high"];

/** Model surface for one provider, mirroring ModelDropdown's selectable set
 *  minus its guard machinery: built-ins + custom-endpoint entries (pi/codex
 *  carry dynamic model tables instead). "default" always first. */
function modelOptionsFor(
  provider: ProviderInfo | undefined,
  customModels: CustomModelPublic[],
  piModels: BuiltinModelOption[],
  codexModels: BuiltinModelOption[],
  defaultLabel: string,
): ModelOption[] {
  const out: ModelOption[] = [{ id: "default", label: defaultLabel, customModelId: null }];
  if (provider?.id === "pi-sdk") {
    for (const m of piModels) out.push({ id: m.id, label: m.label || m.id, customModelId: null });
    return out;
  }
  if (provider?.id === "codex-sdk") {
    for (const m of codexModels) out.push({ id: m.id, label: m.label || m.id, customModelId: null });
    return out;
  }
  for (const b of provider?.capabilities.builtinModels ?? []) {
    if (b.id === "default") continue;
    out.push({ id: b.id, label: b.label, customModelId: null });
  }
  for (const cfg of customModels) {
    for (const m of cfg.models) {
      if (!m.id.trim()) continue;
      out.push({ id: m.id, label: `${cfg.name} · ${m.id}`, customModelId: cfg.id });
    }
  }
  return out;
}

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
  const { t, locale } = useI18n();
  const providers = useSessionStore((s) => s.providers);
  const customModels = useSessionStore((s) => s.customModels);
  const piModels = useSessionStore((s) => s.piAvailableModels);
  const codexModels = useSessionStore((s) => s.codexAvailableModels);
  const projects = useSessionStore((s) => s.projects);
  const skills = useSessionStore((s) => s.skills);
  const saveAutomation = useSessionStore((s) => s.saveAutomation);

  const [draft, setDraft] = useState<EditorDraft>(DEFAULT_DRAFT);
  const [saving, setSaving] = useState(false);
  const [showError, setShowError] = useState(false);

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
  useEffect(() => {
    if (!open) return;
    setShowError(false);
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

  const provider = providers.find((p) => p.id === draft.providerId);
  const modelOptions = useMemo(
    () =>
      modelOptionsFor(provider, customModels, piModels, codexModels, t("automation.modelDefault")),
    [provider, customModels, piModels, codexModels, t],
  );
  const effortOptions = provider?.capabilities.thinkingLevels ?? [];
  const permOptions = (provider?.capabilities.permissionModes ?? []).filter(
    (m) => m.value !== "plan",
  );
  const effortLabel = (v: string): string | null =>
    EFFORT_DICT_VALUES.includes(v)
      ? translate(locale, `automation.effort.${v}` as MessageId)
      : null;

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
        (draft.prompt.trim().split("\n")[0] ?? "").trim().slice(0, 40) ||
        t("automation.formUntitled");
      const input: AutomationSaveInput = {
        ...(task ? { id: task.id } : {}),
        projectId: owner.projectId,
        ...(owner.parentSessionId && !task ? { parentSessionId: owner.parentSessionId } : {}),
        title,
        prompt: draft.prompt.trim(),
        skillNames: draft.skillNames,
        filePaths: draft.filePaths,
        providerId: draft.providerId,
        model: draft.model,
        customModelId: draft.customModelId,
        effort: draft.effort,
        permissionMode: draft.permissionMode,
        schedule: draft.schedule,
        // Editing never flips the switch — enable/disable is a dedicated
        // footer action, not a side effect of editing.
        enabled: task ? task.enabled : true,
        keepRuns: draft.keepRuns,
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
  const optionBtn =
    "max-w-[220px] shrink-0 items-center gap-1 rounded-md border border-input-edge bg-surface px-2 py-1 text-[11px] text-content hover:border-accent";
  const chipBtn =
    "flex items-center gap-0.5 rounded-full border border-dashed border-input-edge px-2 py-0.5 text-[10.5px] text-content-subtle hover:border-accent hover:text-accent";

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[86vh] w-[400px] flex-col">
          <Dialog.Title className="px-4 pb-1 pt-3.5">
            {task ? t("automation.editorEditTitle") : t("automation.editorCreateTitle")}
          </Dialog.Title>
          <Dialog.Close />

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3">
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

            {/* title + prompt */}
            <label className="flex flex-col gap-1">
              <span className={fieldLabel}>{t("automation.fieldName")}</span>
              <Input
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder={t("automation.editorTitlePlaceholder")}
                className="w-full"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={fieldLabel}>{t("automation.sectionContent")}</span>
              <textarea
                value={draft.prompt}
                onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
                placeholder={t("automation.promptPlaceholder")}
                rows={4}
                className={cn(
                  "w-full resize-y rounded-md border border-input-edge bg-surface px-2.5 py-1.5 text-xs text-content",
                  "placeholder:text-content-subtle focus:border-accent focus:outline-none",
                  showError && !promptOk && "border-danger",
                )}
              />
              {showError && !promptOk && (
                <span className="text-[10.5px] text-danger">
                  {t("automation.editorPromptRequired")}
                </span>
              )}
            </label>

            {/* skills chips */}
            <div className="flex flex-col gap-1">
              <span className={fieldLabel}>{t("automation.fieldSkills")}</span>
              <div className="flex flex-wrap items-center gap-1">
                {draft.skillNames.map((name) => (
                  <span
                    key={name}
                    className="flex items-center gap-1 rounded-full border border-edge bg-surface-muted px-2 py-0.5 text-[10.5px] text-content-muted"
                  >
                    /{name}
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
                  </span>
                ))}
                <button
                  ref={skillAnchorRef}
                  type="button"
                  onClick={() => setSkillPickerOpen(true)}
                  className={chipBtn}
                >
                  <IconPlus size={10} />
                </button>
              </div>
            </div>

            {/* file chips */}
            <div className="flex flex-col gap-1">
              <span className={fieldLabel}>{t("automation.fieldFiles")}</span>
              <div className="flex flex-wrap items-center gap-1">
                {draft.filePaths.map((p) => (
                  <span
                    key={p}
                    className="flex max-w-[220px] items-center gap-1 rounded-full border border-edge bg-surface-muted px-2 py-0.5 text-[10.5px] text-content-muted"
                  >
                    <span className="truncate">@{p}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((d) => ({ ...d, filePaths: d.filePaths.filter((f) => f !== p) }))
                      }
                      className="shrink-0 rounded-full p-0.5 hover:bg-surface-hover hover:text-content"
                    >
                      <IconX size={9} />
                    </button>
                  </span>
                ))}
                <button
                  ref={fileAnchorRef}
                  type="button"
                  onClick={() => setFilePickerOpen(true)}
                  className={chipBtn}
                >
                  <IconPlus size={10} />
                </button>
              </div>
            </div>

            {/* execution config — controlled four-slot */}
            <div className="flex flex-col gap-1">
              <span className={fieldLabel}>{t("automation.sectionBasics")}</span>
              <div className="flex flex-wrap gap-1.5">
                <Select.Root
                  value={draft.providerId}
                  onValueChange={(v) => switchProvider(String(v))}
                >
                  <Select.Trigger className={optionBtn}>
                    <Select.Value>
                      {(val: string) => (
                        <span className="truncate">
                          {providers.find((p) => p.id === val)?.displayName ?? val}
                        </span>
                      )}
                    </Select.Value>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Positioner>
                      <Select.Popup>
                        <Select.List>
                          {providers.map((p) => (
                            <Select.Item key={p.id} value={p.id}>
                              <Select.ItemText>{p.displayName}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.List>
                      </Select.Popup>
                    </Select.Positioner>
                  </Select.Portal>
                </Select.Root>

                <Select.Root
                  value={modelOptions.some((m) => m.id === draft.model) ? draft.model : "default"}
                  onValueChange={(v) => {
                    const hit =
                      modelOptions.find((m) => m.id === String(v)) ?? modelOptions[0] ?? null;
                    if (hit)
                      setDraft((d) => ({ ...d, model: hit.id, customModelId: hit.customModelId }));
                  }}
                >
                  <Select.Trigger className={optionBtn}>
                    <Select.Value>
                      {(val: string) => (
                        <span className="truncate">
                          {modelOptions.find((m) => m.id === val)?.label ?? val}
                        </span>
                      )}
                    </Select.Value>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Positioner>
                      <Select.Popup>
                        <Select.List>
                          {modelOptions.map((m) => (
                            <Select.Item
                              key={`${m.customModelId ?? "-"}:${m.id}`}
                              value={m.id}
                            >
                              <Select.ItemText>{m.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.List>
                      </Select.Popup>
                    </Select.Positioner>
                  </Select.Portal>
                </Select.Root>

                {effortOptions.length > 0 && (
                  <Select.Root
                    value={
                      effortOptions.some((e) => e.value === draft.effort)
                        ? draft.effort
                        : (effortOptions[0]?.value ?? "default")
                    }
                    onValueChange={(v) => setDraft((d) => ({ ...d, effort: String(v) }))}
                  >
                    <Select.Trigger className={optionBtn}>
                      <Select.Value>
                        {(val: string) => (
                          <span className="truncate">
                            {effortLabel(val) ?? (effortOptions.find((e) => e.value === val)?.label ?? val)}
                          </span>
                        )}
                      </Select.Value>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Positioner>
                        <Select.Popup>
                          <Select.List>
                            {effortOptions.map((e) => (
                              <Select.Item key={e.value} value={e.value}>
                                <Select.ItemText>
                                  {effortLabel(e.value) ?? e.label}
                                </Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.List>
                        </Select.Popup>
                      </Select.Positioner>
                    </Select.Portal>
                  </Select.Root>
                )}

                {permOptions.length > 0 && (
                  <Select.Root
                    value={
                      permOptions.some((m) => m.value === draft.permissionMode)
                        ? draft.permissionMode
                        : "acceptEdits"
                    }
                    onValueChange={(v) => setDraft((d) => ({ ...d, permissionMode: String(v) }))}
                  >
                    <Select.Trigger className={optionBtn}>
                      <Select.Value>
                        {(val: string) => (
                          <span className="truncate">
                            {val === "default"
                              ? t("automation.perm.default")
                              : val === "acceptEdits"
                                ? t("automation.perm.acceptEdits")
                                : val === "bypassPermissions"
                                  ? t("automation.perm.bypassPermissions")
                                  : (permOptions.find((m) => m.value === val)?.label ?? val)}
                          </span>
                        )}
                      </Select.Value>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Positioner>
                        <Select.Popup>
                          <Select.List>
                            {permOptions.map((m) => (
                              <Select.Item key={m.value} value={m.value}>
                                <Select.ItemText>
                                  {m.value === "default"
                                    ? t("automation.perm.default")
                                    : m.value === "acceptEdits"
                                      ? t("automation.perm.acceptEdits")
                                      : m.value === "bypassPermissions"
                                        ? t("automation.perm.bypassPermissions")
                                        : m.label}
                                </Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.List>
                        </Select.Popup>
                      </Select.Positioner>
                    </Select.Portal>
                  </Select.Root>
                )}
              </div>
            </div>

            {/* trigger rule */}
            <div className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{t("automation.sectionSchedule")}</span>
              <ScheduleEditor
                schedule={draft.schedule}
                onChange={(schedule) => setDraft((d) => ({ ...d, schedule }))}
              />
            </div>

            {/* retention */}
            <div className="flex flex-col gap-1">
              <span className={fieldLabel}>{t("automation.fieldKeep")}</span>
              <div className="flex items-center gap-1.5">
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
              </div>
            </div>
          </div>

          {/* footer */}
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-edge px-4 py-2.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-input-edge px-3 py-1 text-[11.5px] font-semibold text-content-muted hover:bg-surface-hover hover:text-content"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || (!promptOk && showError)}
              className={cn(
                "rounded-md bg-accent px-3 py-1 text-[11.5px] font-semibold text-accent-contrast hover:brightness-110",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {t("automation.save")}
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
