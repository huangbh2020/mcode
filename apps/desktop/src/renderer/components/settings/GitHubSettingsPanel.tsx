/**
 * GitHub integration settings panel: the Personal Access Token used by the
 * right-panel GitHub PR/issue tab.
 *
 * The token is stored ENCRYPTED at rest (safeStorage) via `github:setToken`;
 * the renderer only ever handles the cleartext inside the input field and
 * never receives a stored value back (no eye-icon carve-out — re-enter to
 * change). Verification runs through the same token chain the panel uses
 * (settings → gh CLI), so "verify succeeds with an empty field" correctly
 * reports the gh CLI fallback.
 */
import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  IconLoader2,
  IconCircleCheck,
  IconBrandGithub,
  IconCopy,
  IconCheck,
  IconExternalLink,
  IconAlertTriangle,
} from "@renderer/lib/icons.js";
import type { GitHubDeviceCodeInit } from "@contracts/ipc";
import { PanelHeader } from "./PanelHeader.js";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

type VerifyState =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "ok"; login: string; source: "settings" | "gh" | "none" }
  | { phase: "fail"; error: string };

export function GitHubSettingsPanel() {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saved">("idle");
  const [verify, setVerify] = useState<VerifyState>({ phase: "idle" });

  // Device flow state
  const [deviceStage, setDeviceStage] = useState<"idle" | "starting" | "authorizing" | "error">("idle");
  const [deviceInfo, setDeviceInfo] = useState<GitHubDeviceCodeInit | null>(null);
  const [copied, setCopied] = useState(false);
  const [deviceError, setDeviceError] = useState("");

  // Reflect the current chain once on mount (also surfaces the gh fallback).
  useEffect(() => {
    void api.github.verifyToken().then((res) => {
      if (res.ok && res.login) {
        setVerify({ phase: "ok", login: res.login, source: res.source });
      } else if (res.error) {
        setVerify({ phase: "fail", error: res.error });
      }
    });
  }, []);

  const save = async () => {
    await api.github.setToken({ token: token.trim() });
    setToken("");
    setSaveState("saved");
    // Re-verify immediately so the status line follows the new token.
    setVerify({ phase: "busy" });
    try {
      const res = await api.github.verifyToken();
      if (res.ok && res.login) setVerify({ phase: "ok", login: res.login, source: res.source });
      else setVerify({ phase: "fail", error: res.error ?? "unknown" });
    } catch (err) {
      setVerify({ phase: "fail", error: (err as Error).message });
    }
  };

  const runVerify = async () => {
    setVerify({ phase: "busy" });
    try {
      const res = await api.github.verifyToken();
      if (res.ok && res.login) setVerify({ phase: "ok", login: res.login, source: res.source });
      else setVerify({ phase: "fail", error: res.error ?? "unknown" });
    } catch (err) {
      setVerify({ phase: "fail", error: (err as Error).message });
    }
  };

  const startDeviceLogin = async () => {
    setDeviceStage("starting");
    setDeviceError("");
    try {
      const init = await api.github.startDeviceFlow();
      setDeviceInfo(init);
      setDeviceStage("authorizing");
      try {
        await navigator.clipboard.writeText(init.userCode);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } catch {
        // clipboard write might fail
      }
    } catch (err) {
      setDeviceError((err as Error).message);
      setDeviceStage("error");
    }
  };

  const copyDeviceCode = async () => {
    if (!deviceInfo) return;
    try {
      await navigator.clipboard.writeText(deviceInfo.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (deviceStage !== "authorizing" || !deviceInfo) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let pollInterval = (deviceInfo.interval || 5) * 1000;

    const runPoll = async () => {
      if (cancelled) return;
      try {
        const res = await api.github.pollDeviceFlow({ deviceCode: deviceInfo.deviceCode });
        if (cancelled) return;

        if (res.status === "ok") {
          setDeviceStage("idle");
          setDeviceInfo(null);
          void runVerify();
          return;
        }

        if (res.status === "slow_down") {
          pollInterval = res.interval ? res.interval * 1000 : pollInterval + 5000;
          timer = setTimeout(runPoll, pollInterval);
          return;
        }

        if (res.status === "pending") {
          timer = setTimeout(runPoll, pollInterval);
          return;
        }

        if (res.status === "expired") {
          setDeviceError(t("github.loginExpired"));
          setDeviceStage("error");
          return;
        }

        if (res.status === "denied") {
          setDeviceError(t("github.loginDenied"));
          setDeviceStage("error");
          return;
        }

        setDeviceError(res.error ? t("github.loginFailed", { error: res.error }) : t("github.loadFailed"));
        setDeviceStage("error");
      } catch (err) {
        if (cancelled) return;
        setDeviceError((err as Error).message);
        setDeviceStage("error");
      }
    };

    timer = setTimeout(runPoll, pollInterval);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [deviceStage, deviceInfo, t]);

  const sourceLabel = (source: "settings" | "gh" | "none") =>
    source === "settings" ? t("github.tokenSourceSettings") : source === "gh" ? t("github.tokenSourceGh") : t("github.tokenSourceNone");

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader title={t("github.settingsTitle")} />

      <SettingsSection title={t("github.tokenLabel")}>
        <p className="px-4 py-2 text-content-muted [font-size:var(--settings-font-size,13px)]">{t("github.settingsDesc")}</p>

        {/* 浏览器一键授权登录 */}
        <SettingRow title={t("github.loginWithBrowser")} desc={t("github.noTokenHint")}>
          {deviceStage === "idle" && (
            <button
              type="button"
              onClick={() => void startDeviceLogin()}
              className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              <IconBrandGithub size={13} />
              {t("github.loginWithBrowser")}
            </button>
          )}

          {deviceStage === "starting" && (
            <div className="flex items-center gap-2 text-xs text-content-muted">
              <IconLoader2 size={13} className="animate-spin text-accent" />
              <span>{t("github.loginStarting")}</span>
            </div>
          )}

          {deviceStage === "authorizing" && deviceInfo && (
            <div className="flex flex-col items-start gap-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void copyDeviceCode()}
                  title={t("github.copyCode")}
                  className="group flex items-center gap-2 rounded border border-edge bg-surface-hover px-2.5 py-1 text-xs"
                >
                  <span className="font-mono text-sm font-bold tracking-widest text-content">{deviceInfo.userCode}</span>
                  {copied ? (
                    <IconCheck size={13} className="text-success" />
                  ) : (
                    <IconCopy size={13} className="text-content-subtle group-hover:text-accent" />
                  )}
                </button>
                {copied && <span className="text-xs text-success">{t("github.copied")}</span>}
                <button
                  type="button"
                  onClick={() => window.open(deviceInfo.verificationUri, "_blank", "noopener,noreferrer")}
                  className="flex items-center gap-1 rounded bg-surface-hover px-2 py-1 text-xs text-content-muted hover:text-content"
                >
                  <IconExternalLink size={12} />
                  {t("github.openBrowserAgain")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDeviceStage("idle");
                    setDeviceInfo(null);
                  }}
                  className="rounded px-2 py-1 text-xs text-content-subtle hover:bg-surface-hover hover:text-content"
                >
                  {t("github.cancelLogin")}
                </button>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-content-subtle">
                <IconLoader2 size={11} className="animate-spin text-accent" />
                <span>{t("github.waitingForAuth")}</span>
              </div>
            </div>
          )}

          {deviceStage === "error" && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-danger">{deviceError}</span>
              <button
                type="button"
                onClick={() => void startDeviceLogin()}
                className="rounded bg-accent/15 px-2 py-1 text-accent hover:bg-accent/25"
              >
                {t("github.retry")}
              </button>
              <button
                type="button"
                onClick={() => setDeviceStage("idle")}
                className="rounded px-2 py-1 text-content-subtle hover:bg-surface-hover hover:text-content"
              >
                {t("github.cancelLogin")}
              </button>
            </div>
          )}
        </SettingRow>

        {/* 手动输入 PAT */}
        <SettingRow title={t("github.tokenLabel")} desc={t("github.tokenScopeHint")} htmlFor="setting-github-token">
          <div className="flex items-center gap-2">
            <input
              id="setting-github-token"
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setSaveState("idle");
              }}
              placeholder={t("github.tokenPlaceholder")}
              autoComplete="off"
              className="w-64 rounded border border-edge bg-surface px-2 py-1 text-content text-xs outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={!token.trim()}
              className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {t("github.tokenSave")}
            </button>
            <button
              type="button"
              onClick={() => void runVerify()}
              disabled={verify.phase === "busy"}
              className="rounded px-2.5 py-1 text-xs text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-40"
            >
              {verify.phase === "busy" ? <IconLoader2 size={12} className="animate-spin" /> : t("github.tokenVerify")}
            </button>
          </div>
        </SettingRow>
        <div className="px-4 pb-3 text-xs">
          {saveState === "saved" && <p className="text-success">{t("github.tokenSaved")}</p>}
          {verify.phase === "ok" && (
            <p className="flex items-center gap-1 text-success">
              <IconCircleCheck size={13} />
              {t("github.verifyOk", { login: verify.login, source: sourceLabel(verify.source) })}
            </p>
          )}
          {verify.phase === "fail" && <p className="text-danger">{t("github.verifyFail", { error: verify.error })}</p>}
        </div>
      </SettingsSection>
    </section>
  );
}
