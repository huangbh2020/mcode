/**
 * Voice-input mic button for the composer action row.
 *
 * Two capture modes (switchable via the caret menu, default persisted in the
 * settings table):
 *   - continuous  : click → start dictation, click again → stop, text commits.
 *   - pushToTalk  : press-and-hold to speak, release to stop ("按住说话").
 *
 * Microphone audio is streamed to the main-process sherpa-onnx ASR engine via
 * `useVoiceInput`; the transcript is written DIRECTLY into the composer as it
 * streams (each partial rewrites the tail the previous one produced — see
 * `applyLiveText`), so the user sees the text appear in the input box while
 * speaking and can edit it right after the listen ends.
 *
 * The default mode/language come from the store's persisted voice settings;
 * flipping the mode here also persists it, so "我记得上次用的模式" behavior is
 * kept across sessions.
 *
 * Desktop-only: the ASR engine lives in the Electron main process (no bridge
 * exists over the mobile RPC/SSE transport), and the mobile shell serves the
 * page over plain HTTP where browsers withhold `navigator.mediaDevices`
 * entirely — render nothing there instead of a button that can never listen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useVoiceInput } from "@renderer/hooks/useVoiceInput.js";
import { isElectron } from "@renderer/lib/platform.js";
import {
  registerVoiceHandle,
  setVoiceActive,
  type VoiceHandle,
} from "@renderer/lib/voiceController.js";
import type { ComposerEditorHandle } from "./ComposerEditor.js";
import type { VoiceInputMode } from "@contracts/ipc";
import {
  IconChevronDown,
  IconDownload,
  IconMicrophone,
  IconMicrophoneFilled,
  IconMicrophoneOff,
} from "@renderer/lib/icons.js";

/** Matches the "no model" family of engine errors thrown by main
 *  (`尚未选择语音模型…` / `语音模型未下载或不完整…`). */
const NO_MODEL_ERROR_RE = /尚未选择语音模型|模型未下载|先下载并选择/;

interface MicButtonProps {
  /** This pane's session — the keyboard shortcut / command palette drives the
   *  ACTIVE session's mic through the voiceController registry. */
  sessionId: string;
  /** The composer editor — transcribed text is inserted into it. */
  editorRef: React.RefObject<ComposerEditorHandle | null>;
  /** True while a bottom prompt (tool approval / plan approval / question)
   *  owns the input area — the composer is hidden then. A running turn does
   *  NOT lock the mic: dictation lands in the still-editable composer for
   *  type-ahead / enqueue, mirroring `textareaLocked`'s rules. */
  disabled: boolean;
}

export function MicButton(props: MicButtonProps) {
  // `isElectron` is a module constant, so the branch is stable per bundle —
  // the web (phone) shell never mounts the hooks below.
  if (!isElectron) return null;
  return <MicButtonDesktop {...props} />;
}

