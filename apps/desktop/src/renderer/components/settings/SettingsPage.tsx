import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { ThreePaneLayout } from "@renderer/components/layout/ThreePaneLayout.js";
import { SettingsShellProvider } from "./settingsShell.js";
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
  IconMicrophone,
  IconHandMove,
  IconPackage,
  IconPuzzle,
  IconChevronDown,
  SearchIcon,
  McpIcon,
  type TablerIconProps,
} from "@renderer/lib/icons.js";
import { CustomModelsPanel } from "./CustomModelsPanel.js";
import { RuntimesPanel } from "./RuntimesPanel.js";
import { SkillsPanel } from "./SkillsPanel.js";
import { McpPanel } from "./McpPanel.js";
import { PluginsPanel } from "./PluginsPanel.js";
import { AppearancePanel } from "./AppearancePanel.js";
import { ShortcutsPanel } from "./ShortcutsPanel.js";
import { GesturesPanel } from "./GesturesPanel.js";
import { GeneralPanel } from "./GeneralPanel.js";
import { GitPanel } from "./GitPanel.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { BrowserPanel } from "./BrowserPanel.js";
import { LspLanguagesPanel } from "./LspLanguagesPanel.js";
import { NotificationsPanel } from "./NotificationsPanel.js";
import { VoicePanel } from "./VoicePanel.js";
import { UsagePanel } from "./UsagePanel.js";
import { AboutPanel } from "./AboutPanel.js";

/**
 * Settings page — plan-A "精修卡片流" layout (prototypes/settings-redesign.html).
 *
 * Shell shape (one scroll container + one fixed page header):
 *
 *   ┌ nav ────────────┬ page header (fixed, full width) ────────────┐
 *   │ search          ├─────────────────────────────────────────────┤
 *   │ group eyebrows  │ scrolling body — centered card column       │
 *   │ nav items       │ (each panel's own <section> wrapper)        │
 *   │ footer          │                                             │
 *   └─────────────────┴─────────────────────────────────────────────┘
 *
 * The header belongs to the active panel (it carries that panel's action slot)
 * but is *positioned* by the shell: panels still render `<PanelHeader>`, which
 * portals into the `headerSlot` div published through `SettingsShellContext`.
 * Page identity (icon + one-line description) is registered here per nav item,
 * so panels don't repeat it.
 *
 * The nav is grouped into 5 labeled clusters (通用 → AI 能力 → 输入与提醒 →
 * 工作台 → 系统); group headers collapse, and the search box filters the nav
 * items. Deep links via `setSettingsOpen(true, sectionId)` still address
 * individual items.
 *
 * Note: the legacy “Claude CLI 路径” panel was removed - the Agent SDK bundles
 * its own claude binary, so an externally-configured path is no longer used.
 */
type SectionId = "general" | "runtimes" | "custom-models" | "skills" | "mcp" | "plugins" | "appearance" | "shortcuts" | "gestures" | "voice" | "notifications" | "git" | "terminal" | "browser" | "lsp-languages" | "usage" | "about";

interface NavItem {
  id: SectionId;
  labelKey: MessageId;
  /** One-line page description, shown under the page title. */
  descKey: MessageId;
  icon: ComponentType<TablerIconProps>;
}

interface NavGroup {
  labelKey: MessageId;
  items: NavItem[];
}

/** Settings nav width (px) — plan A's 236px rail. */
const SETTINGS_NAV_WIDTH = 236;

