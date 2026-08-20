import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Dialog, Input, Select } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import { TERMINAL_SHELL_SETTING_KEY } from "@contracts/ipc";
import type { CustomCommand } from "@contracts/ipc";
import {
  IconPlus,
  IconPencil,
  IconTrash,
  IconTerminal2,
  IconFolder,
} from "@renderer/lib/icons.js";

/**
 * Terminal settings - shell override + per-project quick-commands.
 *
 * Two card sections:
 *  - **终端 Shell**: a single text field bound directly to the
 *    `terminal.shell` setting key. The main-process terminal create handler
 *    reads this on every `terminal.create` (no store field / no new IPC).
 *    Empty = platform smart default (pwsh -> powershell -> bash -> cmd on
 *    Windows; $SHELL -> bash -> zsh -> sh on POSIX).
 *  - **自定义命令**: terminal quick-commands, scoped per-project. A project
 *    selector at the top picks which project's list to edit; the list below
 *    supports add / edit / delete via a Dialog (same shape as the terminal
 *    toolbar's quick-add). Persisted as a JSON `Record<projectId,
 *    CustomCommand[]>` via the store's per-project commands state.
 */
export function TerminalPanel() {
  const { t } = useI18n();
  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader
        title={t("settings.terminal.title")}
        desc={t("settings.terminal.desc")}
      />
      <ShellSection />
      <CommandsSection />
    </section>
  );
}

/* ───────────────────────── Shell section ───────────────────────── */

