/**
 * RemoteConnectPanel — the "remote access" sub-panel of the connect-phone
 * dialog.
 *
 * Lets the user configure a VPS for SSH-based relay access. Once connected,
 * the phone can reach the desktop from anywhere (not just the LAN) through
 * the VPS. The panel handles: VPS config form, connect/disconnect, status
 * display, and QR-code + pairing link when connected.
 *
 * Relay state arrives via `api.on.relayEvent` (pushed from main), so the
 * panel reflects connection/forwarder/error state without polling.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button, Switch } from "@renderer/components/ui/index.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconCopy,
  IconRefresh,
  IconServer,
  IconLoader2,
  IconAlertCircle,
  IconCheck,
  IconWifi,
  IconWorld,
} from "@renderer/lib/icons.js";
import { api } from "@renderer/lib/api.js";
import { copyText } from "@renderer/lib/clipboard.js";
import type { RelayStatus, RelayVpsConfig } from "@contracts/ipc";
import { RELAY_AUTO_START_SETTING_KEY } from "@contracts/relay";
import { useI18n } from "@renderer/lib/i18n/index.js";

const STATE_LABELS: Record<RelayStatus["state"], string> = {
  idle: "未连接",
  connecting: "正在连接服务器…",
  deploying: "正在部署转发服务…",
  connected: "已连接",
  error: "连接失败",
};

export function RemoteConnectPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [config, setConfig] = useState<RelayVpsConfig | null>(null);
  const [autoStart, setAutoStart] = useState(false);
  const [form, setForm] = useState({
    host: "",
    sshPort: "22",
    username: "root",
    password: "",
    publicPort: "7331",
  });
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Subscribe to relay events.
  useEffect(() => {
    const unsub = api.on.relayEvent((msg) => {
      setStatus(msg.status);
    });
    return unsub;
  }, []);

  // Load initial state.
  const refresh = useCallback(async () => {
    try {
      const [s, c, as] = await Promise.all([
        api.relay.status(),
        api.relay.getConfig(),
        api.setting.get({ key: RELAY_AUTO_START_SETTING_KEY }),
      ]);
      setStatus(s);
      setConfig(c.config);
      setAutoStart(as.value === "1");
      if (c.config) {
        setForm({
          host: c.config.host,
          sshPort: String(c.config.sshPort),
          username: c.config.username,
          password: c.config.password,
          publicPort: String(c.config.publicPort),
        });
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Generate pairing when connected. `force` voids the pending pairing and
  // issues a fresh code — the manual refresh button passes it (without it,
  // startPairing reuses the pending pairing within its TTL and the UI shows
  // the identical QR/code, i.e. a visible no-op).
  const generatePairing = useCallback(async (endpoint: string, force = false) => {
    try {
      const res = await api.mobile.startPairing({ mode: "remote", endpoint, force });
      setPairingUrl(res.pairing.qrUrl);
      setPairingCode(res.pairing.code);
      const dataUrl = await QRCode.toDataURL(res.pairing.qrUrl, {
        margin: 1,
        width: 220,
        color: { dark: "#0b0b0c", light: "#ffffff" },
      });
      setQrDataUrl(dataUrl);
    } catch (err) {
      console.error("remote pairing failed", err);
    }
  }, []);

  useEffect(() => {
    if (status?.state === "connected" && status.endpoint && !pairingUrl) {
      void generatePairing(status.endpoint);
    }
    if (status?.state !== "connected") {
      setPairingUrl(null);
      setPairingCode(null);
      setQrDataUrl(null);
    }
  }, [status, pairingUrl, generatePairing]);

  // Poll while not connected.
  useEffect(() => {
    if (status?.state === "connected") {
      if (pollTimer.current) clearInterval(pollTimer.current);
      return;
    }
    pollTimer.current = setInterval(() => void refresh(), 3000);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [status, refresh]);

  const handleConnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Save config first.
      await api.relay.saveConfig({
        host: form.host.trim(),
        sshPort: parseInt(form.sshPort, 10) || 22,
        username: form.username.trim() || "root",
        password: form.password,
        publicPort: parseInt(form.publicPort, 10) || 7331,
      });
      const result = await api.relay.connect();
      if (!result.ok) {
        console.error("relay connect failed:", result.error);
      }
    } finally {
      setBusy(false);
    }
  }, [form, busy]);

  const handleDisconnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.relay.disconnect();
    } finally {
      setBusy(false);
    }
  }, [busy]);

  /** Persist the "start on launch" preference. */
  const handleAutoStartChange = useCallback(async (checked: boolean) => {
    setAutoStart(checked);
    try {
      await api.setting.set({ key: RELAY_AUTO_START_SETTING_KEY, value: checked ? "1" : "0" });
    } catch (err) {
      console.error("set autoStart failed", err);
    }
  }, []);

  const copyLink = useCallback(async () => {
    if (!pairingUrl) return;
    const ok = await copyText(pairingUrl);
    if (ok) setCopied(true);
    else console.error("copy pairing link failed");
  }, [pairingUrl]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const handleRefreshPairing = useCallback(() => {
    if (status?.endpoint) void generatePairing(status.endpoint, true);
  }, [status, generatePairing]);

  const isConnected = status?.state === "connected";
  const isBusy =
    status?.state === "connecting" ||
    status?.state === "deploying" ||
    busy;

  return (
    <div className="flex flex-col gap-4">
      {/* Info banner */}
      <div className="flex items-start gap-2 rounded border border-edge bg-surface-muted/50 px-3 py-2 text-xs leading-relaxed text-content-muted">
        <IconServer size={14} className="mt-0.5 shrink-0 text-accent" />
        <span>
          通过你自己的服务器（VPS）转发，手机可在任意网络访问。
          服务器需有 SSH 访问权限，且安装了 <code className="font-mono text-content">socat</code> 或 <code className="font-mono text-content">python3</code>。
        </span>
      </div>

      {/* Start on launch toggle */}
      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-edge bg-surface-muted/30 px-3 py-2.5">
        <Switch checked={autoStart} onCheckedChange={handleAutoStartChange} label={t("layout.relayAutoStart")} />
        <span className="min-w-0 flex-1 text-xs text-content">{t("layout.relayAutoStart")}</span>
        <span className="shrink-0 text-[11px] text-content-subtle">
          {autoStart ? t("layout.relayAutoStartOn") : t("layout.relayAutoStartOff")}
        </span>
      </label>

      {/* VPS config form (shown when not connected) */}
      {!isConnected && (
        <div className="flex flex-col gap-3 rounded-lg border border-edge bg-surface-muted/30 p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-xs font-medium text-content-muted">服务器 IP / 域名</span>
              <input
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
                placeholder="1.2.3.4 或 vps.example.com"
                className="rounded-lg border border-input-edge bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
                disabled={isBusy}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-content-muted">SSH 端口</span>
              <input
                value={form.sshPort}
                onChange={(e) => setForm({ ...form, sshPort: e.target.value.replace(/\D/g, "") })}
                className="rounded-lg border border-input-edge bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
                disabled={isBusy}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-content-muted">用户名</span>
              <input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                className="rounded-lg border border-input-edge bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
                disabled={isBusy}
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-xs font-medium text-content-muted">密码</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="SSH 登录密码"
                className="rounded-lg border border-input-edge bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
                disabled={isBusy}
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-xs font-medium text-content-muted">公网端口（手机访问的端口）</span>
              <input
                value={form.publicPort}
                onChange={(e) => setForm({ ...form, publicPort: e.target.value.replace(/\D/g, "") })}
                className="rounded-lg border border-input-edge bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
                disabled={isBusy}
              />
            </label>
          </div>
        </div>
      )}

      {/* Status + connect/disconnect */}
      <div className="flex items-center gap-3 rounded-lg border border-edge bg-surface-muted/50 px-3 py-2.5">
        <IconServer
          size={20}
          className={cn(
            "shrink-0",
            isConnected ? "text-success" : isBusy ? "text-content-muted" : "text-content-subtle",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-content">
            {status ? STATE_LABELS[status.state] : "加载中…"}
          </div>
          {status?.endpoint && (
            <div className="truncate font-mono text-[11px] text-content-subtle">{status.endpoint}</div>
          )}
          {status?.error && (
            <div className="flex items-start gap-1 text-[11px] leading-relaxed text-danger">
              <IconAlertCircle size={11} className="mt-0.5 shrink-0" />
              <span>{status.error}</span>
            </div>
          )}
          {status?.forwarderType && (
            <div className="text-[11px] text-content-subtle">
              转发服务：{status.forwarderType}
            </div>
          )}
        </div>
        {isConnected ? (
          <Button variant="ghost" size="sm" onClick={() => void handleDisconnect()} disabled={busy}>
            断开
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void handleConnect()}
            disabled={isBusy || !form.host.trim()}
          >
            {isBusy ? <IconLoader2 size={14} className="animate-spin" /> : <IconWorld size={14} />}
            {status?.state === "connecting" ? "连接中…" : status?.state === "deploying" ? "部署中…" : "连接"}
          </Button>
        )}
      </div>

      {/* Pairing section (only when connected) */}
      {isConnected && pairingUrl && (
        <div className="flex gap-4 border-t border-edge pt-4">
          <div className="flex flex-col items-center gap-2">
            <div className="rounded-lg border border-edge bg-white p-2">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="远程配对二维码" className="h-[150px] w-[150px]" />
              ) : (
                <div className="flex h-[150px] w-[150px] items-center justify-center text-xs text-content-subtle">
                  生成中…
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleRefreshPairing()}
                className="flex items-center gap-1 text-xs text-content-muted hover:text-content"
              >
                <IconRefresh size={12} /> 刷新
              </button>
              <button
                type="button"
                onClick={() => void copyLink()}
                className="flex items-center gap-1 text-xs text-content-muted hover:text-content"
              >
                {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                {copied ? "已复制" : "复制链接"}
              </button>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="text-xs text-content-muted">验证码</div>
            <div className="mt-1 font-mono text-3xl font-bold tracking-[0.3em] text-content">
              {pairingCode ?? "------"}
            </div>
            <div className="mt-3 rounded border border-edge bg-surface-muted/30 px-3 py-2 text-[11px] leading-relaxed text-content-muted">
              <p className="mb-1 font-medium text-content">远程配对步骤：</p>
              <ol className="list-inside list-decimal space-y-0.5">
                <li>将上面的链接发送到手机</li>
                <li>在手机浏览器中打开</li>
                <li>输入上面的验证码完成配对</li>
              </ol>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
