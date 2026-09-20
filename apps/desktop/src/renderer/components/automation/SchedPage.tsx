/**
 * SchedPage — the full-window 定时任务 viewer (read-only), opened from the
 * left sidebar's quick actions (「定时任务」 under 连接手机). Layout mirrors the
 * settings page's full-bleed overlay form: it renders on top of the always
 * mounted workspace via App.tsx (absolute inset-0 of the panel row), and the
 * Titlebar switches to its "sched" mode (back button + page title).
 *
 * Content = SchedPanel in its "page" variant — the SAME component the right
 * panel's 定时任务 tab renders, differing only in host shape: this one lists
 * ALL tasks (no session scope), shows no 新建, and drills out of the overlay
 * when opening a task's session. Task rows carry the full toolkit:
 * pause/resume, run-now, edit (the shared AutomationEditor), delete/restore.
 * Row click selects, never edits.
 */
import { useEffect } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { SchedPanel } from "./SchedPanel.js";

export function SchedPage() {
  const { t } = useI18n();
  const setSchedPageOpen = useSessionStore((s) => s.setSchedPageOpen);

  // Esc returns to the workspace (same keyboard path as the settings page).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSchedPageOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSchedPageOpen]);

  /** 「新建」 on the page: start a BLANK chat session in the active project
   *  and close this overlay — the session page comes forward, and the task
   *  gets composed + scheduled from that session's composer (v2「任务即会话」
   *  flow: ScheduleChip / /schedule). */
  const handleNewTaskSession = (): void => {
    const st = useSessionStore.getState();
    if (!st.activeProjectId) {
      useToastStore.getState().push({ kind: "warning", title: t("layout.needProject") });
      return;
    }
    void st.startSession().then(() => st.setSchedPageOpen(false));
  };

  return (
    <div className="flex h-full min-h-0 w-full">
      <SchedPanel
        variant="page"
        onNewTaskSession={handleNewTaskSession}
        // Drill-out: the default action only opens a tab behind this
        // fullscreen overlay (invisible from here), so close the page as the
        // session tab comes forward.
        openSessionInWorkspace={(sessionId) => {
          void useSessionStore.getState().openTab(sessionId);
          setSchedPageOpen(false);
        }}
      />
    </div>
  );
}
