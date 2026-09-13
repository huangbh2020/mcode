/**
 * AppMobile — the web (phone) shell: the same store + message pipeline as the
 * desktop, wrapped in a touch-first single-column layout.
 *
 * Differences from the desktop shell (App.tsx):
 *  - A pairing gate renders first (no device token → PairingScreen). Only
 *    after pairing do the event subscriptions and store hydration start, so
 *    the SSE stream is opened with valid credentials.
 *  - No Titlebar / ThreePaneLayout / right IDE panel / terminal / browser
 *    panel — those are Electron-bound. The session list becomes the
 *    touch-first MobileSessionDrawer slide-over, and the chat column is the
 *    whole screen (ChatPane's container queries already adapt the
 *    gutters/composer to the narrow width).
 *  - No bottom tab bar (removed for screen space): the drawer's header
 *    segmented control (会话/文件/Git) is the view switcher, and the top bar
 *    title mirrors the current view so "where am I" stays visible.
 *  - Settings is the minimal MobileSettingsSheet instead of SettingsPage.
 *  - displayMode (single/tabs, a desktop-shared pref) gates the tab strip:
 *    the default "single" hides it (the drawer is the session switcher);
 *    "tabs" shows the shared SessionTabs strip above the keyed active pane
 *    (unlike the desktop, background panes stay unmounted to save memory).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatPane } from "./components/chat/ChatPane.js";
import { SessionTabs } from "./components/layout/SessionTabs.js";
import { ModelConfigPrompt } from "./components/chat/ModelConfigPrompt.js";
import { Toaster } from "./components/layout/Toaster.js";
import { PairingScreen } from "./components/mobile/PairingScreen.js";
import { MobileSettingsSheet } from "./components/mobile/MobileSettingsSheet.js";
import { MobileSessionDrawer, type MobileView } from "./components/mobile/MobileSessionDrawer.js";
import { MobileFilesScreen } from "./components/mobile/MobileFilesScreen.js";
import { MobileGitScreen } from "./components/mobile/MobileGitScreen.js";
import { MobileViewerOverlay } from "./components/mobile/MobileViewerOverlay.js";
import { useClaudeEvents } from "./hooks/useClaudeEvents.js";
import { useSessionStore, selectActiveEnvPath } from "./stores/sessionStore.js";
import { useTheme } from "./lib/theme.js";
import { useChatAppearance, useRightPanelAppearance, useThemeStyle } from "./lib/appearance.js";
import { useI18n } from "./lib/i18n/index.js";
import { worktreeDisplayName } from "./lib/worktree.js";
import { isPaired, onAuthLost, clearAuth, checkStoredAuth } from "./lib/webApi.js";
import {
  IconMenu2,
  IconSettings,
  IconFolder,
  IconGitFork,
  SpinnerIcon,
} from "./lib/icons.js";

/** Boot gate state. "checking" is the window in which we ask the PC whether the
 *  remembered device token is still good. */
type AuthState = "checking" | "paired" | "unpaired";

/** How long a boot probe may take before it earns a visible spinner (ms). */
const SPLASH_DELAY_MS = 250;

/** Drop the one-time `?nonce=` from the URL (keeping path + hash). The nonce was
 *  consumed by pairing and expires in minutes, so it only ever made later
 *  reloads/back-navigation re-enter the pairing route for no reason. */
function stripNonceFromUrl(): void {
  try {
    if (new URLSearchParams(window.location.search).has("nonce")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    }
  } catch {
    // non-critical — ignore
  }
}

