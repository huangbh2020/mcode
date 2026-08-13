/**
 * MobileConnectDialog — PC-side "connect phone" dialog.
 *
 * Owns the full pairing UX: when opened it asks main for a fresh pairing
 * (QR URL + 6-digit code), renders the QR via `qrcode`, polls the connected-
 * device list, and lets the user revoke a device. The dialog is self-contained
 * and exposes a trigger button the Titlebar renders.
 *
 * Pairing lifecycle:
 *   open → mobile.startPairing() → show QR + code (5-min countdown)
 *   phone scans + enters code → main verifies → device appears in list
 *   close → stop polling (the pending pairing stays alive on the server for
 *   its full TTL — cancelling on close broke the common test flow where the
 *   user reads the code, then switches to the phone to type it).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import QRCode from "qrcode";
import { Dialog } from "@renderer/components/ui/index.js";
import { Button } from "@renderer/components/ui/index.js";
import { cn } from "@renderer/lib/cn.js";
import { IconCopy, IconDeviceMobile, IconRefresh, IconTrash, IconWifi, IconWorld } from "@renderer/lib/icons.js";
import { api } from "@renderer/lib/api.js";
import { RemoteConnectPanel } from "@renderer/components/mobile/RemoteConnectPanel.js";
import type { PairingStartResult, PairedDevice } from "@contracts/mobile";

/** Small self-contained trigger button + dialog. Renders its own Dialog.Root
 *  so the Titlebar only needs `<MobileConnectButton />`. */
