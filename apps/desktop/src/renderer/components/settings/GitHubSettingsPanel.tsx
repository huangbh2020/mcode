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
import { IconLoader2, IconCircleCheck } from "@renderer/lib/icons.js";
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

  const sourceLabel = (source: "settings" | "gh" | "none") =>
    source === "settings" ? t("github.tokenSourceSettings") : source === "gh" ? t("github.tokenSourceGh") : t("github.tokenSourceNone");

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader title={t("github.settingsTitle")} />

      <SettingsSection title={t("github.tokenLabel")}>
        <p className="px-4 py-2 text-content-muted [font-size:var(--settings-font-size,13px)]">{t("github.settingsDesc")}</p>
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
