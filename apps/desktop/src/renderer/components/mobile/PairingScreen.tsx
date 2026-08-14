/**
 * PairingScreen — the pre-auth gate of the web (phone) shell.
 *
 * The phone reaches this page by scanning the QR shown in the PC's "connect
 * phone" dialog: `http://<lan-ip>:<port>/?nonce=<nonce>`. The nonce pins the
 * page to the pairing session the PC just started; the user types the 6-digit
 * code displayed on the PC, and the server issues a device token that
 * everything afterwards rides on (Authorization: Bearer). Token → localStorage,
 * so a reload skips this screen entirely.
 */
import { useEffect, useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { IconKey, IconLoader2, IconAlertCircle, IconDeviceMobile } from "@renderer/lib/icons.js";
import { pairWithCode } from "@renderer/lib/webApi.js";

/** The pairing nonce embedded in the QR URL (`?nonce=…`). Null when the page
 *  was opened without it (typed URL, stale link, or wrong QR). */
function readNonce(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("nonce");
  } catch {
    return null;
  }
}

/** A friendly default device name from the UA — shown to the PC so the user
 *  can tell paired devices apart. */
function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (ua.includes("iPhone")) return "iPhone";
  if (ua.includes("iPad")) return "iPad";
  if (ua.includes("Android")) return "Android 手机";
  return "浏览器设备";
}

export function PairingScreen({ onPaired }: { onPaired: () => void }) {
  const nonce = useMemo(readNonce, []);
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the error when the code changes (the "wrong code" state shouldn't
  // stick while the user is typing the next attempt).
  useEffect(() => {
    setError(null);
  }, [code]);

  const submit = async () => {
    if (!nonce || busy) return;
    if (code.trim().length < 4) {
      setError("请输入电脑端显示的验证码");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await pairWithCode({
        nonce,
        code: code.trim(),
        deviceName: deviceName.trim() || defaultDeviceName(),
      });
      onPaired();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-surface px-6 text-content">
      <div className="flex w-full max-w-sm flex-col gap-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-muted">
            <IconDeviceMobile size={28} className="text-accent" />
          </div>
          <h1 className="text-lg font-semibold">连接 Mcode</h1>
          <p className="text-sm leading-relaxed text-content-muted">
            {nonce
              ? "在电脑端「连接手机」弹窗中查看 6 位验证码,输入后即可开始使用。"
              : "此链接缺少配对信息。请用手机相机扫描电脑端「连接手机」弹窗中的二维码后重新打开。"}
          </p>
        </div>

        {nonce && (
          <div className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-muted/50 p-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-content-muted">验证码</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                placeholder="••••••"
                className="w-full rounded-lg border border-input-edge bg-surface px-3 py-2.5 text-center font-mono text-xl tracking-[0.4em] text-content outline-none focus:border-accent"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-content-muted">设备名称(可选)</span>
              <input
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="我的手机"
                className="w-full rounded-lg border border-input-edge bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
              />
            </label>
            {error && (
              <div className="flex items-start gap-1.5 text-xs leading-relaxed text-danger">
                <IconAlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              className={cn(
                "flex h-10 items-center justify-center gap-1.5 rounded-lg bg-accent text-sm font-medium text-surface",
                "hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {busy ? <IconLoader2 size={16} className="animate-spin" /> : <IconKey size={16} />}
              {busy ? "配对中…" : "完成配对"}
            </button>
          </div>
        )}

        <p className="text-center text-xs text-content-subtle">
          配对码有效期 5 分钟 · 服务器:{window.location.origin || "未知"}
        </p>
      </div>
    </div>
  );
}
