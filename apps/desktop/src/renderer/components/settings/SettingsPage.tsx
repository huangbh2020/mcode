import { useEffect, useState, type ComponentType } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { ThreePaneLayout } from "@renderer/components/layout/ThreePaneLayout.js";
import {
  IconSettings,
  IconPalette,
  IconKeyboard,
  IconRobot,
  IconSparkles,
  IconBell,
  IconBrandGit,
  IconTerminal2,
  IconWorld,
  IconCode,
  IconInfoCircle,
  type TablerIconProps,
} from "@renderer/lib/icons.js";
import { CustomModelsPanel } from "./CustomModelsPanel.js";
import { SkillsPanel } from "./SkillsPanel.js";
import { AppearancePanel } from "./AppearancePanel.js";
import { ShortcutsPanel } from "./ShortcutsPanel.js";
import { GeneralPanel } from "./GeneralPanel.js";
import { GitPanel } from "./GitPanel.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { BrowserPanel } from "./BrowserPanel.js";
import { LspLanguagesPanel } from "./LspLanguagesPanel.js";
import { NotificationsPanel } from "./NotificationsPanel.js";
import { AboutPanel } from "./AboutPanel.js";

/**
 * Settings page with a left functional menu + right content panel layout.
 *
 * Rendered as a sibling view to the workspace (toggled by `settingsOpen` in
 * the session store). Reuses the same ThreePaneLayout shell as the main
 * workspace - the only difference is the right sidebar is collapsed and the
 * left sidebar hosts the settings navigation instead of the project tree.
 *
 * Available sections (grouped: 常规 -> 个性化 -> 核心 AI 配置 -> IDE 能力 -> 关于):
 *  - 常规    (GeneralPanel - currently wraps TitleGenPanel for thread titles)
 *  - 外观    (AppearancePanel - flat one-row-per-feature list)
 *  - 快捷键  (ShortcutsPanel)
 *  - 模型配置 (CustomModelsPanel - two-column: provider list + config form)
 *  - Skills  (SkillsPanel - two-column: skill list + raw SKILL.md editor)
 *  - 消息通知 (NotificationsPanel - toggle per notification category)
 *  - Git     (GitPanel)
 *  - 终端    (TerminalPanel - shell override + per-project commands)
 *  - 语言服务器 (LspLanguagesPanel)
 *  - 关于    (AboutPanel - version / license / repo links)
 *
 * The thread-title generator used to be its own nav item ("线程名称"); it has
 * been folded into the "常规" section. The section is the first nav entry.
 *
 * Note: the legacy “Claude CLI 路径” panel was removed - the Agent SDK bundles
 * its own claude binary, so an externally-configured path is no longer used.
 */
type SectionId = "general" | "custom-models" | "skills" | "appearance" | "shortcuts" | "notifications" | "git" | "terminal" | "browser" | "lsp-languages" | "about";

interface NavItem {
  id: SectionId;
  label: string;
  icon: ComponentType<TablerIconProps>;
}

const NAV_ITEMS: NavItem[] = [
  // 分组顺序:常规 -> 个性化 -> 核心 AI 配置 -> IDE 能力 -> 关于
  { id: "general", label: "常规", icon: IconSettings },
  { id: "appearance", label: "外观", icon: IconPalette },
  { id: "shortcuts", label: "快捷键", icon: IconKeyboard },
  { id: "custom-models", label: "模型配置", icon: IconRobot },
  { id: "skills", label: "技能", icon: IconSparkles },
  { id: "notifications", label: "消息通知", icon: IconBell },
  { id: "git", label: "Git", icon: IconBrandGit },
  { id: "terminal", label: "终端", icon: IconTerminal2 },
  { id: "browser", label: "浏览器", icon: IconWorld },
  { id: "lsp-languages", label: "语言服务器", icon: IconCode },
  { id: "about", label: "关于", icon: IconInfoCircle },
];

export function SettingsPage() {
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  // Read the same persisted leftWidth the workspace sidebar + titlebar left
  // strip use, so the settings nav sidebar stays exactly aligned with the
  // titlebar's sidebar strip above (whose width also comes from this store
  // value). Without this the settings sidebar was a hardcoded 280px while the
  // titlebar strip tracked the user's dragged width - they'd drift apart.
  const leftWidth = useSessionStore((s) => s.leftWidth);
  // SettingsPage mounts fresh each time the modal opens (App.tsx conditionally
  // renders it on `settingsOpen`), so this useState reads the requested
  // section once per open. Callers pass a section via setSettingsOpen(true, id)
  // — e.g. the composer's "管理模型…" entry targets "custom-models" / "pi-models".
  const settingsSection = useSessionStore((s) => s.settingsSection);
  const [active, setActive] = useState<SectionId>(
    () => (settingsSection && (NAV_ITEMS.some((n) => n.id === settingsSection)) ? settingsSection : "custom-models") as SectionId,
  );

  // Esc returns to the workspace (preserves the modal's keyboard shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSettingsOpen]);

  return (
    <ThreePaneLayout
      left={
        <nav
          className="space-y-0.5 px-2 py-3"
          style={{ fontSize: "var(--right-panel-font-size)" }}
        >
          {NAV_ITEMS.map((item) => {
            const isActive = item.id === active;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setActive(item.id)}
                className={cn(
                  "relative flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors",
                  isActive
                    ? "bg-surface-hover font-medium text-content"
                    : "text-content-muted hover:bg-surface-hover hover:text-content",
                )}
              >
                {isActive && (
                  <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                )}
                <Icon
                  size={16}
                  className={cn(
                    "shrink-0",
                    isActive ? "text-accent" : "text-content-subtle",
                  )}
                />
                {item.label}
              </button>
            );
          })}
        </nav>
      }
      center={
        <div
          // `h-full` (not flex-1) is required here: the parent in
          // ThreePaneLayout is a non-flex `overflow-hidden` box, so `flex-1`
          // was inert and this wrapper fell back to content height. That broke
          // the height chain — child panels using `h-full` couldn't resolve,
          // their internal `overflow-y-auto` regions never scrolled, and tall
          // content (e.g. a long skill list) pushed the bottom "新建" button
          // off-screen (clipped by the outer overflow-hidden). h-full makes this
          // wrapper a definite height so child panels fill it and scroll
          // internally; overflow-y-auto still lets non-internal-scroll panels
          // (Git/Terminal/About) scroll when their content is tall.
          className="min-h-0 h-full overflow-y-auto px-6 py-5"
          style={{ fontSize: "var(--right-panel-font-size)" }}
        >
          {active === "general" && <GeneralPanel />}
          {active === "appearance" && <AppearancePanel />}
          {active === "shortcuts" && <ShortcutsPanel />}
          {active === "custom-models" && <CustomModelsPanel />}
          {active === "skills" && <SkillsPanel />}
          {active === "notifications" && <NotificationsPanel />}
          {active === "git" && <GitPanel />}
          {active === "terminal" && <TerminalPanel />}
          {active === "browser" && <BrowserPanel />}
          {active === "lsp-languages" && <LspLanguagesPanel />}
          {active === "about" && <AboutPanel />}
        </div>
      }
      right={null}
      leftOpen
      rightOpen={false}
      leftWidth={leftWidth}
    />
  );
}
