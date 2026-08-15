/**
 * AppMobile — the web (phone) shell: the same store + message pipeline as the
 * desktop, wrapped in a touch-first single-column layout.
 *
 * Differences from the desktop shell (App.tsx):
 *  - A pairing gate renders first (no device token → PairingScreen). Only
 *    after pairing do the event subscriptions and store hydration start, so
 *    the SSE stream is opened with valid credentials.
 *  - No Titlebar / ThreePaneLayout / right IDE panel / terminal / browser
 *    panel — those are Electron-bound. The left bar becomes a slide-over
 *    drawer, and the chat column is the whole screen (ChatPane's container
 *    queries already adapt the gutters/composer to the narrow width).
 *  - Settings is the minimal MobileSettingsSheet instead of SettingsPage.
 *  - displayMode (single/tabs, a desktop-shared pref) is ignored: the strip
 *    always shows every open tab and the active pane mounts keyed.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { LeftBar } from "./components/layout/LeftBar.js";
import { ChatPane } from "./components/chat/ChatPane.js";
import { SessionTabs } from "./components/layout/SessionTabs.js";
import { CommandPalette } from "./components/layout/CommandPalette.js";
import { ModelConfigPrompt } from "./components/chat/ModelConfigPrompt.js";
import { Toaster } from "./components/layout/Toaster.js";
import { PairingScreen } from "./components/mobile/PairingScreen.js";
import { MobileSettingsSheet } from "./components/mobile/MobileSettingsSheet.js";
import { MobileFilesScreen } from "./components/mobile/MobileFilesScreen.js";
import { MobileGitScreen } from "./components/mobile/MobileGitScreen.js";
import { MobileViewerOverlay } from "./components/mobile/MobileViewerOverlay.js";
import { useClaudeEvents } from "./hooks/useClaudeEvents.js";
import { useSessionStore } from "./stores/sessionStore.js";
import { useTheme } from "./lib/theme.js";
import { useChatAppearance, useRightPanelAppearance } from "./lib/appearance.js";
import { isPaired, onAuthLost } from "./lib/webApi.js";
import { cn } from "./lib/cn.js";
import {
  IconMenu2,
  IconSettings,
  IconMessage,
  IconFolder,
  IconGitBranch,
  SpinnerIcon,
} from "./lib/icons.js";

export function AppMobile() {
  const [paired, setPaired] = useState(() => {
    // A fresh QR scan carries ?nonce — always go through pairing so a stale
    // token (left over from a previous session, or invalidated when the PC
    // restarted / removed the device) can't skip the gate and 401 on boot.
    const hasNonce =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("nonce");
    return isPaired() && !hasNonce;
  });
  // Theme / appearance hooks are pairing-independent (localStorage + media
  // queries on web), so they mount outside the gate.
  useTheme();
  useChatAppearance();
  useRightPanelAppearance();

  // A 401 anywhere (stale token reopened WITHOUT a nonce) clears auth via the
  // web shim — fall back to the pairing screen so the user can re-pair instead
  // of cascading "未配对" errors.
  useEffect(() => onAuthLost(() => setPaired(false)), []);

  // After a successful pairing, strip the nonce from the URL so a later reload
  // uses the new token directly instead of re-triggering the pairing gate.
  const handlePaired = useCallback(() => {
    try {
      if (new URLSearchParams(window.location.search).has("nonce")) {
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.hash,
        );
      }
    } catch {
      // non-critical — ignore
    }
    setPaired(true);
  }, []);

  if (!paired) {
    return <PairingScreen onPaired={handlePaired} />;
  }
  return <MobileShell />;
}

function MobileShell() {
  // Event stream + store hydration — mounted only once the device token
  // exists (the SSE transport attaches it at connect time).
  useClaudeEvents();
  const init = useSessionStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [view, setView] = useState<"chat" | "files" | "git">("chat");
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const running = useSessionStore((s) =>
    s.activeSessionId ? s.runningBySession[s.activeSessionId] : false,
  );
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  // Picking a session in the drawer activates it — close the drawer on any
  // activation (tab-strip clicks are no-ops here since the drawer is closed).
  useEffect(() => {
    setDrawerOpen(false);
  }, [activeSessionId]);

  const title = useMemo(() => {
    if (!activeSessionId) return "Mcode";
    for (const list of Object.values(sessionsByProject)) {
      const hit = list?.find((x) => x.id === activeSessionId);
      if (hit) return hit.title;
    }
    return "Mcode";
  }, [activeSessionId, sessionsByProject]);

  return (
    <div className="flex h-full w-full flex-col bg-surface text-content">
      {/* Top bar — kept at exactly h-10 (40px) so the shared Dialog backdrop
          (`top-10` in components/ui/dialog.tsx) still aligns with the shell
          chrome without platform-specific CSS. */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-edge px-1.5">
        <button
          type="button"
          aria-label="打开会话列表"
          onClick={() => setDrawerOpen(true)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-content-muted hover:bg-surface-muted"
        >
          <IconMenu2 size={18} />
        </button>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-1">
          {running && <SpinnerIcon size={13} className="shrink-0 animate-spin text-accent" />}
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
        <button
          type="button"
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-content-muted hover:bg-surface-muted"
        >
          <IconSettings size={16} />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Left drawer: the full desktop LeftBar (session tree, groups,
            search, archive bin) in a slide-over panel. */}
        {drawerOpen && (
          <>
            <button
              type="button"
              aria-label="关闭会话列表"
              className="absolute inset-0 z-30 bg-black/40"
              onClick={() => setDrawerOpen(false)}
            />
            <div
              className={cn(
                "absolute inset-y-0 left-0 z-40 flex w-[min(85vw,320px)] flex-col",
                "border-r border-edge bg-surface-muted shadow-2xl",
              )}
            >
              <LeftBar />
            </div>
          </>
        )}

        {/* Chat column: tab strip + the active pane. ChatPane renders the
            empty state when no session is open. */}
        {view === "chat" ? (
          <div className="flex min-w-0 flex-1 flex-col">
            <SessionTabs />
            <div className="min-h-0 flex-1">
              <ChatPane key={activeSessionId ?? "empty"} sessionId={activeSessionId} />
            </div>
          </div>
        ) : view === "files" ? (
          <MobileFilesScreen />
        ) : (
          <MobileGitScreen />
        )}
      </div>

      {/* Bottom nav — 会话 / 文件(只读) / Git. */}
      <nav className="flex h-12 shrink-0 border-t border-edge">
        {(
          [
            { id: "chat", label: "会话", icon: IconMessage },
            { id: "files", label: "文件", icon: IconFolder },
            { id: "git", label: "Git", icon: IconGitBranch },
          ] as const
        ).map(({ id, label, icon: NavIcon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px]",
              view === id ? "text-accent" : "text-content-muted",
            )}
          >
            <NavIcon size={18} />
            {label}
          </button>
        ))}
      </nav>

      {/* Shared overlays — CommandPalette (session search, opened from the
          drawer's search button) + the send-time model-config guard + toasts. */}
      <CommandPalette />
      <ModelConfigPrompt />
      <MobileSettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {/* Fullscreen viewer for chat-stream content (files / turn diffs / plans)
          opened via the store's mobileViewer state. */}
      <MobileViewerOverlay />
      <Toaster />
    </div>
  );
}