function MicButtonDesktop({
  sessionId,
  editorRef,
  disabled,
}: MicButtonProps) {
  const { t } = useI18n();
  const voiceInputMode = useSessionStore((s) => s.voiceInputMode);
  const setVoiceInputMode = useSessionStore((s) => s.setVoiceInputMode);
  const voiceLang = useSessionStore((s) => s.voiceLang);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const setVoiceMicPermission = useSessionStore((s) => s.setVoiceMicPermission);

  // One in-flight listen at a time (per composer). Live dictation writes
  // DIRECTLY into the composer: the transducer's partials are append-only
  // (greedy decoding never revises emitted tokens; endpoint resets only
  // concatenate segments), so each partial EXTENDS the previous one and we
  // insert just the delta. The final text lands with a trailing space so a
  // following typed word separates.
  const lastWrittenRef = useRef("");

  /** Write one cumulative transcript update into the composer.
   *  All insertions are anchored at the DOCUMENT END (never the caret —
   *  clicking the mic blurs the editor, and Tiptap's focus() can restore the
   *  selection somewhere unexpected; a misplaced delta would trip the tail
   *  check below into re-appending the whole transcript, which is the
   *  "delete then re-dictate duplicates everything" bug).
   *
   *  Paths, in order:
   *  1. Delta append (the norm): the engine's partials are append-only, so
   *     `text` extends what we last wrote → append just the difference.
   *  2. Tail rewrite (first partial / engine revision): our previous text is
   *     still the editor's tail → replace it with the new cumulative text.
   *  3. Diverged (the user deleted/edited our tail): resync SILENTLY — never
   *     insert the full transcript next to user-modified text (duplication). */
  const applyLiveText = (text: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const prev = lastWrittenRef.current;
    if (text === prev) return;
    const cur = ed.getTextWithSkills();
    if (prev && text.startsWith(prev)) {
      ed.replaceTextRange(cur.length, cur.length, text.slice(prev.length));
    } else if (cur.endsWith(prev)) {
      ed.replaceTextRange(cur.length - prev.length, cur.length, text);
    }
    lastWrittenRef.current = text;
  };

  const { busy, start, stop, cancel, micError, clearMicError } = useVoiceInput({
    lang: voiceLang,
    onPartial: (text) => applyLiveText(text),
    onFinal: (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      applyLiveText(`${trimmed} `);
    },
  });

  // Ref mirrors of the hook/composer state — the voiceController handle and
  // the pointer/keyboard handlers read these synchronously (the `busy` STATE
  // lags by a render, and the async getUserMedia window would otherwise make
  // a quick tap's stop a no-op).
  const busyRef = useRef(false);
  const disabledRef = useRef(false);
  busyRef.current = busy;
  disabledRef.current = disabled;
  // True from listen kickoff until endListen — covers the async start window
  // where `busy` is still false. Drives the button's active visuals AND the
  // global overlay so feedback is instant on click/keypress.
  const armedRef = useRef(false);
  const [armed, setArmed] = useState(false);
  const arm = (on: boolean) => {
    armedRef.current = on;
    setArmed(on);
  };

  /** Start a fresh listen (shared by click, pointer-hold and the keyboard
   *  shortcut). No-op when one is already active or the composer is locked. */
  const beginListen = useCallback(async () => {
    if (armedRef.current || disabledRef.current) return;
    arm(true);
    lastWrittenRef.current = "";
    await start();
  }, [start]);

  /** Stop the active listen and commit the transcript. Safe when idle. */
  const endListen = useCallback(async () => {
    arm(false);
    await stop();
  }, [stop]);

  /** Discard the active listen AND the partial text it already wrote into the
   *  composer (only if the tail is untouched — user edits always win). */
  const cancelListen = useCallback(async () => {
    if (!armedRef.current) return;
    arm(false);
    await cancel();
    const ed = editorRef.current;
    const written = lastWrittenRef.current;
    if (ed && written) {
      const cur = ed.getTextWithSkills();
      if (cur.endsWith(written)) {
        ed.replaceTextRange(cur.length - written.length, cur.length, "");
      }
    }
    lastWrittenRef.current = "";
    useToastStore.getState().push({
      kind: "info",
      title: t("chat.voice.dictationCancelled"),
    });
  }, [cancel, t]);

  /** Visual + logical "listening" — armed covers the async startup window. */
  const listening = armed || busy;

  const isContinuous = voiceInputMode === "continuous";

  // Broadcast to the global listening overlay.
  useEffect(() => {
    setVoiceActive(armed);
    return () => setVoiceActive(false); // unmount safety
  }, [armed]);

  // Register this pane's mic with the global registry so the
  // `voice.dictation` command / shortcut can drive the ACTIVE session's mic.
  useEffect(
    () =>
      registerVoiceHandle(sessionId, {
        startListen: beginListen,
        stopListen: endListen,
        cancelListen,
        isBusy: () => armedRef.current || busyRef.current,
      }),
    [sessionId, beginListen, endListen, cancelListen],
  );

  // Esc while listening = discard the listen (and the text it streamed into
  // the composer). Capture phase so it wins over pane-level Esc handlers;
  // recording implies the composer has the user's attention.
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      void cancelListen();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, cancelListen]);

  // Hold-to-talk via the keyboard chord loses its keyup when the window loses
  // focus mid-hold (alt-tab) — the mic would keep recording forever. Losing
  // focus in push-to-talk mode can only mean the hold is over: stop.
  useEffect(() => {
    if (!listening || isContinuous) return;
    const onBlur = () => void endListen();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [listening, isContinuous, endListen]);

  const [menuOpen, setMenuOpen] = useState(false);
  useSuppressBrowserView(menuOpen);

  // Mode switch persists (store setter → settings table).
  const handleModeChange = (mode: VoiceInputMode) => {
    setMenuOpen(false);
    void setVoiceInputMode(mode);
  };

  // Surface mic/model errors as toasts once per error (keyed on the message so
  // repeat failures don't stack toasts). Runs in an effect — the render body
  // must not touch the toast store (setState during MicButton's render would
  // re-render Toaster mid-frame).
  const lastToastRef = useRef<string>("");
  useEffect(() => {
    if (!micError || micError === lastToastRef.current) return;
    lastToastRef.current = micError;
    const denied =
      /notallowed|permission/i.test(micError) || /denied/i.test(micError);
    if (NO_MODEL_ERROR_RE.test(micError)) {
      useToastStore.getState().push({
        kind: "info",
        title: t("chat.voice.noModel"),
        body: t("chat.voice.noModelDesc"),
      });
      // Take the user straight to where the fix lives.
      setSettingsOpen(true, "voice");
    } else {
      useToastStore.getState().push({
        kind: "warning",
        title: denied ? t("chat.voice.micDenied") : t("chat.voice.engineFail"),
        body: denied ? t("chat.voice.micDeniedDesc") : t("chat.voice.engineFailDesc"),
      });
    }
    // Mark the permission outcome so the Settings panel can reflect it.
    void setVoiceMicPermission(denied ? "denied" : "granted");
    // A listen that died in its startup window leaves `armed` set with no
    // capture behind it — reset the visual/global state.
    if (armedRef.current) arm(false);
    clearMicError();
  }, [micError, t, setSettingsOpen, setVoiceMicPermission, clearMicError]);

  /** Handle a (non-caret) click on the mic button.
   *  continuous: start/stop toggle. pushToTalk: the pointer handlers talk. */
  const handleClick = async () => {
    // Continuous: click toggles start/stop. Push-to-talk: the pointer
    // handlers own recording — a plain click after release must NOT restart.
    if (!isContinuous) return;
    if (armedRef.current) {
      await endListen();
      return;
    }
    if (disabled) return;
    await beginListen();
  };

  /** Hold-to-talk handlers — active ONLY in pushToTalk mode. */
  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (isContinuous || disabled || armedRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    void beginListen();
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!armedRef.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    void endListen();
  };

  const title = disabled
    ? t("chat.voice.lockedTitle")
    : listening
      ? t("chat.voice.listening")
      : isContinuous
        ? t("chat.voice.continuousTitle")
        : t("chat.voice.pushToTalkTitle");

  return (
    <div className="flex shrink-0 items-center gap-0">
      {/* Recording half */}
      <button
        type="button"
        disabled={disabled}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        title={title}
        aria-label={
          listening
            ? t("chat.voice.stopListening")
            : t("chat.voice.startListening")
        }
        className={cn(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-content-muted transition-all duration-150 ease-out",
          "hover:scale-110 hover:bg-accent/10 hover:text-accent active:scale-95",
          listening && "bg-accent/10 text-accent hover:text-accent",
          "disabled:scale-100 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content-muted",
        )}
      >
        {listening ? (
          <IconMicrophoneFilled size={18} className="animate-pulse" />
        ) : disabled ? (
          <IconMicrophoneOff size={18} />
        ) : (
          <IconMicrophone size={18} />
        )}
      </button>

      {/* Mode caret → menu */}
      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Menu.Trigger
          disabled={disabled || listening}
          title={t("chat.voice.modeMenu")}
          aria-label={t("chat.voice.modeMenu")}
          className={cn(
            "inline-flex h-8 w-4 shrink-0 items-center justify-center rounded-r-xl text-content-subtle transition-colors",
            "hover:text-content",
            (disabled || listening) && "cursor-not-allowed opacity-40",
          )}
        >
          <IconChevronDown size={12} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="end">
            <Menu.Popup
              className={cn(
                "z-50 min-w-[190px] origin-bottom-left rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
                "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                "transition-[transform,opacity] duration-100",
              )}
            >
              <Menu.Item
                disabled={isContinuous}
                onClick={() => handleModeChange("continuous")}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                  "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
                )}
              >
                <span className="font-medium">
                  {t("chat.voice.continuous")}
                </span>
                <span className="ml-auto text-xs text-content-subtle">
                  {isContinuous ? "✓" : ""}
                </span>
              </Menu.Item>
              <Menu.Item
                disabled={!isContinuous}
                onClick={() => handleModeChange("pushToTalk")}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                  "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
                )}
              >
                <span className="font-medium">
                  {t("chat.voice.pushToTalk")}
                </span>
                <span className="ml-auto text-xs text-content-subtle">
                  {!isContinuous ? "✓" : ""}
                </span>
              </Menu.Item>
              <Menu.Separator className="my-1 h-px bg-edge" />
              <Menu.Item
                onClick={() => {
                  setMenuOpen(false);
                  setSettingsOpen(true, "voice");
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                  "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
                )}
              >
                <IconDownload size={14} className="text-content-subtle" />
                {t("chat.voice.manageModels")}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}