const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "settings.navGroup.general",
    items: [
      { id: "general", labelKey: "settings.nav.general", descKey: "settings.general.desc", icon: IconSettings },
      { id: "appearance", labelKey: "settings.nav.appearance", descKey: "settings.appearance.desc", icon: IconPalette },
    ],
  },
  {
    labelKey: "settings.navGroup.ai",
    items: [
      { id: "custom-models", labelKey: "settings.nav.customModels", descKey: "settings.customModels.desc", icon: IconRobot },
      { id: "runtimes", labelKey: "settings.nav.runtimes", descKey: "settings.runtimes.desc", icon: IconPackage },
      { id: "plugins", labelKey: "settings.nav.plugins", descKey: "settings.plugins.desc", icon: IconPuzzle },
      { id: "skills", labelKey: "settings.nav.skills", descKey: "settings.skills.desc", icon: IconSparkles },
      { id: "mcp", labelKey: "settings.nav.mcp", descKey: "settings.mcp.desc", icon: McpIcon },
    ],
  },
  {
    labelKey: "settings.navGroup.input",
    items: [
      { id: "voice", labelKey: "settings.nav.voice", descKey: "settings.voice.desc", icon: IconMicrophone },
      { id: "shortcuts", labelKey: "settings.nav.shortcuts", descKey: "settings.shortcuts.desc", icon: IconKeyboard },
      { id: "gestures", labelKey: "settings.nav.gestures", descKey: "settings.gestures.desc", icon: IconHandMove },
      { id: "notifications", labelKey: "settings.nav.notifications", descKey: "settings.notifications.desc", icon: IconBell },
    ],
  },
  {
    labelKey: "settings.navGroup.workbench",
    items: [
      { id: "git", labelKey: "settings.nav.git", descKey: "settings.git.desc", icon: IconBrandGit },
      { id: "terminal", labelKey: "settings.nav.terminal", descKey: "settings.terminal.desc", icon: IconTerminal2 },
      { id: "browser", labelKey: "settings.nav.browser", descKey: "settings.browser.desc", icon: IconWorld },
      { id: "lsp-languages", labelKey: "settings.nav.lsp", descKey: "settings.lsp.desc", icon: IconCode },
    ],
  },
  {
    labelKey: "settings.navGroup.system",
    items: [
      { id: "usage", labelKey: "settings.nav.usage", descKey: "settings.usage.desc", icon: IconChartBar },
      { id: "about", labelKey: "settings.nav.about", descKey: "settings.about.desc", icon: IconInfoCircle },
    ],
  },
];

