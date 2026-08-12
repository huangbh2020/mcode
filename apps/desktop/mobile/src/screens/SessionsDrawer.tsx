/**
 * SessionsDrawer — left-sliding overlay listing projects + their sessions.
 *
 * The desktop's LeftBar exposes "new session" only on project hover; on touch
 * there's no hover, so each project row carries an explicit ➕ button. Tapping a
 * session selects it and closes the drawer.
 */
import { useEffect } from "react";
import type { Project, Session } from "@contracts/session";
import { useMobileStore } from "../stores/mobileStore.js";

interface Props {
  projects: Project[];
  sessionsByProject: Record<string, Session[]>;
  activeSessionId: string | null;
  onClose: () => void;
  onDisconnect: () => void;
}

export function SessionsDrawer({ projects, sessionsByProject, activeSessionId, onClose, onDisconnect }: Props) {
  const selectProject = useMobileStore((s) => s.selectProject);
  const selectSession = useMobileStore((s) => s.selectSession);
  const startSession = useMobileStore((s) => s.startSession);
  const loadSessions = useMobileStore((s) => s.loadSessions);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = async (sessionId: string) => {
    await selectSession(sessionId);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      {/* drawer */}
      <div className="no-select absolute inset-y-0 left-0 flex w-[85%] max-w-xs flex-col bg-surface-muted shadow-2xl">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-3">
          <span className="text-sm font-semibold text-content">会话</span>
          <button onClick={onClose} className="rounded p-1.5 text-content-muted hover:bg-surface-hover" aria-label="关闭">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {projects.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-content-subtle">还没有项目</div>
          ) : (
            projects.map((p) => {
              const sessions = sessionsByProject[p.id] ?? [];
              return (
                <div key={p.id} className="mb-2">
                  <div className="flex items-center gap-1 px-1 py-1">
                    <button
                      onClick={() => void selectProject(p.id)}
                      className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-content-muted"
                    >
                      📁 {p.name}
                    </button>
                    <button
                      onClick={() => {
                        void startSession(p.id).then((id) => {
                          if (id) onClose();
                        });
                      }}
                      className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-accent"
                      title="新建会话"
                      aria-label={`在 ${p.name} 新建会话`}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                  </div>
                  <ul>
                    {sessions.map((s) => (
                      <li key={s.id}>
                        <button
                          onClick={() => void pick(s.id)}
                          className={
                            "block w-full truncate rounded px-2 py-2 text-left text-xs " +
                            (s.id === activeSessionId ? "bg-surface-hover text-content" : "text-content-muted hover:bg-surface-hover")
                          }
                        >
                          💬 {s.title}
                        </button>
                      </li>
                    ))}
                    {sessions.length === 0 && (
                      <li className="px-2 py-1 text-[11px] text-content-subtle">暂无会话</li>
                    )}
                  </ul>
                </div>
              );
            })
          )}
        </div>

        <div className="shrink-0 border-t border-edge p-2">
          <button
            onClick={onDisconnect}
            className="w-full rounded px-3 py-2 text-left text-xs text-danger hover:bg-surface-hover"
          >
            断开连接
          </button>
        </div>
      </div>
    </div>
  );
}
