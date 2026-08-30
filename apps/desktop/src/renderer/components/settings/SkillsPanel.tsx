/**
 * Two-column panel for managing Claude skills (SKILL.md). Lives in the Settings
 * page under "Skills".
 *
 * The list shows BOTH project-scoped skills (<project>/.claude/skills) and
 * global skills (~/.mcode/skills, Mcode's own CLAUDE_CONFIG_DIR). Global skills
 * are populated by the "Import" feature, which scans external tools (Claude
 * Code, Codex, Zcode) and copies selected skills into ~/.mcode/skills so they
 * become available to the SDK (including under custom endpoints) — or created
 * directly via the new-skill form's scope selector. Both kinds can be viewed,
 * edited, and deleted here. With no project at all, the panel degrades to
 * global-only management (list / create / edit / delete all work without a
 * projectPath).
 *
 * ## Layout
 *
 *   ┌─ project selector (dropdown) ──────────────────────────────┐
 *   ├─ left (skill list) ────┬─ right (editor / empty) ──────────┤
 *   │ • pdf       [全局]      │  - editing existing -             │
 *   │ • my-skill  [项目]      │  full SKILL.md source textarea    │
 *   │ + 新建 Skill            │  - or creating new -              │
 *   │ + 导入 Skill            │  scope / name / description / body│
 *   └─────────────────────────┤  · 保存/删除                      │
 *                              └───────────────────────────────────┘
 *
 * ## Which project's skills are shown?
 *
 * The panel keeps its OWN "managed project" selection (independent of the
 * workspace's activeProjectId) so switching it here never disturbs the
 * workspace. It defaults to the workspace's active project on first open.
 * The project dropdown at the top makes this explicit: project-scoped skills
 * always belong to whichever project is shown there, removing the prior
 * ambiguity where the binding was invisible. Global skills are the same
 * regardless of which project is selected.
 *
 * The skill list is fetched locally (panelSkills state) keyed on the managed
 * project, NOT read from the session store's `skills` cache - that cache is
 * bound to activeProjectId for the composer `/` menu and must not be coupled
 * to this panel's selection. After a mutation, if the managed project happens
 * to be the active one, we also reload the store cache so the `/` menu stays
 * in sync.
 *
 * Mirrors CustomModelsPanel's two-column shape and ConfirmDialog-based delete.
 */
import { useCallback, useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ConfirmDialog, Dialog, Select } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import {
  IconPlus,
  IconTrash,
  IconSparkles,
  IconLoader2,
  IconDownload,
  IconFolder,
} from "@renderer/lib/icons.js";
import type { SkillInfo, SkillSource, ExternalSkillInfo, SkillTool } from "@contracts/ipc";

/** Skill name charset — mirrored from the zod schema in the contract. The
 *  editor disables the name field for existing skills, so this only gates the
 *  "create new" form. */
const SKILL_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Stable empty array so the panel's skill list has a stable reference when
 *  empty (avoiding needless re-renders — same convention as sessionStore's
 *  EMPTY_SKILLS). */
const EMPTY_PANEL_SKILLS: SkillInfo[] = [];

/** Selection in the left list. `"new"` = the transient create entry;
 *  `null` = empty state. An existing skill is keyed by `${source}:${name}`
 *  (a name can appear under both global + project; the key disambiguates). */
type Selection =
  | { kind: "skill"; source: SkillSource; name: string }
  | { kind: "new" }
  | null;

interface NewForm {
  /** Where the skill will be created: project dir or the global ~/.mcode/skills.
   *  Defaults to "project" (current behavior); forced to "global" when no
   *  project exists at all (the only creatable scope then). */
  scope: SkillSource;
  name: string;
  description: string;
  body: string;
}

function emptyNewForm(scope: SkillSource): NewForm {
  return { scope, name: "", description: "", body: "" };
}

/** Selection key for a SkillInfo — stable identity across reloads. */
function skillKey(s: { source: SkillSource; name: string }): string {
  return `${s.source}:${s.name}`;
}