/** Flat nav items (group order preserved) — used to validate deep-link ids. */
const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function SettingsPage() {
  const { t, locale } = useI18n();
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
  /** Nav search query — filters nav items (label + description). */
  const [query, setQuery] = useState("");
  /** Collapsed nav groups, keyed by the group's i18n key. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [appVersion, setAppVersion] = useState<string | null>(null);
  /** Fixed header host. Published to panels via SettingsShellContext; the ref
   *  callback flushes before paint, so the portaled header is present on the
   *  first visible frame. */
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);

  // Esc returns to the workspace (preserves the modal's keyboard shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSettingsOpen]);

  // Nav footer shows the app version (read-only; failure is not worth surfacing).
  useEffect(() => {
    void api.app.info()
      .then((info) => setAppVersion(info.appVersion))
      .catch(() => setAppVersion(null));
  }, []);

  const activeItem = NAV_ITEMS.find((n) => n.id === active) ?? NAV_ITEMS[0];
  const shellValue = useMemo(
    () => ({
      headerSlot,
      pageIcon: activeItem.icon,
      pageDesc: t(activeItem.descKey),
    }),
    [headerSlot, activeItem, t],
  );

  const q = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        labelKey: group.labelKey,
        items: q
          ? group.items.filter(
              (item) =>
                t(item.labelKey).toLowerCase().includes(q) ||
                t(item.descKey).toLowerCase().includes(q),
            )
          : group.items,
      })).filter((group) => group.items.length > 0),
    [q, t],
  );

  return (
    <SettingsShellProvider value={shellValue}>
      <ThreePaneLayout
        left={
          <nav
            className="flex h-full flex-col border-r border-edge-panel bg-surface"
            style={{ fontSize: "var(--right-panel-font-size)" }}
          >
            {/* Search */}
            <div className="shrink-0 px-2.5 pb-1.5 pt-2.5">
              <div className="relative">
                <SearchIcon
                  size={13}
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-content-subtle"
                />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("settings.nav.searchPlaceholder")}
                  aria-label={t("settings.nav.searchPlaceholder")}
                  className={cn(
                    "h-7 w-full rounded-lg border border-edge-input bg-surface pl-7 pr-2",
                    "text-[0.8571em] text-content placeholder:text-content-subtle",
                    "transition-colors focus:border-accent/70 focus:outline-none focus:ring-2 focus:ring-accent/15",
                  )}
                />
              </div>
            </div>

            {/* Groups */}
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2.5">
              {groups.map((group, gi) => {
                const isCollapsed = !q && !!collapsed[group.labelKey];
                return (
                  <div key={group.labelKey} className={gi === 0 ? "" : "mt-2.5"}>
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsed((c) => ({ ...c, [group.labelKey]: !c[group.labelKey] }))
                      }
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded px-2 pb-1 pt-0.5 text-left",
                        "text-[0.75em] font-semibold uppercase tracking-[0.05em] text-content-subtle",
                        "hover:text-content-muted",
                      )}
                    >
                      <IconChevronDown
                        size={12}
                        className={cn(
                          "shrink-0 transition-transform",
                          isCollapsed && "-rotate-90",
                        )}
                      />
                      <span className="truncate">{t(group.labelKey)}</span>
                    </button>

                    {!isCollapsed && (
                      <div className="space-y-px">
                        {group.items.map((item) => {
                          const isActive = item.id === active;
                          const Icon = item.icon;
                          return (
                            <button
                              key={item.id}
                              onClick={() => setActive(item.id)}
                              aria-current={isActive ? "page" : undefined}
                              className={cn(
                                "relative flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-left",
                                "text-[0.9286em] transition-colors",
                                isActive
                                  ? "bg-surface-hover font-semibold text-content"
                                  : "text-content-muted hover:bg-surface-hover/65 hover:text-content",
                              )}
                            >
                              {isActive && (
                                <span className="absolute -left-1.5 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-accent" />
                              )}
                              <Icon
                                size={16}
                                className={cn(
                                  "shrink-0",
                                  isActive ? "text-accent" : "text-content-subtle",
                                )}
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {t(item.labelKey)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {groups.length === 0 && (
                <div className="px-2.5 py-3.5 text-[0.8571em] text-content-subtle">
                  {t("settings.nav.noResults")}
                </div>
              )}
            </div>

            {/* Footer: version + current language (informational) */}
            <div className="flex shrink-0 items-center gap-2 border-t border-edge-panel px-2.5 py-2">
              {appVersion && (
                <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[0.7857em] font-semibold text-content-muted">
                  v{appVersion}
                </span>
              )}
              <span className="truncate text-[0.821em] text-content-subtle">
                {locale === "en"
                  ? t("settings.general.languageEn")
                  : t("settings.general.languageZh")}
              </span>
            </div>
          </nav>
        }
        center={
          // Plan-A body: one scroll container under a FIXED page header. The
          // header is not part of the scroll surface (no sticky, no negative
          // margins) — panels portal it into `headerSlot` above.
          //
          // `bg-surface-muted` turns the pane into the plan-A page background
          // so the white setting cards read as cards floating on it.
          //
          // The scroll container keeps padding: panels that use `h-full`
          // (Skills / custom models) resolve 100% against its content box, so
          // the padding never creates an outer scrollbar.
          <div
            className="flex h-full min-h-0 flex-col bg-surface-muted"
            style={{ fontSize: "var(--right-panel-font-size)" }}
          >
            <div ref={setHeaderSlot} className="shrink-0" />
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-4">
              {active === "general" && <GeneralPanel />}
              {active === "appearance" && <AppearancePanel />}
              {active === "custom-models" && <CustomModelsPanel />}
              {active === "shortcuts" && <ShortcutsPanel />}
              {active === "gestures" && <GesturesPanel />}
              {active === "voice" && <VoicePanel />}
              {active === "skills" && <SkillsPanel />}
              {active === "runtimes" && <RuntimesPanel />}
              {active === "mcp" && <McpPanel />}
              {active === "plugins" && <PluginsPanel />}
              {active === "notifications" && <NotificationsPanel />}
              {active === "git" && <GitPanel />}
              {active === "terminal" && <TerminalPanel />}
              {active === "browser" && <BrowserPanel />}
              {active === "lsp-languages" && <LspLanguagesPanel />}
              {active === "usage" && <UsagePanel />}
              {active === "about" && <AboutPanel />}
            </div>
          </div>
        }
        right={null}
        leftOpen
        rightOpen={false}
        leftWidth={SETTINGS_NAV_WIDTH}
      />
    </SettingsShellProvider>
  );
}