function ShellSection() {
  const { t } = useI18n();
  const [shell, setShell] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Load the current setting on mount (panel is freshly mounted per nav
  // switch, so reload its value each time it's shown).
  useEffect(() => {
    setSaved(false);
    void (async () => {
      const { value } = await api.setting.get({ key: TERMINAL_SHELL_SETTING_KEY });
      setShell(value ?? "");
      setLoaded(true);
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.setting.set({ key: TERMINAL_SHELL_SETTING_KEY, value: shell.trim() });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title={t("settings.terminal.shellSection")}
      desc={t("settings.terminal.shellSectionDesc")}
    >
      <SettingRow
        layout="vertical"
        title={t("settings.terminal.shellPath")}
        desc={t("settings.terminal.shellPathDesc")}
        htmlFor="setting-terminal-shell"
      >
        <div className="flex gap-2">
          <Input
            id="setting-terminal-shell"
            value={shell}
            onChange={(e) => {
              setShell((e.target as HTMLInputElement).value);
              setSaved(false);
            }}
            placeholder={t("settings.terminal.shellPlaceholder")}
            spellCheck={false}
            disabled={!loaded}
            className="min-w-0 flex-1 font-mono"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={saving || !loaded}
          >
            {saving ? t("settings.saving") : t("common.save")}
          </Button>
        </div>
        {saved && (
          <p className="mt-1 text-[0.7857em] text-accent">{t("settings.terminal.shellSaved")}</p>
        )}
      </SettingRow>
    </SettingsSection>
  );
}

/* ───────────────────── Per-project commands ───────────────────── */

const EMPTY: CustomCommand[] = [];

function CommandsSection() {
  const { t } = useI18n();
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);

  // Candidate projects: non-archived, sorted by name for a stable list.
  const candidateProjects = useMemo(
    () => projects.filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );

  // Selected project id defaults to the active project; falls back to the
  // first candidate. Recomputed when candidates change (e.g. project added).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedId && candidateProjects.some((p) => p.id === selectedId)) return;
    setSelectedId(activeProjectId && candidateProjects.some((p) => p.id === activeProjectId)
      ? activeProjectId
      : candidateProjects[0]?.id ?? null);
  }, [candidateProjects, activeProjectId, selectedId]);

  // Read this project's commands from the store. Selector returns a stable
  // ref (EMPTY constant) when the project has no saved commands.
  const commands = useSessionStore((s) =>
    selectedId ? s.customCommandsByProject[selectedId] ?? EMPTY : EMPTY,
  );
  const addCustomCommand = useSessionStore((s) => s.addCustomCommand);
  const updateCustomCommand = useSessionStore((s) => s.updateCustomCommand);
  const removeCustomCommand = useSessionStore((s) => s.removeCustomCommand);

  // Dialog state: null = closed; otherwise the draft being edited (blank id =
  // add mode, non-blank id = edit mode).
  const [editing, setEditing] = useState<{ id: string | null; name: string; command: string } | null>(null);

  const openAdd = () => setEditing({ id: null, name: "", command: "" });
  const openEdit = (cmd: CustomCommand) => setEditing({ id: cmd.id, name: cmd.name, command: cmd.command });

  const save = () => {
    if (!editing || !selectedId) return;
    const name = editing.name.trim();
    const command = editing.command.trim();
    if (!name || !command) return; // require both fields
    if (editing.id) {
      updateCustomCommand(selectedId, { id: editing.id, name, command });
    } else {
      addCustomCommand(selectedId, { name, command });
    }
    setEditing(null);
  };

  const remove = (id: string) => {
    if (!selectedId) return;
    removeCustomCommand(selectedId, id);
    setEditing(null);
  };

  return (
    <SettingsSection
      title={t("settings.terminal.commandsSection")}
      desc={t("settings.terminal.commandsSectionDesc")}
    >
      {candidateProjects.length === 0 ? (
        <p className="px-4 py-4 text-[0.8571em] text-content-subtle">{t("settings.terminal.noProjects")}</p>
      ) : (
        <>
          <SettingRow
            title={t("settings.terminal.pickProject")}
            desc={t("settings.terminal.pickProjectDesc")}
            htmlFor="setting-terminal-cmd-project"
          >
            <Select.Root
              value={selectedId ?? ""}
              onValueChange={(v) => setSelectedId(v as string)}
            >
              <Select.Trigger id="setting-terminal-cmd-project" className="min-w-[12rem]">
                <Select.Value>
                  {(val: string) => (
                    <span className="flex items-center gap-1.5">
                      <IconFolder size={14} className="text-content-muted" />
                      {candidateProjects.find((p) => p.id === val)?.name ?? t("settings.terminal.pickProject")}
                    </span>
                  )}
                </Select.Value>
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner>
                  <Select.Popup>
                    <Select.List>
                      {candidateProjects.map((p) => (
                        <Select.Item key={p.id} value={p.id}>
                          <IconFolder size={14} className="text-content-muted" />
                          <Select.ItemText>{p.name}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.List>
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          </SettingRow>

          <div className="px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[0.8571em] font-medium text-content">
                {t("settings.terminal.commandList")}
                <span className="ml-1.5 text-[0.7857em] font-normal text-content-subtle">
                  ({commands.length})
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={openAdd} disabled={!selectedId}>
                <IconPlus size={12} className="mr-1" />
                {t("settings.terminal.addCommand")}
              </Button>
            </div>

            {commands.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-edge py-6 text-center">
                <IconTerminal2 size={20} className="text-content-subtle" />
                <p className="text-[0.7857em] text-content-subtle">
                  {t("settings.terminal.emptyCommands1")}
                </p>
                <p className="text-[0.7857em] text-content-subtle">
                  {t("settings.terminal.emptyCommands2")}
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {commands.map((cmd) => (
                  <li
                    key={cmd.id}
                    className="group flex items-center gap-2 rounded-md border border-edge bg-surface px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[0.8571em] font-medium text-content">
                        {cmd.name}
                      </div>
                      <div className="truncate font-mono text-[0.7857em] text-content-subtle">
                        {cmd.command}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
                        title={t("common.edit")}
                        onClick={() => openEdit(cmd)}
                      >
                        <IconPencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-danger"
                        title={t("common.delete")}
                        onClick={() => remove(cmd.id)}
                      >
                        <IconTrash size={13} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {/* Add / edit dialog (controlled). */}
      <Dialog.Root open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[420px] max-w-[90vw] p-4">
            <Dialog.Title>{editing?.id ? t("settings.terminal.editCommand") : t("settings.terminal.addCommand")}</Dialog.Title>
            <Dialog.Description className="mt-1">
              {t("settings.terminal.dialogDesc")}
            </Dialog.Description>

            <div className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-content-muted">{t("settings.terminal.nameLabel")}</span>
                <Input
                  value={editing?.name ?? ""}
                  placeholder={t("settings.terminal.namePlaceholder")}
                  onChange={(e) =>
                    editing && setEditing({ ...editing, name: (e.target as HTMLInputElement).value })
                  }
                  autoFocus
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-content-muted">{t("settings.terminal.commandLabel")}</span>
                <textarea
                  value={editing?.command ?? ""}
                  placeholder={t("settings.terminal.commandPlaceholder")}
                  rows={3}
                  onChange={(e) => editing && setEditing({ ...editing, command: e.target.value })}
                  className={cn(
                    "w-full resize-y rounded border border-edge bg-surface px-2.5 py-1.5 font-mono text-xs leading-relaxed text-content placeholder:text-content-subtle outline-none transition-colors",
                    "focus:border-accent",
                  )}
                />
              </label>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div>
                {editing?.id && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      // Re-check inside the closure: `editing` may have changed
                      // between render and click.
                      if (editing?.id && selectedId) remove(editing.id);
                    }}
                  >
                    {t("common.delete")}
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={save}
                  disabled={!editing?.name.trim() || !editing?.command.trim()}
                >
                  {t("common.save")}
                </Button>
              </div>
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </SettingsSection>
  );
}
