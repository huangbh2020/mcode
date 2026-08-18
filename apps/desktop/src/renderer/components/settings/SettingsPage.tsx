import { useEffect, useState, type ComponentType } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
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
  IconChartBar,
  McpIcon,
  type TablerIconProps,
} from "@renderer/lib/icons.js";
import { CustomModelsPanel } from "./CustomModelsPanel.js";
import { SkillsPanel } from "./SkillsPanel.js";
import { McpPanel } from "./McpPanel.js";
import { AppearancePanel } from "./AppearancePanel.js";
import { ShortcutsPanel } from "./ShortcutsPanel.js";
import { GeneralPanel } from "./GeneralPanel.js";
import { GitPanel } from "./GitPanel.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { BrowserPanel } from "./BrowserPanel.js";
import { LspLanguagesPanel } from "./LspLanguagesPanel.js";
import { NotificationsPanel } from "./NotificationsPanel.js";
import { UsagePanel } from "./UsagePanel.js";
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
 *  - 模型配置 (CustomModelsPanel - two-column: provider list + config form)
 *  - 快捷键  (ShortcutsPanel)
 *  - Skills  (SkillsPanel - two-column: skill list + raw SKILL.md editor)
 *  - 消息通知 (NotificationsPanel - toggle per notification category)
 *  - Git     (GitPanel)
 *  - 终端    (TerminalPanel - shell override + per-project commands)
 *  - 语言服务器 (LspLanguagesPanel)
 *  - 用量统计 (UsagePanel - daily heatmap + per-model breakdown over time ranges)
 *  - 关于    (AboutPanel - version / license / repo links)
 *
 * The thread-title generator used to be its own nav item ("线程名称"); it has
 * been folded into the "常规" section. The section is the first nav entry.
 *
 * Note: the legacy “Claude CLI 路径” panel was removed - the Agent SDK bundles
 * its own claude binary, so an externally-configured path is no longer used.
 */
type SectionId = "general" | "custom-models" | "skills" | "mcp" | "appearance" | "shortcuts" | "notifications" | "git" | "terminal" | "browser" | "lsp-languages" | "usage" | "about";

interface NavItem {
  id: SectionId;
  labelKey: MessageId;
  icon: ComponentType<TablerIconProps>;
}

/** Settings nav sidebar width (px). Fixed — the workspace sidebar is now a
 *  percentage of the window (leftWidthPct) and no longer shares a width with
 *  the titlebar's retired left strip, so there's nothing to stay aligned
 *  with. 280px keeps the old default look. */
const SETTINGS_NAV_WIDTH = 280;

const NAV_ITEMS: NavItem[] = [
  // 分组顺序:常规 -> 个性化 -> 核心 AI 配置 -> IDE 能力 -> 关于
  { id: "general", labelKey: "settings.nav.general", icon: IconSettings },
  { id: "appearance", labelKey: "settings.nav.appearance", icon: IconPalette },
  { id: "custom-models", labelKey: "settings.nav.customModels", icon: IconRobot },
  { id: "shortcuts", labelKey: "settings.nav.shortcuts", icon: IconKeyboard },
  { id: "skills", labelKey: "settings.nav.skills", icon: IconSparkles },
  { id: "mcp", labelKey: "settings.nav.mcp", icon: McpIcon },
  { id: "notifications", labelKey: "settings.nav.notifications", icon: IconBell },
  { id: "git", labelKey: "settings.nav.git", icon: IconBrandGit },
  { id: "terminal", labelKey: "settings.nav.terminal", icon: IconTerminal2 },
  { id: "browser", labelKey: "settings.nav.browser", icon: IconWorld },
  { id: "lsp-languages", labelKey: "settings.nav.lsp", icon: IconCode },
  { id: "usage", labelKey: "settings.nav.usage", icon: IconChartBar },
  { id: "about", labelKey: "settings.nav.about", icon: IconInfoCircle },
];

export function SettingsPage() {
  const { t } = useI18n();
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  // SettingsPage mounts fresh each time the modal opens (App.tsx conditionally
  // renders it on `settingsOpen`), so this useState reads the requested
  // section once per open. Callers pass a section via setSettingsOpen(true, id)
  // — e.g. the composer's "管理模型…" entry targets "custom-models" / "pi-models".
  // A plain gear click (no section) lands on the first nav item ("常规") — the
  // default must NOT be "custom-models", or every plain open would jump to
  // the model-config tab.
  const settingsSection = useSessionStore((s) => s.settingsSection);
  const [active, setActive] = useState<SectionId>(
    () =>
      (settingsSection && NAV_ITEMS.some((n) => n.id === settingsSection)
        ? settingsSection
        : NAV_ITEMS[0].id) as SectionId,
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
                {t(item.labelKey)}
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
          {active === "custom-models" && <CustomModelsPanel />}
          {active === "shortcuts" && <ShortcutsPanel />}
          {active === "skills" && <SkillsPanel />}
          {active === "mcp" && <McpPanel />}
          {active === "notifications" && <NotificationsPanel />}
          {active === "git" && <GitPanel />}
          {active === "terminal" && <TerminalPanel />}
          {active === "browser" && <BrowserPanel />}
          {active === "lsp-languages" && <LspLanguagesPanel />}
          {active === "usage" && <UsagePanel />}
          {active === "about" && <AboutPanel />}
        </div>
      }
      right={null}
      leftOpen
      rightOpen={false}
      leftWidth={SETTINGS_NAV_WIDTH}
    />
  );
}