export function MobileConnectButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex items-center justify-center rounded p-1.5 transition-colors",
          "text-content-muted hover:bg-surface-hover hover:text-content",
          open && "bg-surface-hover text-accent",
        )}
        title="连接手机"
        style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      >
        <IconDeviceMobile size={18} className="shrink-0" />
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[min(420px,92vw)] p-5">
            <MobileConnectPanel open={open} />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function MobileConnectPanel({ open }: { open: boolean }) {
  const [tab, setTab] = useState<"lan" | "remote">("lan");
  const [pairing, setPairing] = useState<PairingStartResult | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [status, setStatus] = useState<{ running: boolean; endpoint: string; lanIp: string | null; lanIps: string[] } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const beginPairing = useCallback(async (host?: string) => {
    try {
      const res = await api.mobile.startPairing(host ? { host } : undefined);
      setPairing(res.pairing);
      const dataUrl = await QRCode.toDataURL(res.pairing.qrUrl, {
        margin: 1,
        width: 220,
        color: { dark: "#0b0b0c", light: "#ffffff" },
      });
      setQrDataUrl(dataUrl);
    } catch (err) {
      console.error("startPairing failed", err);
    }
  }, []);

  /** Regenerate the pairing using a specific LAN IP (when the phone can't reach
   *  the auto-detected one). */
  const rebindEndpoint = useCallback(
    (ip: string) => {
      void beginPairing(ip);
    },
    [beginPairing],
  );

  /** Copy the pairing link (QR content) to the clipboard — the PC-testing path
   *  that doesn't need a phone to decode the QR. */
  const copyPairingLink = useCallback(async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.qrUrl);
      setCopied(true);
    } catch (err) {
      console.error("copy pairing link failed", err);
    }
  }, [pairing]);

  // Auto-reset the "已复制" feedback after 2s.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const refreshDevices = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([api.mobile.listDevices(), api.mobile.getStatus()]);
      setDevices(d.devices);
      setStatus({ running: s.running, endpoint: s.endpoint, lanIp: s.lanIp, lanIps: s.lanIps });
    } catch {
      // ignore — non-fatal
    }
  }, []);

  // On open: start a pairing + load devices/status. The pending pairing stays
  // alive on the server for its full TTL (5 min) even after the dialog closes
  // (see header). Closing just stops polling + clears local UI state.
  useEffect(() => {
    if (!open) {
      setPairing(null);
      setQrDataUrl(null);
      if (pollTimer.current) clearInterval(pollTimer.current);
      return;
    }
    void beginPairing();
    void refreshDevices();
    // Poll device list every 3s while open (so a freshly-paired phone appears).
    pollTimer.current = setInterval(() => {
      void refreshDevices();
    }, 3000);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [open, beginPairing, refreshDevices]);

  // 1s ticker for the countdown + auto-refresh pairing when expired.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  const expired = pairing ? now > pairing.expiresAt : false;
  useEffect(() => {
    if (open && pairing && expired) {
      // Auto-renew once expired so the user doesn't have to click.
      void beginPairing();
    }
  }, [open, pairing, expired, beginPairing]);

  const remainingSec = useMemo(() => {
    if (!pairing) return 0;
    return Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000));
  }, [pairing, now]);

  const handleRevoke = useCallback(
    async (deviceId: string) => {
      try {
        await api.mobile.revokeDevice({ deviceId });
        await refreshDevices();
      } catch (err) {
        console.error("revoke failed", err);
      }
    },
    [refreshDevices],
  );

  const serverDown = status && !status.running;

  return (
    <>
      <Dialog.Title>连接手机</Dialog.Title>
      <Dialog.Description>用手机扫码并在手机上输入验证码，完成配对。</Dialog.Description>
      <Dialog.Close />

      {/* Mode tabs */}
      <div className="mt-3 flex gap-1 border-b border-edge">
        <button
          type="button"
          onClick={() => setTab("lan")}
          className={cn(
            "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
            tab === "lan"
              ? "border-accent text-accent"
              : "border-transparent text-content-muted hover:text-content",
          )}
        >
          <IconWifi size={14} />
          局域网配对
        </button>
        <button
          type="button"
          onClick={() => setTab("remote")}
          className={cn(
            "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
            tab === "remote"
              ? "border-accent text-accent"
              : "border-transparent text-content-muted hover:text-content",
          )}
        >
          <IconWorld size={14} />
          远程访问
        </button>
      </div>

      {/* Remote mode */}
      {tab === "remote" ? (
        <div className="mt-4">
          <RemoteConnectPanel />
        </div>
      ) : (
        <>
          {serverDown && (
            <div className="mt-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              手机服务未运行（端口被占用或已禁用）。请在设置中检查，或重启应用。
            </div>
          )}

          <div className="mt-4 flex gap-4">
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-lg border border-edge bg-white p-2">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="配对二维码" className="h-[180px] w-[180px]" />
                ) : (
                  <div className="flex h-[180px] w-[180px] items-center justify-center text-xs text-content-subtle">
                    生成中…
                  </div>
                )}
              </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void beginPairing()}
              className="flex items-center gap-1 text-xs text-content-muted hover:text-content"
            >
              <IconRefresh size={12} /> 刷新二维码
            </button>
            <button
              type="button"
              onClick={() => void copyPairingLink()}
              disabled={!pairing}
              className="flex items-center gap-1 text-xs text-content-muted hover:text-content disabled:opacity-40"
              title="复制配对链接，可在电脑浏览器中打开测试"
            >
              <IconCopy size={12} /> {copied ? "已复制" : "复制链接"}
            </button>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="text-xs text-content-muted">验证码</div>
          <div className="mt-1 font-mono text-3xl font-bold tracking-[0.3em] text-content">
            {pairing ? pairing.code : "------"}
          </div>
          <div className="mt-1 text-[11px] text-content-subtle">
            {pairing ? (expired ? "已过期，正在刷新…" : `约 ${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, "0")} 后过期`) : ""}
          </div>
          {status?.endpoint && (
            <div className="mt-3 text-[11px] text-content-subtle">
              局域网地址：<span className="font-mono">{status.endpoint}</span>
            </div>
          )}
          {/* When auto-detection has alternatives, surface them so the user can
              pick the right interface if the phone can't reach the chosen one
              (common with multi-NIC machines / VMs). */}
          {status && status.lanIps.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {status.lanIps
                .filter((ip) => status.endpoint.indexOf(ip) < 0)
                .map((ip) => (
                  <button
                    key={ip}
                    type="button"
                    onClick={() => void rebindEndpoint(ip)}
                    className="rounded border border-edge px-1.5 py-0.5 font-mono text-[10px] text-content-subtle hover:bg-surface-hover hover:text-content"
                    title={`用这个 IP 重新生成二维码: ${ip}`}
                  >
                    {ip}
                  </button>
                ))}
            </div>
          )}
          <div className="mt-1 text-[11px] text-content-subtle">
            手机需与电脑在同一局域网。若扫码后空白，点上面的备用 IP 切换。
          </div>
        </div>
      </div>
        </>
      )}

      <div className="mt-5">
        <div className="mb-2 text-xs font-medium text-content-muted">已连接设备（{devices.length}）</div>
        {devices.length === 0 ? (
          <div className="rounded border border-dashed border-edge px-3 py-3 text-center text-xs text-content-subtle">
            还没有设备配对
          </div>
        ) : (
          <ul className="space-y-1.5">
            {devices.map((d) => (
              <li
                key={d.deviceId}
                className="flex items-center gap-2 rounded border border-edge bg-surface-muted px-3 py-2"
              >
                <IconDeviceMobile size={16} className="shrink-0 text-content-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-content">{d.name}</div>
                  <div className="text-[11px] text-content-subtle">
                    配对于 {new Date(d.pairedAt).toLocaleString()}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRevoke(d.deviceId)}
                  className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-danger"
                  title="断开该设备"
                >
                  <IconTrash size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-5 flex justify-end">
        <Button variant="ghost" onClick={() => void refreshDevices()}>
          刷新设备列表
        </Button>
      </div>
    </>
  );
}
