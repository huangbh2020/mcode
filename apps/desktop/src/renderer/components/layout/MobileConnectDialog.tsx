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
import QRCode from "qrcode";
import { Dialog } from "@renderer/components/ui/index.js";
import { Button } from "@renderer/components/ui/index.js";
import { cn } from "@renderer/lib/cn.js";
import { IconCopy, IconDeviceMobile, IconRefresh, IconTrash, IconWifi, IconWorld } from "@renderer/lib/icons.js";
import { api } from "@renderer/lib/api.js";
import { RemoteConnectPanel } from "@renderer/components/mobile/RemoteConnectPanel.js";
import type { PairingStartResult, PairedDevice } from "@contracts/mobile";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Self-contained trigger button + dialog, rendered in the left sidebar's quick
 *  actions (below 搜索). The trigger matches the search/new-session button
 *  style; renders its own Dialog.Root so the sidebar only needs
 *  `<MobileConnectButton />`. */
export function MobileConnectButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-1 py-2 transition-colors",
          "[font-size:var(--right-panel-font-size)]",
          "text-content-muted hover:bg-accent/10 hover:text-accent",
          open && "bg-accent/10 text-accent",
        )}
        title={t("layout.connectPhone")}
      >
        <IconDeviceMobile size={16} className="shrink-0" />
        <span className="flex-1 text-left font-medium">{t("layout.connectPhone")}</span>
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
  const { t } = useI18n();
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
      <Dialog.Title>{t("layout.connectPhone")}</Dialog.Title>
      <Dialog.Description>{t("layout.connectPhoneDesc")}</Dialog.Description>
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
          {t("layout.pairLan")}
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
          {t("layout.remoteAccess")}
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
              {t("layout.mobileServerDown")}
            </div>
          )}

          <div className="mt-4 flex gap-4">
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-lg border border-edge bg-white p-2">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt={t("layout.pairingQr")} className="h-[180px] w-[180px]" />
                ) : (
                  <div className="flex h-[180px] w-[180px] items-center justify-center text-xs text-content-subtle">
                    {t("layout.generating")}
                  </div>
                )}
              </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void beginPairing()}
              className="flex items-center gap-1 text-xs text-content-muted hover:text-content"
            >
              <IconRefresh size={12} /> {t("layout.refreshQr")}
            </button>
            <button
              type="button"
              onClick={() => void copyPairingLink()}
              disabled={!pairing}
              className="flex items-center gap-1 text-xs text-content-muted hover:text-content disabled:opacity-40"
              title={t("layout.copyPairingLinkTitle")}
            >
              <IconCopy size={12} /> {copied ? t("common.copied") : t("layout.copyLink")}
            </button>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="text-xs text-content-muted">{t("layout.verifyCode")}</div>
          <div className="mt-1 font-mono text-3xl font-bold tracking-[0.3em] text-content">
            {pairing ? pairing.code : "------"}
          </div>
          <div className="mt-1 text-[11px] text-content-subtle">
            {pairing
              ? expired
                ? t("layout.pairingExpired")
                : t("layout.pairingExpiresIn", {
                    time: `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, "0")}`,
                  })
              : ""}
          </div>
          {status?.endpoint && (
            <div className="mt-3 text-[11px] text-content-subtle">
              {t("layout.lanAddress")}
              <span className="font-mono">{status.endpoint}</span>
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
                    title={t("layout.regenerateWithIp", { ip })}
                  >
                    {ip}
                  </button>
                ))}
            </div>
          )}
          <div className="mt-1 text-[11px] text-content-subtle">
            {t("layout.lanHint")}
          </div>
        </div>
      </div>
        </>
      )}

      <div className="mt-5">
        <div className="mb-2 text-xs font-medium text-content-muted">
          {t("layout.connectedDevices", { n: devices.length })}
        </div>
        {devices.length === 0 ? (
          <div className="rounded border border-dashed border-edge px-3 py-3 text-center text-xs text-content-subtle">
            {t("layout.noDevices")}
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
                    {t("layout.pairedAt", { time: new Date(d.pairedAt).toLocaleString() })}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRevoke(d.deviceId)}
                  className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-danger"
                  title={t("layout.revokeDevice")}
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
          {t("layout.refreshDevices")}
        </Button>
      </div>
    </>
  );
}
