import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
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
  return (
    <section className="space-y-4">
      <PanelHeader
        title="终端"
        desc="配置终端使用的 Shell 与按项目保存的常用快捷命令。"
      />
      <ShellSection />
      <CommandsSection />
    </section>
  );
}

/* ───────────────────────── Shell section ───────────────────────── */

function ShellSection() {
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
      title="终端 Shell"
      desc="指定终端使用的 Shell 可执行文件。留空则使用系统默认(Windows:pwsh → powershell → bash → cmd;macOS/Linux:$SHELL → bash → zsh → sh)。仅对新建终端生效。"
    >
      <SettingRow
        layout="vertical"
        title="Shell 路径"
        desc="例如 pwsh、bash、powershell,或完整路径如 C:\\Program Files\\PowerShell\\7\\pwsh.exe。"
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
            placeholder="留空使用系统默认"
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
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
        {saved && (
          <p className="mt-1 text-[0.7857em] text-accent">已保存。新建终端将使用此 Shell。</p>
        )}
      </SettingRow>
    </SettingsSection>
  );
}

/* ───────────────────── Per-project commands ───────────────────── */

const EMPTY: CustomCommand[] = [];

function CommandsSection() {
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
      title="自定义命令"
      desc="按项目保存常用终端命令,在终端工具栏的书签菜单中一键运行。命令按项目独立保存,互不影响。"
    >
      {candidateProjects.length === 0 ? (
        <p className="px-4 py-4 text-[0.8571em] text-content-subtle">请先在项目列表中添加一个项目。</p>
      ) : (
        <>
          <SettingRow
            title="选择项目"
            desc="切换查看不同项目的自定义命令。"
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
                      {candidateProjects.find((p) => p.id === val)?.name ?? "选择项目"}
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
                命令列表
                <span className="ml-1.5 text-[0.7857em] font-normal text-content-subtle">
                  ({commands.length})
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={openAdd} disabled={!selectedId}>
                <IconPlus size={12} className="mr-1" />
                添加命令
              </Button>
            </div>

            {commands.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-edge py-6 text-center">
                <IconTerminal2 size={20} className="text-content-subtle" />
                <p className="text-[0.7857em] text-content-subtle">
                  该项目暂无自定义命令。
                </p>
                <p className="text-[0.7857em] text-content-subtle">
                  可点上方「添加命令」,或在终端工具栏书签菜单中快速添加。
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
                        title="编辑"
                        onClick={() => openEdit(cmd)}
                      >
                        <IconPencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-danger"
                        title="删除"
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
            <Dialog.Title>{editing?.id ? "编辑命令" : "添加命令"}</Dialog.Title>
            <Dialog.Description className="mt-1">
              保存后可在终端工具栏的书签菜单中一键运行。
            </Dialog.Description>

            <div className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-content-muted">名称</span>
                <Input
                  value={editing?.name ?? ""}
                  placeholder="例如:启动开发服务器"
                  onChange={(e) =>
                    editing && setEditing({ ...editing, name: (e.target as HTMLInputElement).value })
                  }
                  autoFocus
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-content-muted">命令</span>
                <textarea
                  value={editing?.command ?? ""}
                  placeholder="例如:npm run dev"
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
                    删除
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={save}
                  disabled={!editing?.name.trim() || !editing?.command.trim()}
                >
                  保存
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
