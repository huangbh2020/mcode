/**
 * OpenCode (v2) settings panel — the official-login surface.
 *
 * OpenCode has NO third-party endpoint config (by design): credentials live
 * in opencode's own store (SQLite, shared with the user's terminal CLI), and
 * the model list comes from the official server. This panel therefore shows:
 *   - CLI health (installed / version, with an npm install hint when absent);
 *   - connected integrations with per-credential logout;
 *   - the Zen API-key connect form (key from opencode.ai/auth — the
 *     credential lands in opencode's store, not Mcode's);
 *   - a model-list preview (Zen free models appear even without login).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import { OpenCodeBrandIcon } from "@renderer/lib/opencodeBrandIcon.js";
import { IconRefresh, IconExternalLink, IconLogout } from "@tabler/icons-react";
import type { OpenCodeIntegrationStatus } from "@contracts/ipc";

const ZEN_AUTH_URL = "https://opencode.ai/auth";

/** Zen is the official integration; other key-based integrations the server
 *  reports are selectable too (their keys come from each vendor's console). */
const ZEN_INTEGRATION_ID = "opencode";

export function OpenCodeLoginPanel() {
  const { t } = useI18n();
  const reloadOpencodeAvailableModels = useSessionStore(
    (s) => s.reloadOpencodeAvailableModels,
  );
  const opencodeAvailableModels = useSessionStore((s) => s.opencodeAvailableModels);

  const [installed, setInstalled] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string | undefined>();
  const [integrations, setIntegrations] = useState<OpenCodeIntegrationStatus[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [integrationId, setIntegrationId] = useState<string>(ZEN_INTEGRATION_ID);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const status = await api.opencode.authStatus();
      setInstalled(status.installed);
      setVersion(status.version);
      setIntegrations(status.integrations);
      setLoadError(status.error ?? null);
      // Refresh the composer's model list in the same pass — login/logout
      // changes what the server reports.
      void reloadOpencodeAvailableModels();
    } catch (err) {
      setInstalled(false);
      setLoadError((err as Error).message);
    }
  }, [reloadOpencodeAvailableModels]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connected = useMemo(
    () => integrations.filter((i) => i.connected),
    [integrations],
  );
  /** Key-based integrations offered in the connect form (Zen first). */
  const connectable = useMemo(() => {
    const keyBased = integrations.filter((i) =>
      i.methods.some((m) => m.type === "key"),
    );
    return keyBased.sort((a, b) =>
      a.id === ZEN_INTEGRATION_ID ? -1 : b.id === ZEN_INTEGRATION_ID ? 1 : a.name.localeCompare(b.name),
    );
  }, [integrations]);

  const connect = async () => {
    const key = apiKey.trim();
    if (!key) {
      setNotice({ ok: false, text: t("settings.opencode.errKeyRequired") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.opencode.connectKey({ integrationId, key });
      if (r.ok) {
        setApiKey("");
        setNotice({ ok: true, text: t("settings.opencode.connectOk") });
        await refresh();
      } else {
        setNotice({ ok: false, text: r.error ?? t("settings.unknownError") });
      }
    } catch (err) {
      setNotice({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const logout = async (credentialId: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.opencode.logout({ credentialId });
      if (!r.ok) setNotice({ ok: false, text: r.error ?? t("settings.unknownError") });
      await refresh();
    } catch (err) {
      setNotice({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      {/* CLI health */}
      <section className="rounded-md border border-edge bg-surface/40 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <OpenCodeBrandIcon size={16} className="shrink-0 text-content" />
            <span className="truncate text-[0.8571em] font-medium text-content">
              OpenCode{version ? ` · v${version.replace(/^opencode\s+v?/i, "")}` : ""}
            </span>
            {installed === false && (
              <span className="shrink-0 rounded bg-danger/15 px-1.5 py-0.5 text-[0.7143em] text-danger">
                {t("settings.opencode.notInstalled")}
              </span>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} className="shrink-0 gap-1">
            <IconRefresh size={13} />
            {t("settings.opencode.refresh")}
          </Button>
        </div>
        {installed === false && (
          <div className="mt-2 rounded border border-edge bg-surface-muted/40 p-2 font-mono text-[0.7143em] leading-relaxed text-content-muted">
            npm install -g @opencode/cli
          </div>
        )}
        {loadError && (
          <div className="mt-2 text-[0.7143em] text-warning">{loadError}</div>
        )}
      </section>

      {/* Connected integrations */}
      <section className="rounded-md border border-edge bg-surface/40 p-3">
        <div className="mb-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
          {t("settings.opencode.connected")}
        </div>
        {connected.length === 0 ? (
          <div className="px-1 py-2 text-[0.7857em] leading-relaxed text-content-subtle">
            {t("settings.opencode.noneConnected")}
          </div>
        ) : (
          <div className="space-y-1.5">
            {connected.map((i) => (
              <div
                key={i.id}
                className="flex items-center justify-between gap-3 rounded border border-edge bg-surface/60 px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-[0.7857em] font-medium text-content">{i.name}</div>
                  <div className="text-[0.7143em] text-content-subtle">
                    {t("settings.opencode.credentialCount", { n: i.credentialIds.length })}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  {i.credentialIds.map((cid) => (
                    <Button
                      key={cid}
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void logout(cid)}
                      className="gap-1 text-danger"
                      title={cid}
                    >
                      <IconLogout size={12} />
                      {t("settings.opencode.logout")}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* API-key connect */}
      <section className="rounded-md border border-edge bg-surface/40 p-3">
        <div className="mb-2 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
          {t("settings.opencode.connectTitle")}
        </div>
        <p className="mb-2.5 text-[0.7857em] leading-relaxed text-content-muted">
          {t("settings.opencode.connectHint")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {connectable.length > 1 ? (
            <select
              value={integrationId}
              onChange={(e) => setIntegrationId(e.target.value)}
              className="h-8 w-44 rounded-md border border-edge bg-surface px-2 text-[0.7857em] text-content outline-none"
            >
              {connectable.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[0.7857em] font-medium text-content">OpenCode Zen</span>
          )}
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("settings.opencode.keyPlaceholder")}
            className="min-w-[220px] flex-1"
            autoComplete="off"
          />
          <Button variant="outline" size="sm" onClick={() => window.open(ZEN_AUTH_URL, "_blank", "noopener,noreferrer")} className="gap-1">
            <IconExternalLink size={13} />
            {t("settings.opencode.getKey")}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void connect()}>
            {t("settings.opencode.connect")}
          </Button>
        </div>
        {notice && (
          <div className={`mt-2 text-[0.7143em] ${notice.ok ? "text-success" : "text-danger"}`}>
            {notice.text}
          </div>
        )}
      </section>

      {/* Model preview */}
      <section className="rounded-md border border-edge bg-surface/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
            {t("settings.opencode.models")}
          </span>
          <span className="text-[0.7143em] text-content-subtle">{opencodeAvailableModels.length}</span>
        </div>
        {opencodeAvailableModels.length === 0 ? (
          <div className="px-1 py-2 text-[0.7857em] text-content-subtle">
            {t("settings.opencode.noModels")}
          </div>
        ) : (
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {opencodeAvailableModels.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-2 px-1 py-0.5">
                <span className="min-w-0 truncate text-[0.7857em] text-content">{m.label}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {m.free && (
                    <span className="rounded bg-success/15 px-1 text-[0.7143em] text-success">
                      {t("chat.model.free")}
                    </span>
                  )}
                  {m.hint && (
                    <span className="rounded bg-accent/15 px-1 text-[0.7143em] text-accent">{m.hint}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