export function AppMobile() {
  // The device token in localStorage IS the remembered verification state. A
  // token present → verify it (see below) instead of showing the pairing form;
  // this covers every way the page gets re-entered (browser Back landing on the
  // `?nonce=` URL, a restored tab, the app icon) — the code is displayed on the
  // PC, so demanding it again strands a user who has walked away from the desk.
  const [authState, setAuthState] = useState<AuthState>(() =>
    isPaired() ? "checking" : "unpaired",
  );
  // Theme / appearance hooks are pairing-independent (localStorage + media
  // queries on web), so they mount outside the gate.
  useTheme();
  useChatAppearance();
  useRightPanelAppearance();
  useThemeStyle();
  const { t } = useI18n();

  // Confirm the stored token once per boot. Only an explicit 401 ("invalid")
  // sends the user back to pairing; an unreachable PC keeps the token, because a
  // Wi-Fi blip must never cost a pairing the user cannot restore from where
  // they are.
  useEffect(() => {
    if (!isPaired()) return;
    let cancelled = false;
    void checkStoredAuth().then((state) => {
      if (cancelled) return;
      if (state === "invalid") {
        clearAuth();
        setAuthState("unpaired");
        return;
      }
      stripNonceFromUrl();
      setAuthState("paired");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Delay the "checking" spinner: on a LAN the probe answers in a few ms, and
  // painting a spinner for one frame reads as a glitch. It only shows when the
  // decision actually takes a while (PC asleep / off the network).
  const [splashVisible, setSplashVisible] = useState(false);
  useEffect(() => {
    if (authState !== "checking") return;
    const timer = window.setTimeout(() => setSplashVisible(true), SPLASH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [authState]);

  // A 401 from any later RPC clears auth via the web shim — fall back to the
  // pairing screen so the user can re-pair instead of cascading "未配对" errors.
  useEffect(() => onAuthLost(() => setAuthState("unpaired")), []);

  // After a successful pairing, strip the nonce from the URL so a later reload
  // uses the new token directly. While the form is still on screen the nonce
  // stays put, so a rejected token can be re-paired without re-scanning the QR.
  const handlePaired = useCallback(() => {
    stripNonceFromUrl();
    setAuthState("paired");
  }, []);

  if (authState === "unpaired") {
    return <PairingScreen onPaired={handlePaired} />;
  }
  if (authState === "checking") {
    // Blank until the delayed splash kicks in — the page background is already
    // painted, so a fast probe is a no-op visually.
    return splashVisible ? (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-surface text-content">
        <SpinnerIcon size={22} className="animate-spin text-accent" />
        <p className="text-sm text-content-muted">{t("layout.pairRestoring")}</p>
      </div>
    ) : (
      <div className="h-full w-full bg-surface" />
    );
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
  const [view, setView] = useState<MobileView>("chat");
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const displayMode = useSessionStore((s) => s.displayMode);
  const running = useSessionStore((s) =>
    s.activeSessionId ? s.runningBySession[s.activeSessionId] : false,
  );
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const pinnedSessions = useSessionStore((s) => s.pinnedSessions);
  // Owning project of the active session (kept in lockstep by
  // syncConfigFromSession) — shown next to the title. Same stable-ref selector
  // shape as the desktop Titlebar's ActiveProjectChip: an existing element of
  // `projects` or null, never a fresh object.
  const activeProject = useSessionStore((s) =>
    s.activeProjectId ? s.projects.find((p) => p.id === s.activeProjectId) ?? null : null,
  );
  // The active session's isolated checkout, when it has one. Derived from
  // selectActiveEnvPath — the SAME selector the file tree / Git screen / desktop
  // IDE use — rather than re-reading session.worktreePath, so the badge cannot
  // disagree with the tree the user is looking at: if the environment is not the
  // project checkout, it is a worktree, and the bar says so.
  const envPath = useSessionStore(selectActiveEnvPath);
  const worktreeNames = useSessionStore((s) => s.worktreeNames);
  const worktree = useMemo(
    () =>
      activeProject && envPath && envPath !== activeProject.path
        ? { path: envPath, name: worktreeDisplayName(envPath, worktreeNames) }
        : null,
    [activeProject, envPath, worktreeNames],
  );
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const { t } = useI18n();

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
    // Pinned sessions aren't in the per-project slices — check the global
    // pinned bucket before falling back to the default title.
    const pinnedHit = pinnedSessions.find((x) => x.id === activeSessionId);
    if (pinnedHit) return pinnedHit.title;
    return "Mcode";
  }, [activeSessionId, sessionsByProject, pinnedSessions]);

  return (
    <div className="flex h-full w-full flex-col bg-surface text-content">
      {/* Top bar — kept at exactly h-10 (40px) so the shared Dialog backdrop
          (`top-10` in components/ui/dialog.tsx) still aligns with the shell
          chrome without platform-specific CSS. bg-surface-muted (same as the
          desktop Titlebar) lifts the chrome one step off the bg-surface main
          panel so the bar reads as a distinct layer in both themes. */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-edge bg-surface-muted px-1.5">
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
          {/* With the bottom tab bar gone, the title doubles as the "where am
              I" cue — files/git views show the view name (their own breadcrumb
              / header carries the project context) instead of the thread
              title. The spinner stays: the active session running is useful
              context from any view. */}
          <span className="min-w-0 shrink truncate text-sm font-medium">
            {view === "files"
              ? t("layout.nav.files")
              : view === "git"
                ? t("layout.nav.git")
                : title}
          </span>
          {/* Mobile counterpart of the desktop Titlebar's ActiveProjectChip —
              without it, the thread's owning project is invisible outside the
              drawer (fresh sessions show as a bare "New session" title).
              Chat-scoped, so it hides in the files/git views. */}
          {view === "chat" && activeSessionId && activeProject && (
            <span className="flex min-w-0 shrink items-center gap-1 px-1 text-xs text-content-subtle">
              <IconFolder size={13} className="shrink-0" />
              <span className="truncate">{activeProject.name}</span>
            </span>
          )}
          {/* …and which CHECKOUT that thread runs in, when it is isolated. The
              file tree / Git screen now follow the session's environment, so
              the bar has to name it or the same project visibly shows two
              different trees. Same identity as the drawer's worktree group
              header (IconGitFork + accent tint + display name, raw path in the
              tooltip). */}
          {view === "chat" && activeSessionId && worktree && (
            <span
              title={worktree.path}
              className="flex min-w-0 shrink items-center gap-1 px-1 text-xs text-content-subtle"
            >
              <IconGitFork size={13} className="shrink-0 text-accent/80" />
              <span className="max-w-[7rem] truncate">{worktree.name}</span>
            </span>
          )}
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
        {/* Left drawer — the touch-first MobileSessionDrawer (project →
            session tree, search, bottom action sheets). Renders nothing
            while closed; it keeps itself mounted through the slide-out. */}
        <MobileSessionDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onPickSession={() => setView("chat")}
          view={view}
          onPickView={(v) => {
            setView(v);
            setDrawerOpen(false);
          }}
        />

        {/* Chat column: tab strip (only in `tabs` displayMode — the default
            "single" hides it; the drawer is the session switcher) + the
            active pane. ChatPane renders the empty state when no session is
            open. */}
        {view === "chat" ? (
          <div className="flex min-w-0 flex-1 flex-col">
            {displayMode === "tabs" && <SessionTabs />}
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

      {/* Shared overlays — the send-time model-config guard + toasts. (The
          Ctrl+K CommandPalette is desktop-only: its only entry point is the
          left bar's 搜索 button, hidden in the mobile drawer.) */}
      <ModelConfigPrompt />
      <MobileSettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {/* Fullscreen viewer for chat-stream content (files / turn diffs / plans)
          opened via the store's mobileViewer state. */}
      <MobileViewerOverlay />
      <Toaster />
    </div>
  );
}
