/**
 * MobileComposer — a lightweight textarea-based input (no Tiptap).
 *
 * Enter sends (Shift+Enter for newline), with a send/stop toggle driven by the
 * session's running state. Kept deliberately simple: no skill pills, slash
 * commands, or rich-text — the mobile transport is plain text for Phase 4/5.
 */
import { useRef, useState } from "react";
import { useMobileStore } from "../stores/mobileStore.js";

export function MobileComposer() {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeSessionId = useMobileStore((s) => s.activeSessionId);
  const running = useMobileStore((s) => (activeSessionId ? !!s.runningBySession[activeSessionId] : false));
  const sendPrompt = useMobileStore((s) => s.sendPrompt);
  const interrupt = useMobileStore((s) => s.interrupt);

  const submit = () => {
    const text = value.trim();
    if (!text || !activeSessionId || running) return;
    void sendPrompt(activeSessionId, text);
    setValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter to send; Shift+Enter for newline. Ignore IME composition.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  // Auto-grow the textarea up to a cap.
  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  return (
    <div className="no-select shrink-0 border-t border-edge bg-surface px-2 py-2" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.5rem)" }}>
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={onInput}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={activeSessionId ? "输入消息…" : "请先选择或新建会话"}
          disabled={!activeSessionId}
          className="max-h-40 min-h-[40px] flex-1 resize-none rounded-2xl border border-edge bg-surface-muted px-3 py-2 text-sm text-content outline-none focus:border-accent disabled:opacity-50"
        />
        {running ? (
          <button
            onClick={() => activeSessionId && void interrupt(activeSessionId)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-danger text-white"
            aria-label="停止"
            title="停止"
          >
            <span className="block h-3 w-3 rounded-sm bg-white" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!value.trim() || !activeSessionId}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:opacity-40"
            aria-label="发送"
            title="发送"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
