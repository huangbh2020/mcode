/**
 * Composer slash-command picker. Anchored above the textarea when the user
 * types `/` at line start or after whitespace. Lists two kinds of entries in
 * separate tabs:
 *  - **Skill**: skills discovered from the filesystem (user-global +
 *    project-level). Selecting inserts an atomic `/name` pill the user keeps
 *    typing after.
 *  - **命令** (built-in commands): fixed entries with bespoke behavior
 *    (`/compact`, `/init`). Selecting either executes immediately (`compact`)
 *    or fills the editor with an editable prompt (`init`).
 *
 * The default tab is "skill" (skills are the common case); if a tab has no
 * matches while the other does, the picker auto-switches so typing `/co`
 * jumps to the command tab to reveal `/compact`.
 *
 * Visual language matches FileMentionPicker.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconCommand, IconSparkles } from "@renderer/lib/icons.js";
import {
  filterBuiltInCommands,
  filterSkillCommands,
  isBuiltInCommand,
  type BuiltInCommand,
} from "@renderer/lib/slashCommands.js";
import type { SkillInfo } from "@contracts/ipc";

type TabKind = "skill" | "command";

export interface SlashCommandPickerProps {
  open: boolean;
  /** Query after the leading `/` (may be empty). */
  query: string;
  /** Cached skill list (from the store; loaded per active project). */
  skills: SkillInfo[];
  anchorRect: DOMRect | null;
  /** True while a turn is running - disables the `compact` command. */
  busy: boolean;
  onPickSkill: (skill: SkillInfo) => void;
  onPickCommand: (cmd: BuiltInCommand) => void;
  onClose: () => void;
}

