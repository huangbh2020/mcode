/**
 * Modal dialog for adding an isolated Antigravity (`agy acp`) account:
 *   - Gemini API Key (`--gemini-dir` isolated)
 *   - Capture current Google OAuth login snapshot (`--gemini-dir` isolated)
 *   - GCP / Vertex AI (`--gemini-dir` isolated)
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconX } from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";

type AccountTab = "gemini-api-key" | "oauth-personal" | "agent-platform";

export function AntigravityAccountDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const reloadAntigravityAccounts = useSessionStore((s) => s.reloadAntigravityAccounts);
  const selectAntigravityAccount = useSessionStore((s) => s.selectAntigravityAccount);

  const [tab, setTab] = useState<AccountTab>("gemini-api-key");
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [gcpProject, setGcpProject] = useState("");
  const [gcpLocation, setGcpLocation] = useState("global");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useSuppressBrowserView(open);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const resetForm = () => {
    setName("");
    setApiKey("");
    setBaseUrl("");
    setGcpProject("");
    setGcpLocation("global");
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (tab === "oauth-personal") {
        const res = await window.api.antigravity.captureGoogleAccount({ name: name.trim() });
        if (!res.ok || !res.account) {
          setError(res.error ?? "Failed to capture Google login");
          return;
        }
        await reloadAntigravityAccounts();
        await selectAntigravityAccount(res.account.id);
        resetForm();
        onClose();
        return;
      }

      const res = await window.api.antigravity.saveAccount({
        name: name.trim(),
        method: tab,
        ...(tab === "gemini-api-key"
          ? { apiKey: apiKey.trim(), baseUrl: baseUrl.trim() || undefined }
          : { gcpProject: gcpProject.trim(), gcpLocation: gcpLocation.trim() || "global" }),
      });
      if (!res.ok || !res.account) {
        setError(res.error ?? "Failed to save account");
        return;
      }
      await reloadAntigravityAccounts();
      await selectAntigravityAccount(res.account.id);
      resetForm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-edge bg-surface-muted/60 px-3 py-2 text-xs text-content outline-none transition-colors focus:border-accent";

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-edge bg-surface p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-content">{t("chat.agyAccount.dialogTitle")}</h3>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-content-subtle hover:bg-surface-hover hover:text-content"
          >
            <IconX size={15} />
          </button>
        </div>

        <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg bg-surface-muted p-1 text-xs">
          {(
            [
              ["gemini-api-key", "chat.agyAccount.tabApiKey"],
              ["oauth-personal", "chat.agyAccount.tabGoogle"],
              ["agent-platform", "chat.agyAccount.tabGcp"],
            ] as const
          ).map(([key, labelKey]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setTab(key);
                setError(null);
              }}
              className={cn(
                "truncate rounded-md px-2 py-1.5 font-medium transition-colors",
                tab === key
                  ? "bg-surface text-content shadow-sm"
                  : "text-content-muted hover:text-content",
              )}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-content-muted">
              {t("chat.agyAccount.nameLabel")}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("chat.agyAccount.namePlaceholder")}
              className={inputCls}
              required
              autoFocus
            />
          </div>

          {tab === "gemini-api-key" && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-content-muted">
                  {t("chat.agyAccount.apiKeyLabel")}
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={t("chat.agyAccount.apiKeyPlaceholder")}
                  className={inputCls}
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-content-muted">
                  {t("chat.agyAccount.baseUrlLabel")}
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={t("chat.agyAccount.baseUrlPlaceholder")}
                  className={inputCls}
                />
              </div>
            </>
          )}

          {tab === "oauth-personal" && (
            <p className="rounded-lg border border-edge/80 bg-surface-muted/40 p-2.5 text-xs leading-relaxed text-content-muted">
              {t("chat.agyAccount.googleTip")}
            </p>
          )}

          {tab === "agent-platform" && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-content-muted">
                  {t("chat.agyAccount.gcpProjectLabel")}
                </label>
                <input
                  type="text"
                  value={gcpProject}
                  onChange={(e) => setGcpProject(e.target.value)}
                  placeholder={t("chat.agyAccount.gcpProjectPlaceholder")}
                  className={inputCls}
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-content-muted">
                  {t("chat.agyAccount.gcpLocationLabel")}
                </label>
                <input
                  type="text"
                  value={gcpLocation}
                  onChange={(e) => setGcpLocation(e.target.value)}
                  placeholder={t("chat.agyAccount.gcpLocationPlaceholder")}
                  className={inputCls}
                />
              </div>
            </>
          )}

          {error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-edge px-3 py-1.5 text-xs text-content-muted hover:bg-surface-hover hover:text-content"
            >
              {t("chat.agyAccount.cancel")}
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-surface transition-opacity hover:brightness-110 disabled:opacity-50"
            >
              {saving
                ? t("chat.agyAccount.saving")
                : tab === "oauth-personal"
                  ? t("chat.agyAccount.captureAndSwitch")
                  : t("chat.agyAccount.saveAndSwitch")}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
