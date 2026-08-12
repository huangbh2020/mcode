/**
 * PairingScreen — the verification-code entry shown after scanning the QR.
 *
 * The QR encodes `http://<lan-ip>:<port>/?nonce=<nonce>`, so on load this
 * reads the nonce from the URL and presents a 6-cell code input. Submitting
 * calls `mobileApi.pair({ nonce, code, deviceName })`; on success the api
 * persists the token and `onPaired` flips the shell into the chat.
 *
 * Device name defaults to a friendly browser-derived label ("iPhone — Safari"),
 * which shows up in the PC's paired-device list.
 */
import { useEffect, useRef, useState } from "react";
import { mobileApi } from "../lib/mobileApi.js";

interface Props {
  onPaired: () => void;
}

function defaultDeviceName(): string {
  try {
    const ua = navigator.userAgent;
    const isIphone = /iphone/i.test(ua);
    const isAndroid = /android/i.test(ua);
    const browser = /edg/i.test(ua)
      ? "Edge"
      : /chrome/i.test(ua)
        ? "Chrome"
        : /safari/i.test(ua)
          ? "Safari"
          : "Browser";
    return `${isIphone ? "iPhone" : isAndroid ? "Android" : "手机"} · ${browser}`;
  } catch {
    return "手机";
  }
}

export function PairingScreen({ onPaired }: Props) {
  const nonce = useMemoNonce();
  const [cells, setCells] = useState<string[]>(["", "", "", "", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  // Auto-focus the first cell on mount.
  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  // Auto-submit when all 6 cells are filled.
  useEffect(() => {
    const code = cells.join("");
    if (code.length === 6 && /^\d{6}$/.test(code) && !submitting) {
      void submit(code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells]);

  const submit = async (code: string) => {
    if (!nonce) {
      setError("无效的配对链接，请重新扫描二维码。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await mobileApi.pair({ nonce, code, deviceName: defaultDeviceName() });
      onPaired();
    } catch (err) {
      setError((err as Error).message || "配对失败");
      // Clear cells so the user can retype.
      setCells(["", "", "", "", "", ""]);
      refs.current[0]?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  const onCellChange = (i: number, raw: string) => {
    const digit = raw.replace(/\D/g, "").slice(-1);
    const next = [...cells];
    next[i] = digit;
    setCells(next);
    if (digit && i < 5) refs.current[i + 1]?.focus();
  };

  const onCellKeyDown = (i: number, ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Backspace" && !cells[i] && i > 0) {
      refs.current[i - 1]?.focus();
    }
  };

  const onPaste = (ev: React.ClipboardEvent) => {
    const text = ev.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (text.length > 0) {
      ev.preventDefault();
      const next = ["", "", "", "", "", ""];
      for (let i = 0; i < text.length; i++) next[i] = text[i];
      setCells(next);
      refs.current[Math.min(text.length, 5)]?.focus();
    }
  };

  return (
    <div className="no-select flex h-full flex-col items-center justify-center px-6">
      <div className="mb-2 text-3xl">📱</div>
      <h1 className="text-lg font-semibold text-content">Mcode</h1>
      <p className="mt-1 text-center text-sm text-content-muted">连接到你的电脑</p>

      <p className="mt-8 text-center text-xs text-content-subtle">请输入电脑端显示的 6 位验证码</p>

      <div className="mt-4 flex gap-2" onPaste={onPaste}>
        {cells.map((c, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={c}
            onChange={(e) => onCellChange(i, e.target.value)}
            onKeyDown={(e) => onCellKeyDown(i, e)}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={1}
            disabled={submitting}
            className="h-14 w-12 rounded-lg border border-edge bg-surface text-center text-2xl font-bold text-content outline-none focus:border-accent"
          />
        ))}
      </div>

      {error && <p className="mt-4 text-center text-xs text-danger">{error}</p>}

      {!nonce && (
        <p className="mt-6 max-w-xs text-center text-xs text-content-subtle">
          未检测到配对信息。请在电脑端点击「连接手机」，用手机相机扫描弹窗中的二维码后再输入验证码。
        </p>
      )}

      <button
        type="button"
        onClick={() => void submit(cells.join(""))}
        disabled={submitting || cells.join("").length !== 6}
        className="mt-8 w-full max-w-xs rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
      >
        {submitting ? "连接中…" : "连接"}
      </button>
    </div>
  );
}

/** Extract the `nonce` query param once from the URL (memoized). */
function useMemoNonce(): string | null {
  const [nonce] = useState<string | null>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("nonce");
    } catch {
      return null;
    }
  });
  return nonce;
}