export function SlashCommandPicker({
  open,
  query,
  skills,
  anchorRect,
  busy,
  onPickSkill,
  onPickCommand,
  onClose,
}: SlashCommandPickerProps) {
  const { t } = useI18n();
  // Compute both tabs' filtered lists up front so we can auto-switch.
  const skillCmds = useMemo(() => filterSkillCommands(query, skills), [query, skills]);
  const builtinCmds = useMemo(() => filterBuiltInCommands(query), [query]);
  // `compact` is disabled while a turn is running; filter it out of the
  // *interactive* list so it can't be arrow-selected or clicked, but keep it
  // counted in the tab badge so the user sees it exists.
  const activeBuiltinCmds = useMemo(
    () => (busy ? builtinCmds.filter((c) => c.kind !== "compact") : builtinCmds),
    [builtinCmds, busy],
  );

  const [activeTab, setActiveTab] = useState<TabKind>("skill");
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // The list currently rendered by the active tab.
  const commands = activeTab === "skill" ? skillCmds : activeBuiltinCmds;

  // Auto-switch: if the active tab is empty but the other has results, jump.
  // Runs on query / open / busy changes (busy affects the command tab count).
  useEffect(() => {
    if (!open) return;
    if (commands.length > 0) return;
    if (activeTab === "skill" && activeBuiltinCmds.length > 0) {
      setActiveTab("command");
    } else if (activeTab === "command" && skillCmds.length > 0) {
      setActiveTab("skill");
    }
  }, [open, query, activeTab, commands.length, activeBuiltinCmds.length, skillCmds.length]);

  // Reset selection to the first row whenever the query, tab, or open state
  // changes. This guarantees the first row is the active selection on open and
  // after every keystroke / tab switch (the "↓ selects the first row" need is
  // satisfied because row 0 is already selected when the panel appears).
  useEffect(() => {
    setActiveIdx(0);
  }, [query, open, activeTab]);

  // Scroll the active row into view whenever it changes.
  useEffect(() => {
    if (!open) return;
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open, commands]);

  // Keyboard navigation (capture phase so we beat the editor's Enter handler).
  // We mirror activeTab / commands.length / activeIdx in refs so the keydown
  // handler always sees fresh values without re-binding on every keystroke.
  const activeTabRef = useRef(activeTab);
  const commandsLenRef = useRef(commands.length);
  const activeIdxRef = useRef(activeIdx);
  activeTabRef.current = activeTab;
  commandsLenRef.current = commands.length;
  activeIdxRef.current = activeIdx;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        const len = commandsLenRef.current;
        if (len === 0) return;
        setActiveIdx((i) => Math.min(len - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const len = commandsLenRef.current;
        if (len === 0) return;
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      // Left/Right switch between the Skill and 命令 tabs. Only switch when
      // the target tab has results, so the user doesn't land on an empty tab
      // (mirrors the auto-switch logic's intent). preventDefault stops the
      // editor caret from moving while the picker is open.
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        const cur = activeTabRef.current;
        const next = e.key === "ArrowLeft"
          ? (cur === "command" ? "skill" : null)
          : (cur === "skill" ? "command" : null);
        if (next) {
          const hasResults = next === "skill" ? skillCmds.length > 0 : activeBuiltinCmds.length > 0;
          if (hasResults) setActiveTab(next);
        }
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (commands.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const entry = commands[activeIdxRef.current];
        if (!entry) return;
        if (isBuiltInCommand(entry)) onPickCommand(entry);
        else onPickSkill(entry);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, commands, onPickSkill, onPickCommand, onClose, skillCmds.length, activeBuiltinCmds.length]);

  if (!open || !anchorRect) return null;

  const top = Math.max(8, anchorRect.top - 8);
  const left = anchorRect.left;
  const width = Math.min(Math.max(anchorRect.width, 280), 420);

  return (
    <div
      className="fixed z-[70] flex max-h-64 flex-col overflow-hidden rounded-lg border border-edge bg-surface shadow-xl"
      style={{
        left,
        width,
        top,
        transform: "translateY(-100%)",
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* Tab bar: Skill | 命令. Each tab shows its live result count. */}
      <div className="flex items-stretch border-b border-edge">
        <TabButton
          active={activeTab === "skill"}
          onClick={() => setActiveTab("skill")}
          icon={<IconSparkles size={12} className="shrink-0 opacity-70" />}
          label="Skill"
          count={skillCmds.length}
        />
        <TabButton
          active={activeTab === "command"}
          onClick={() => setActiveTab("command")}
          icon={<IconCommand size={12} className="shrink-0 opacity-70" />}
          label={t("chat.slash.tabCommands")}
          count={builtinCmds.length}
        />
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
        {commands.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-content-subtle">
            {activeTab === "skill"
              ? skills.length === 0
                ? t("chat.slash.noSkills")
                : t("chat.slash.noSkillMatch")
              : t("chat.slash.noCommandMatch")}
          </div>
        ) : (
          commands.map((entry, idx) => {
            const isActive = idx === activeIdx;
            const isBuiltin = isBuiltInCommand(entry);
            const name = entry.name;
            const description = entry.description;
            const argumentHint = entry.argumentHint;
            return (
              <button
                key={isBuiltin ? `builtin:${name}` : `${(entry as SkillInfo).source}:${name}`}
                type="button"
                data-idx={idx}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => {
                  if (isBuiltin) onPickCommand(entry);
                  else onPickSkill(entry);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
                  isActive
                    ? "bg-accent/15 text-content ring-1 ring-inset ring-accent/40"
                    : "text-content hover:bg-surface-hover",
                )}
              >
                {isBuiltin ? (
                  <IconCommand size={14} className="shrink-0 text-content-muted" />
                ) : (
                  <IconSparkles size={14} className="shrink-0 text-content-muted" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    /{name}
                    {argumentHint ? (
                      <span className="ml-0.5 text-[10px] text-content-subtle">{argumentHint}</span>
                    ) : null}
                  </span>
                  <span className="block truncate text-[10px] text-content-subtle">
                    {description || t("chat.slash.noDescription")}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] text-content-subtle">
                  {isBuiltin
                    ? t("chat.slash.builtin")
                    : (entry as SkillInfo).source === "project"
                      ? t("chat.slash.project")
                      : t("chat.slash.global")}
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between border-t border-edge px-2.5 py-1 text-[10px] text-content-subtle">
        <span>
          <kbd className="rounded border border-edge px-1">↑</kbd>
          <kbd className="ml-0.5 rounded border border-edge px-1">↓</kbd>
          {" "}{t("chat.kbd.navigate")}{" "}
          <kbd className="ml-1 rounded border border-edge px-1">←</kbd>
          <kbd className="ml-0.5 rounded border border-edge px-1">→</kbd>
          {" "}{t("chat.slash.switchTab")}{" "}
          <kbd className="ml-1 rounded border border-edge px-1">↵</kbd>
          {" "}{t("chat.slash.insert")}
        </span>
        <span>{t("chat.slash.count", { n: commands.length })}</span>
      </div>
    </div>
  );
}

/** A single tab button in the picker header. */
function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11px] transition-colors",
        active
          ? "border-b-2 border-accent text-content"
          : "border-b-2 border-transparent text-content-muted hover:text-content",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      <span className="text-content-subtle">{count}</span>
    </button>
  );
}