export function SkillsPanel() {
  const { t } = useI18n();
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const reloadSkills = useSessionStore((s) => s.reloadSkills);

  // Projects available to manage (non-archived). The dropdown lists these.
  const managedProjects = projects.filter((p) => !p.archived);

  // The panel's OWN project selection — independent of the workspace's
  // activeProjectId so switching here never disturbs the workspace. Defaults
  // to the active project; falls back to the first available project.
  const [managedProjectId, setManagedProjectId] = useState<string | null>(
    () => activeProjectId ?? managedProjects[0]?.id ?? null,
  );
  const managedProject = managedProjects.find((p) => p.id === managedProjectId);
  const projectPath = managedProject?.path ?? null;

  // Panel-local skill list, keyed on the managed project. NOT the store
  // cache (that one follows activeProjectId for the composer `/` menu).
  const [panelSkills, setPanelSkills] = useState<SkillInfo[]>(EMPTY_PANEL_SKILLS);
  const [listLoading, setListLoading] = useState(false);

  const loadPanelSkills = useCallback(async () => {
    setListLoading(true);
    try {
      // Without a project (no projects exist at all), list global skills only —
      // projectPath is optional in the contract and main scans ~/.mcode/skills
      // alone when it's absent.
      const { skills } = await api.skills.list(
        projectPath ? { projectPath } : {},
      );
      // Show both project-scoped and global skills. Global skills live under
      // ~/.mcode/skills (populated by the Import feature or the new-skill
      // form's global scope) and are editable/deletable here the same way
      // project skills are.
      setPanelSkills(skills.length ? skills : EMPTY_PANEL_SKILLS);
    } catch (err) {
      console.error("SkillsPanel load failed:", err);
      setPanelSkills(EMPTY_PANEL_SKILLS);
    } finally {
      setListLoading(false);
    }
  }, [projectPath]);

  // (Re)load whenever the managed project changes, and once on mount.
  useEffect(() => {
    void loadPanelSkills();
  }, [loadPanelSkills]);

  // Switching the managed project also clears any in-flight edit/create, so a
  // stale editor for project A doesn't linger while the list shows project B.
  const switchProject = (id: string) => {
    setManagedProjectId(id);
    setSelected(null);
    setEditContent(null);
    setNewForm(null);
    setError(null);
  };

  const [selected, setSelected] = useState<Selection>(null);
  // Full SKILL.md source for the skill being edited (null = not loaded yet).
  const [editContent, setEditContent] = useState<string | null>(null);
  // Structured form for creating a new skill.
  const [newForm, setNewForm] = useState<NewForm | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SkillInfo | null>(null);
  // Import dialog open state.
  const [importOpen, setImportOpen] = useState(false);

  // After any mutation: refresh this panel's list, and (if the managed project
  // is also the workspace's active one) refresh the store cache so the
  // composer `/` menu sees the change too.
  const refreshAfterMutation = useCallback(async () => {
    await loadPanelSkills();
    if (managedProjectId && managedProjectId === activeProjectId) {
      void reloadSkills();
    }
  }, [loadPanelSkills, managedProjectId, activeProjectId, reloadSkills]);

  const startEdit = async (skill: SkillInfo) => {
    setSelected({ kind: "skill", source: skill.source, name: skill.name });
    setNewForm(null);
    setError(null);
    setLoading(true);
    setEditContent(null);
    try {
      const { content } = await api.skills.read({
        projectPath: projectPath ?? undefined,
        source: skill.source,
        name: skill.name,
      });
      setEditContent(content);
    } catch (err) {
      setError((err as Error).message);
      setEditContent("");
    } finally {
      setLoading(false);
    }
  };

  const startAdd = () => {
    setSelected({ kind: "new" });
    // Default scope: the managed project; global-only when there is none.
    setNewForm(emptyNewForm(projectPath ? "project" : "global"));
    setEditContent(null);
    setError(null);
  };

  const cancel = () => {
    setSelected(null);
    setEditContent(null);
    setNewForm(null);
    setError(null);
  };

  const saveEdit = async () => {
    const sel = selected;
    if (!sel || sel.kind !== "skill" || editContent === null) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.skills.save({
        projectPath: projectPath ?? undefined,
        source: sel.source,
        name: sel.name,
        content: editContent,
      });
      if (!res.ok) {
        setError(res.error ?? t("settings.saveFailed"));
        return;
      }
      await refreshAfterMutation();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveNew = async () => {
    const sel = selected;
    if (!sel || sel.kind !== "new" || !newForm) return;
    // A project-scoped creation needs a project; global works without one.
    if (newForm.scope === "project" && !projectPath) return;
    const name = newForm.name.trim();
    if (!SKILL_NAME_RE.test(name)) {
      setError(t("settings.nameCharsError"));
      return;
    }
    if (!newForm.description.trim()) {
      setError(t("settings.skills.errDesc"));
      return;
    }
    // Assemble a minimal, valid SKILL.md: frontmatter (name + description) +
    // body. Description may contain special chars, so quote it to be safe.
    const desc = newForm.description.trim().replace(/"/g, '\\"');
    const content = `---\nname: ${name}\ndescription: "${desc}"\n---\n\n${newForm.body.trimEnd()}\n`;
    setSaving(true);
    setError(null);
    try {
      const res = await api.skills.save({
        projectPath: projectPath ?? undefined,
        source: newForm.scope,
        name,
        content,
      });
      if (!res.ok) {
        setError(res.error ?? t("settings.saveFailed"));
        return;
      }
      await refreshAfterMutation();
      // Land on the freshly created skill so the user sees it selected.
      setSelected({ kind: "skill", source: newForm.scope, name });
      setNewForm(null);
      setEditContent(content);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    if (!target) return;
    try {
      const res = await api.skills.delete({
        projectPath: projectPath ?? undefined,
        source: target.source,
        name: target.name,
      });
      if (!res.ok) {
        setError(res.error ?? t("settings.deleteFailed"));
        return;
      }
      // Clear selection if the deleted skill was selected.
      if (
        selected?.kind === "skill" &&
        selected.source === target.source &&
        selected.name === target.name
      ) {
        cancel();
      }
      await refreshAfterMutation();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl min-h-0 flex-col">
      <PanelHeader
        className="mb-3"
        title="Skills"
      />

      {/* ───────── Project selector ───────── */}
      {/* Makes the project binding explicit: project-scoped skills always
          belong to the project shown here. Switching it reloads the list and
          does NOT touch the workspace's active project. */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[0.7857em] font-medium text-content-muted">{t("settings.projectLabel")}</span>
        {managedProjects.length > 0 ? (
          <Select.Root
            value={managedProjectId ?? ""}
            onValueChange={(v) => switchProject(v as string)}
          >
            <Select.Trigger className="min-w-0 flex-1">
              <Select.Value>
                {(val: string) => {
                  const p =
                    managedProjects.find((x) => x.id === val) ?? managedProjects[0];
                  return (
                    <span className="flex items-center gap-1.5">
                      <IconFolder size={14} className="text-content-muted" />
                      {p
                        ? `${p.name}${p.id === activeProjectId ? ` (${t("settings.currentWorkspace")})` : ""}`
                        : ""}
                    </span>
                  );
                }}
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {managedProjects.map((p) => (
                      <Select.Item key={p.id} value={p.id}>
                        <IconFolder size={14} className="text-content-muted" />
                        <Select.ItemText>
                          {p.name}
                          {p.id === activeProjectId ? ` (${t("settings.currentWorkspace")})` : ""}
                        </Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        ) : (
          <span className="text-[0.7857em] text-content-subtle">
            {t("settings.skills.noProjects")}
          </span>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr] gap-4">
        {/* ───────── Left: skill list ───────── */}
        <aside className="flex min-h-0 flex-col rounded-md border border-edge bg-surface/40">
          <div className="flex items-center justify-between px-2.5 py-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
            <span>Skills</span>
            <span className="tabular-nums">
              {listLoading ? "…" : panelSkills.length}
            </span>
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
            {selected?.kind === "new" && (
              <div className="relative block w-full rounded border border-dashed border-accent/60 bg-accent/5 px-2.5 py-1.5 text-left text-[0.7857em] italic text-accent">
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                {t("settings.skills.newSkill")}
              </div>
            )}
            {panelSkills.map((s) => {
              const isActive =
                selected?.kind === "skill" &&
                selected.source === s.source &&
                selected.name === s.name;
              return (
                <button
                  key={skillKey(s)}
                  onClick={() => void startEdit(s)}
                  className={cn(
                    "relative block w-full rounded px-2.5 py-1.5 text-left transition-colors",
                    isActive ? "bg-surface-hover" : "hover:bg-surface-hover/60",
                  )}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                  )}
                  <div className="flex items-center gap-1">
                    <IconSparkles size={11} className="shrink-0 text-content-subtle" />
                    <span className="truncate text-[0.7857em] font-medium text-content">
                      {s.name}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1 text-[9px] leading-tight",
                        s.source === "project"
                          ? "bg-accent/12 text-accent"
                          : "bg-surface-hover text-content-subtle",
                      )}
                    >
                      {s.source === "project" ? t("settings.skills.sourceProject") : t("settings.skills.sourceGlobal")}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[0.7143em] text-content-subtle">
                      {s.description || t("settings.skills.noDesc")}
                    </span>
                  </div>
                </button>
              );
            })}
            {panelSkills.length === 0 && !listLoading && selected?.kind !== "new" && (
              <div className="px-2 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
                {t("settings.skills.listEmpty1")}
                <br />
                {t("settings.skills.listEmpty2")}
              </div>
            )}
          </nav>
          <div className="space-y-1.5 border-t border-edge p-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={startAdd}
              disabled={selected?.kind === "new"}
              className="w-full justify-center gap-1"
            >
              <IconPlus size={12} />
              {t("settings.skills.newSkill")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setImportOpen(true)}
              className="w-full justify-center gap-1"
            >
              <IconDownload size={12} />
              {t("settings.skills.importSkill")}
            </Button>
          </div>
        </aside>

        {/* ───────── Right: editor / empty state ───────── */}
        <div className="min-h-0 overflow-y-auto pr-1">
          {selected == null ? (
            <EmptyDetail />
          ) : selected.kind === "new" && newForm ? (
            <NewSkillForm
              form={newForm}
              setForm={setNewForm}
              canUseProject={!!projectPath}
              saving={saving}
              error={error}
              onSave={() => void saveNew()}
              onCancel={cancel}
            />
          ) : selected.kind === "skill" ? (
            <SkillSourceEditor
              skill={selected}
              content={editContent}
              loading={loading}
              saving={saving}
              error={error}
              onChange={setEditContent}
              onSave={() => void saveEdit()}
              onCancel={cancel}
              onDelete={() => {
                const target = panelSkills.find(
                  (s) => s.source === selected.source && s.name === selected.name,
                );
                if (target) setPendingDelete(target);
              }}
            />
          ) : null}
        </div>
      </div>

      {/* ───────── Delete confirmation ───────── */}
      <ConfirmDialog
        open={pendingDelete != null}
        title={t("settings.skills.deleteTitle")}
        danger
        description={
          <>
            {t("settings.skills.deleteDescPre")}
            {pendingDelete?.source === "project" ? t("settings.skills.sourceProject") : t("settings.skills.sourceGlobal")}
            {t("settings.skills.deleteDescMid")}
            {pendingDelete?.name}
            {t("settings.skills.deleteDescPost")}
          </>
        }
        confirmText={t("common.delete")}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => void confirmDelete()}
      />

      <ImportSkillsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        projectPath={projectPath}
        onImported={() => void refreshAfterMutation()}
      />
    </div>
  );
}

/** Right-pane empty state — nothing selected. */
function EmptyDetail() {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <IconSparkles size={28} className="mb-2 text-content-subtle" />
      <p className="max-w-[240px] text-[0.7857em] leading-relaxed text-content-subtle">
        {t("settings.skills.emptyDetail")}
      </p>
    </div>
  );
}

/** Editor for an existing skill — raw SKILL.md source in a single textarea. */
function SkillSourceEditor({
  skill,
  content,
  loading,
  saving,
  error,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: {
  skill: { source: SkillSource; name: string };
  content: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-full flex-col">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <IconSparkles size={14} className="text-content-muted" />
          <span className="text-[0.8571em] font-medium text-content">/{skill.name}</span>
          <span
            className={cn(
              "rounded px-1 text-[9px]",
              skill.source === "project"
                ? "bg-accent/12 text-accent"
                : "bg-surface-hover text-content-subtle",
            )}
          >
            {skill.source === "project" ? t("settings.skills.sourceProject") : t("settings.skills.sourceGlobal")}
          </span>
        </div>
        <span className="text-[0.7143em] text-content-subtle">{t("settings.skills.rawSource")}</span>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-8 text-[0.7857em] text-content-subtle">
          <IconLoader2 size={14} className="animate-spin" />
          {t("common.loading")}
        </div>
      ) : (
        <textarea
          value={content ?? ""}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className={cn(
            "min-h-[300px] flex-1 resize-y rounded border border-edge bg-surface px-2.5 py-2 font-mono text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none",
          )}
          placeholder={t("settings.skills.sourcePlaceholder")}
        />
      )}
      {error && <div className="mt-2 text-[0.7857em] text-danger">{error}</div>}
      <div className="mt-2 flex items-center gap-2">
        <Button variant="danger" size="sm" onClick={onDelete} title={t("settings.skills.deleteSkillTitle")}>
          <IconTrash size={12} />
          {t("common.delete")}
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" size="sm" onClick={onSave} disabled={saving || loading}>
          {saving ? t("settings.saving") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}

/** Structured form for creating a new skill (scope / name / description /
 *  body). The scope selector picks between the managed project and the global
 *  ~/.mcode/skills root; the project option is disabled when no project
 *  exists (the form then locks to global). */
function NewSkillForm({
  form,
  setForm,
  canUseProject,
  saving,
  error,
  onSave,
  onCancel,
}: {
  form: NewForm;
  setForm: React.Dispatch<React.SetStateAction<NewForm | null>>;
  /** False when no project exists — the project scope option is disabled and
   *  global is the only choice. */
  canUseProject: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  // Functional updater - guards against null (the form is guaranteed non-null
  // while this component is mounted, but the setter type carries | null).
  const update = <K extends keyof NewForm>(key: K, value: NewForm[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  const { t } = useI18n();
  const scopes: Array<{ value: SkillSource; label: string; disabled?: boolean }> = [
    { value: "project", label: t("settings.skills.sourceProject"), disabled: !canUseProject },
    { value: "global", label: t("settings.skills.sourceGlobal") },
  ];
  return (
    <div className="flex min-h-full flex-col">
      <div className="mb-2 flex items-center gap-1.5">
        <IconPlus size={14} className="text-accent" />
        <span className="text-[0.8571em] font-medium text-content">{t("settings.skills.newSkill")}</span>
      </div>
      <p className="mb-2 text-[0.7143em] leading-relaxed text-content-subtle">
        {form.scope === "project" ? (
          <>
            {t("settings.skills.newSkillIntro1")}
            <code className="rounded bg-surface-muted px-0.5">.claude/skills</code>
            {t("settings.skills.newSkillIntro2")}
            <code className="rounded bg-surface-muted px-0.5">allowed-tools</code>
            {t("settings.skills.newSkillIntro3")}
          </>
        ) : (
          <>
            {t("settings.skills.newSkillGlobalIntro1")}
            <code className="rounded bg-surface-muted px-0.5">~/.mcode/skills</code>
            {t("settings.skills.newSkillGlobalIntro2")}
            <code className="rounded bg-surface-muted px-0.5">allowed-tools</code>
            {t("settings.skills.newSkillIntro3")}
          </>
        )}
      </p>

      <Field label={t("settings.skills.fieldScope")}>
        <div className="flex w-full gap-1" role="radiogroup" aria-label={t("settings.skills.fieldScope")}>
          {scopes.map((s) => {
            const active = form.scope === s.value;
            return (
              <button
                key={s.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={s.disabled}
                onClick={() => update("scope", s.value)}
                title={
                  s.disabled
                    ? t("settings.skills.scopeProjectDisabled")
                    : s.value === "project"
                      ? t("settings.skills.scopeProjectHint")
                      : t("settings.skills.scopeGlobalHint")
                }
                className={cn(
                  "flex-1 rounded border px-2 py-1 text-[0.7857em] transition-colors",
                  active
                    ? "border-accent bg-accent/10 font-medium text-accent"
                    : "border-edge bg-surface text-content-muted hover:bg-surface-hover/60 hover:text-content",
                  s.disabled && "cursor-not-allowed opacity-50 hover:bg-surface hover:text-content-muted",
                )}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label={t("settings.skills.fieldName")}>
        <input
          type="text"
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder="my-skill"
          className={inputCls}
          spellCheck={false}
          autoFocus
        />
        <p className="mt-0.5 text-[10px] text-content-subtle">
          {t("settings.skills.fieldNameHintPre")}
          <code className="rounded bg-surface-muted px-0.5">/name</code>
          {t("settings.skills.fieldNameHintPost")}
        </p>
      </Field>

      <Field label={t("settings.skills.fieldDesc")}>
        <input
          type="text"
          value={form.description}
          onChange={(e) => update("description", e.target.value)}
          placeholder={t("settings.skills.descPlaceholder")}
          className={inputCls}
          spellCheck={false}
        />
      </Field>

      <Field label={t("settings.skills.fieldBody")}>
        <textarea
          value={form.body}
          onChange={(e) => update("body", e.target.value)}
          spellCheck={false}
          // w-full (not flex-1): Field wraps this in a block <label>, not a flex
          // container, so flex-1 was a no-op and the textarea fell back to its
          // default cols=20 width. w-full makes it fill the row like the other
          // inputs (which use inputCls with w-full).
          className={cn(
            "min-h-[200px] w-full resize-y rounded border border-edge bg-surface px-2.5 py-2 font-mono text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none",
          )}
          placeholder={t("settings.skills.bodyPlaceholder")}
        />
      </Field>

      {error && <div className="mt-2 text-[0.7857em] text-danger">{error}</div>}
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
          {saving ? t("settings.saving") : t("settings.skills.createBtn")}
        </Button>
      </div>
    </div>
  );
}

const inputCls =
  "min-w-0 w-full rounded border border-edge bg-surface px-2 py-1 font-mono text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block w-full">
      <span className="mb-0.5 block text-[0.7857em] font-medium text-content-muted">{label}</span>
      {children}
    </label>
  );
}

/* ───────── Import Skills Dialog ───────── */

/** Human-readable labels for each external tool. */
const TOOL_LABELS: Record<SkillTool, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  zcode: "Zcode",
  local: "",
};

/** Tool badge color classes - each tool gets a distinct tint. */
const TOOL_BADGE_CLS: Record<SkillTool, string> = {
  "claude-code": "bg-accent/12 text-accent",
  codex: "bg-purple-500/15 text-purple-500",
  zcode: "bg-blue-500/15 text-blue-500",
  local: "bg-surface-hover text-content-muted",
};

/** Fixed tab order: the three external agents by install-base, then the local
 *  folder pseudo-source last (it's the "additional source" tab). */
const TOOL_ORDER: SkillTool[] = ["claude-code", "codex", "zcode", "local"];

/** Modal dialog for importing skills from external tools (Claude Code, Codex,
 *  Zcode) into Mcode's own ~/.mcode/skills directory. On open, scans all
 *  external sources; presents a TAB-PER-AGENT, checkbox-selectable list; and
 *  copies the selected skill directories on confirm. Skills already present
 *  at the destination are marked and excluded from selection.
 *
 *  The selection Set is GLOBAL across tabs (keyed by sourcePath), so picks
 *  accumulate as the user flips between agents; each tab badge shows its own
 *  selected count, and the footer shows the total. The "本地" tab always
 *  exists and hosts the folder picker (plus its scanned skills). */
function ImportSkillsDialog({
  open,
  onOpenChange,
  projectPath,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string | null;
  onImported: () => void;
}) {
  const { t } = useI18n();
  const [sources, setSources] = useState<ExternalSkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    imported: string[];
    skipped: string[];
    errors: Array<{ name: string; error: string }>;
  } | null>(null);
  // User-picked local directory (the "本地" tab's "select folder" flow). When
  // set, its scanned skills appear under the local tab. Reset every time the
  // dialog opens.
  const [localDir, setLocalDir] = useState<string | null>(null);
  // Which agent's tab is showing. Reset on open; falls back to the first tab
  // that actually has skills when the stored one has none (see `activeTool`).
  const [activeToolRaw, setActiveToolRaw] = useState<SkillTool>("claude-code");

  // Scan external sources whenever the dialog opens or the local folder changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    if (localDir === null) setSelected(new Set());
    setExisting(new Set());
    setActiveToolRaw("claude-code");
    void (async () => {
      try {
        // Scan external tools (+ the picked local dir if any) and fetch the
        // current global skills (projectPath optional — works with no project)
        // to mark already-imported ones as "existing".
        const [scanRes, listRes] = await Promise.all([
          api.skills.scanSources(localDir ? { localDir } : {}),
          api.skills.list(projectPath ? { projectPath } : {}),
        ]);
        if (cancelled) return;
        setSources(scanRes.sources);
        const existingNames = new Set<string>();
        for (const s of listRes.skills) {
          if (s.source === "global") existingNames.add(s.name);
        }
        setExisting(existingNames);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // localDir is a dep: picking a new folder re-scans with it included.
  }, [open, projectPath, localDir]);

  // Selection key is sourcePath (unique per skill per tool).
  const toggle = (sourcePath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sourcePath)) next.delete(sourcePath);
      else next.add(sourcePath);
      return next;
    });
  };

  // Group sources by tool for display.
  const grouped = sources.reduce<Record<SkillTool, ExternalSkillInfo[]>>(
    (acc, s) => {
      (acc[s.tool] ??= []).push(s);
      return acc;
    },
    {} as Record<SkillTool, ExternalSkillInfo[]>,
  );

  // Tabs: the three agents appear only when they have skills; "本地" is always
  // present (it hosts the folder picker). `activeTool` falls back to the first
  // non-empty tab when the stored one is empty, so the strip never lands on a
  // tab with nothing in it.
  const tabs = TOOL_ORDER.filter((tool) => tool === "local" || (grouped[tool]?.length ?? 0) > 0);
  const activeTool = tabs.includes(activeToolRaw) ? activeToolRaw : (tabs[0] ?? "local");
  const activeItems = grouped[activeTool] ?? [];

  // Select-all toggle for the active tab: adds every not-yet-present skill of
  // the tab, or clears them all when everything importable is already picked.
  const importableItems = activeItems.filter((s) => !existing.has(s.name));
  const allActiveSelected =
    importableItems.length > 0 && importableItems.every((s) => selected.has(s.sourcePath));
  const toggleSelectAllForActive = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allActiveSelected) {
        for (const s of importableItems) next.delete(s.sourcePath);
      } else {
        for (const s of importableItems) next.add(s.sourcePath);
      }
      return next;
    });
  };

  const selectedCount = selected.size;

  const doImport = async () => {
    if (selectedCount === 0) return;
    setImporting(true);
    setError(null);
    try {
      const items = sources
        .filter((s) => selected.has(s.sourcePath))
        .map((s) => ({ sourcePath: s.sourcePath, name: s.name }));
      const res = await api.skills.import({ skills: items });
      setResult(res);
      setSelected(new Set());
      // Refresh the existing set so imported skills show as "already present".
      setExisting((prev) => {
        const next = new Set(prev);
        for (const name of res.imported) next.add(name);
        return next;
      });
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const close = () => {
    onOpenChange(false);
  };

  // Pick a local folder to scan for skills (in addition to the fixed external
  // tool dirs). Sets localDir → the open-effect re-scans with it, its skills
  // land in the "本地" tab, and we switch to that tab so the user immediately
  // sees what was found. Clearing selection first avoids stale picks pointing
  // at a folder that's no longer in the list.
  const pickLocalFolder = async () => {
    try {
      const { path: picked } = await api.pickFolder();
      if (!picked) return; // user cancelled
      setSelected(new Set());
      setLocalDir(picked);
      setActiveToolRaw("local");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const clearLocalFolder = () => {
    setSelected(new Set());
    setLocalDir(null);
  };

  // The local-folder picker card — rendered inside the "本地" tab when tabs are
  // showing, and above the empty state when no external skills were found at
  // all (so the local-import path stays discoverable in either case).
  const localPicker = (
    <div className="rounded border border-edge bg-surface/40 p-2">
      <div className="flex items-center gap-2">
        <IconFolder size={14} className="shrink-0 text-content-subtle" />
        <span className="text-[0.7143em] font-medium text-content-muted">
          {t("settings.skills.localFolder")}
        </span>
        <div className="flex-1" />
        {localDir ? (
          <button
            type="button"
            onClick={clearLocalFolder}
            className="text-[0.7143em] text-content-subtle hover:text-content"
          >
            {t("settings.skills.clear")}
          </button>
        ) : null}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        {localDir ? (
          <span
            className="min-w-0 flex-1 truncate rounded bg-surface px-1.5 py-1 font-mono text-[0.7143em] text-content-subtle"
            title={localDir}
          >
            {localDir}
          </span>
        ) : (
          <span className="min-w-0 flex-1 text-[0.7143em] text-content-subtle">
            {t("settings.skills.localFolderHint")}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void pickLocalFolder()}
          disabled={loading}
          className="shrink-0 gap-1"
        >
          <IconFolder size={12} />
          {t("settings.skills.chooseFolder")}
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[80vh] w-[560px] flex-col p-0">
          <Dialog.Title className="px-4 pt-4">{t("settings.skills.importTitle")}</Dialog.Title>
          <Dialog.Description className="px-4 pt-1">
            {t("settings.skills.importDesc1")}
            <code className="rounded bg-surface-muted px-0.5">~/.mcode/skills</code>
          </Dialog.Description>
          <Dialog.Close />

          {/* Body: tab strip + scrollable skill list */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-[0.7857em] text-content-subtle">
                <IconLoader2 size={14} className="animate-spin" />
                {t("settings.scanning")}
              </div>
            ) : sources.length === 0 ? (
              <div className="space-y-3">
                {localPicker}
                <div className="py-8 text-center text-[0.7857em] leading-relaxed text-content-subtle">
                  {t("settings.skills.importEmpty1")}
                  <br />
                  {t("settings.skills.importEmpty2a")}
                  {t("settings.skills.importEmpty2b")}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {/* ── Tab strip: one tab per agent, 本地 always present ──
                    Selection is global across tabs; each tab shows its total
                    count and (in accent) how many of them are picked. */}
                <div
                  role="tablist"
                  aria-label={t("settings.skills.importTitle")}
                  className="flex items-center gap-0.5 border-b border-edge"
                >
                  {tabs.map((tool) => {
                    const items = grouped[tool] ?? [];
                    const picked = items.filter((s) => selected.has(s.sourcePath)).length;
                    const isActive = tool === activeTool;
                    return (
                      <button
                        key={tool}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        onClick={() => setActiveToolRaw(tool)}
                        className={cn(
                          "flex items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 transition-colors",
                          isActive
                            ? "border-accent bg-surface text-content"
                            : "border-transparent text-content-muted hover:bg-surface-muted/50 hover:text-content",
                        )}
                      >
                        <span
                          className={cn(
                            "rounded px-1 text-[10px] font-medium leading-tight",
                            TOOL_BADGE_CLS[tool],
                          )}
                        >
                          {tool === "local" ? t("settings.skills.toolLocal") : TOOL_LABELS[tool]}
                        </span>
                        <span className="tabular-nums text-[0.7143em] text-content-subtle">
                          {items.length}
                        </span>
                        {picked > 0 && (
                          <span className="rounded-full bg-accent/15 px-1.5 text-[10px] font-medium leading-tight text-accent tabular-nums">
                            {picked}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* The folder picker lives in the 本地 tab (it's that tab's
                    source selector), not above the whole list. */}
                {activeTool === "local" && localPicker}

                {activeItems.length > 0 ? (
                  <div>
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="text-[0.7143em] text-content-subtle">
                        {t("settings.skills.skillCount", { n: activeItems.length })}
                      </span>
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={toggleSelectAllForActive}
                        disabled={importableItems.length === 0}
                        className="text-[0.7143em] text-accent hover:underline disabled:text-content-subtle disabled:no-underline"
                      >
                        {allActiveSelected
                          ? t("settings.skills.deselectAll")
                          : t("settings.skills.selectAll")}
                      </button>
                    </div>
                    <div className="space-y-0.5">
                      {activeItems.map((s) => {
                        const isExisting = existing.has(s.name);
                        const isChecked = selected.has(s.sourcePath);
                        return (
                          <label
                            key={s.sourcePath}
                            className={cn(
                              "flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 transition-colors",
                              isExisting
                                ? "opacity-50"
                                : isChecked
                                  ? "bg-accent/8"
                                  : "hover:bg-surface-hover/60",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              disabled={isExisting}
                              onChange={() => toggle(s.sourcePath)}
                              className="mt-0.5 shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1">
                                <span className="truncate text-[0.7857em] font-medium text-content">
                                  {s.name}
                                </span>
                                {isExisting && (
                                  <span className="shrink-0 rounded bg-surface-hover px-1 text-[9px] text-content-subtle">
                                    {t("settings.importExisting")}
                                  </span>
                                )}
                              </div>
                              <p className="truncate text-[0.7143em] text-content-subtle">
                                {s.description || t("settings.skills.noDesc")}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  // Only reachable on the 本地 tab before a folder is picked.
                  <div className="py-6 text-center text-[0.7857em] leading-relaxed text-content-subtle">
                    {t("settings.skills.localTabEmpty")}
                  </div>
                )}
              </div>
            )}

            {/* Import result summary */}
            {result && (
              <div className="mt-3 rounded border border-edge bg-surface/40 p-2 text-[0.7143em]">
                {result.imported.length > 0 && (
                  <p className="text-accent">
                    {t("settings.importResultImported", { n: result.imported.length, list: result.imported.join(", ") })}
                  </p>
                )}
                {result.skipped.length > 0 && (
                  <p className="text-content-subtle">
                    {t("settings.importResultSkipped", { n: result.skipped.length, list: result.skipped.join(", ") })}
                  </p>
                )}
                {result.errors.length > 0 && (
                  <p className="text-danger">
                    {t("settings.importResultFailed", {
                      n: result.errors.length,
                      list: result.errors.map((e) => `${e.name}(${e.error})`).join("; "),
                    })}
                  </p>
                )}
              </div>
            )}

            {error && (
              <div className="mt-2 text-[0.7857em] text-danger">{error}</div>
            )}
          </div>

          {/* Footer: selected count + actions */}
          <div className="flex items-center gap-2 border-t border-edge px-4 py-3">
            <span className="text-[0.7143em] text-content-subtle">
              {selectedCount > 0 ? t("settings.importSelectedCount", { n: selectedCount }) : ""}
            </span>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={close} disabled={importing}>
              {result ? t("common.close") : t("common.cancel")}
            </Button>
            {!result && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void doImport()}
                disabled={importing || selectedCount === 0}
              >
                {importing
                  ? t("settings.importing")
                  : `${t("settings.importBtn")}${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
              </Button>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
