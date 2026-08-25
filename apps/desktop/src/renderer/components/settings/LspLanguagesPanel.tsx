/**
 * Language servers (LSP) settings panel.
 *
 * Lists the four supported languages (TypeScript/JS, Python, Go, Java) as
 * cards. Each card shows install/running status and offers:
 *  - An enable toggle (starts/stops the server)
 *  - Install / reinstall button (spawns the package manager; logs stream in)
 *  - Health-check button (probes the binary)
 *  - Uninstall button
 *  - An "advanced" section for a custom server path + args override
 *
 * State is driven by `lspLanguages` in the session store (hydrated from
 * `api.lsp.list`). Every mutation calls the `api.lsp.*` RPC then
 * `reloadLspLanguages()` to refresh. Install progress is polled by
 * re-listing every second while `installing` is true on any language.
 */
import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, Switch } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import type { LspLanguageId, LspLanguageState } from "@contracts/ipc";
import {
  IconLanguage,
  IconCheck,
  IconX,
  IconRefresh,
  IconLoader2,
  IconAlertTriangle,
  IconPlayerStop,
  IconStethoscope,
  IconChevronDown,
  IconChevronRight,
  IconTrash,
  IconDownload,
  IconFileImport,
} from "@renderer/lib/icons.js";

/** Display metadata per language id (icon + label + download fallback info).
 *  downloadUrl is opened in the browser when the package-manager install
 *  fails; downloadHintKey translates what the user should look for. Labels
 *  are proper nouns and stay untranslated; `hint` is technical text except
 *  for Java, which carries a `hintKey`. */
const LANG_META: Record<
  LspLanguageId,
  { label: string; hint: string; hintKey?: MessageId; downloadUrl: string; downloadHintKey: MessageId }
> = {
  typescript: {
    label: "TypeScript / JavaScript",
    hint: "typescript-language-server(npm)",
    downloadUrl: "https://github.com/typescript-language-server/typescript-language-server/releases",
    downloadHintKey: "settings.lsp.dlHintTs",
  },
  python: {
    label: "Python",
    hint: "basedpyright(pip)",
    downloadUrl: "https://github.com/DetachHead/basedpyright/releases",
    downloadHintKey: "settings.lsp.dlHintPy",
  },
  go: {
    label: "Go",
    hint: "gopls(go install)",
    downloadUrl: "https://github.com/golang/tools/releases",
    downloadHintKey: "settings.lsp.dlHintGo",
  },
  java: {
    label: "Java",
    hint: "jdtls(自动匹配 JDK 版本)",
    hintKey: "settings.lsp.hintJava",
    downloadUrl: "https://download.eclipse.org/jdtls/milestones/",
    downloadHintKey: "settings.lsp.dlHintJava",
  },
};

export function LspLanguagesPanel() {
  const { t } = useI18n();
  const lspLanguages = useSessionStore((s) => s.lspLanguages);
  const reloadLspLanguages = useSessionStore((s) => s.reloadLspLanguages);

  // Poll for install progress while any language is installing.
  useEffect(() => {
    const anyInstalling = lspLanguages.some((l) => l.installing);
    if (!anyInstalling) return;
    const t = setInterval(() => void reloadLspLanguages(), 1000);
    return () => clearInterval(t);
  }, [lspLanguages, reloadLspLanguages]);

  // Subscribe to lsp:event stateChanged so the panel refreshes immediately when
  // a server crashes (lastError is set server-side). Without this the user
  // wouldn't see the error until they manually navigate away and back.
  useEffect(() => {
    const unsub = api.on.lspEvent((msg) => {
      if (msg.type === "stateChanged") void reloadLspLanguages();
    });
    return unsub;
  }, [reloadLspLanguages]);

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader
        title={t("settings.lsp.title")}
        icon={IconLanguage}
      />

      <SettingsSection title={t("settings.lsp.section")}>
        {lspLanguages.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-4 py-8 text-[0.85em] text-content-subtle">
            <IconLoader2 size={14} className="animate-spin" />
            {t("settings.lsp.loading")}
          </div>
        ) : (
          lspLanguages.map((lang) => (
            <LanguageCard key={lang.language} state={lang} onReload={reloadLspLanguages} />
          ))
        )}
      </SettingsSection>
    </section>
  );
}

/* ───────────────────────── language card ───────────────────────── */

function LanguageCard({
  state,
  onReload,
}: {
  state: LspLanguageState;
  onReload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const meta = LANG_META[state.language];
  const [installing, setInstalling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [healthResult, setHealthResult] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showLog, setShowLog] = useState(false);
  // Local edits for the advanced path/args fields (synced from state on toggle).
  const [pathInput, setPathInput] = useState("");
  const [argsInput, setArgsInput] = useState("");
  const [javaHomeInput, setJavaHomeInput] = useState("");
  const [savingPath, setSavingPath] = useState(false);

  const doInstall = async () => {
    setInstalling(true);
    setHealthResult(null);
    try {
      const res = await api.lsp.install({ language: state.language });
      if (!res.ok)
        setHealthResult(
          t("settings.lsp.installFailed", { error: res.error ?? t("settings.unknownError") }),
        );
      await onReload();
    } finally {
      setInstalling(false);
    }
  };

  const doUninstall = async () => {
    if (!confirm(t("settings.lsp.uninstallConfirm", { name: meta.label }))) return;
    setInstalling(true);
    try {
      const res = await api.lsp.uninstall({ language: state.language });
      if (!res.ok)
        setHealthResult(
          t("settings.lsp.uninstallFailed", { error: res.error ?? t("settings.unknownError") }),
        );
      await onReload();
    } finally {
      setInstalling(false);
    }
  };

  const doHealthCheck = async () => {
    setChecking(true);
    setHealthResult(null);
    try {
      const res = await api.lsp.healthCheck({ language: state.language });
      setHealthResult(res.ok ? t("settings.lsp.healthOk") : `✗ ${res.error ?? t("settings.lsp.checkFailed")}`);
    } finally {
      setChecking(false);
    }
  };

  const doToggle = async (enabled: boolean) => {
    await api.lsp.toggle({ language: state.language, enabled });
    await onReload();
  };

  /** Open the download page in the user's browser. Used as a fallback when
   *  the package-manager install fails due to network issues. */
  const doOpenDownloadPage = () => {
    window.open(meta.downloadUrl, "_blank", "noopener,noreferrer");
  };

  /** Let the user pick a manually-downloaded file (archive or binary) and
   *  install from it. For Java the tar.gz is extracted; for others the file
   *  is recorded as the custom server path. */
  const doInstallFromFile = async () => {
    const { paths } = await api.pickFiles({
      title: t("settings.lsp.pickFileTitle", { name: meta.label }),
    });
    if (paths.length === 0) return;
    setInstalling(true);
    setHealthResult(null);
    try {
      const res = await api.lsp.installFromFile({
        language: state.language,
        archivePath: paths[0],
      });
      if (!res.ok) {
        setHealthResult(
          t("settings.lsp.installFailed", { error: res.error ?? t("settings.unknownError") }),
        );
      }
      await onReload();
    } finally {
      setInstalling(false);
    }
  };

  const doSavePath = async () => {
    setSavingPath(true);
    try {
      const args = argsInput
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      await api.lsp.setPath({
        language: state.language,
        serverPath: pathInput.trim() || undefined,
        args: args.length > 0 ? args : undefined,
        javaHome: javaHomeInput.trim() || undefined,
      });
      await onReload();
      setShowAdvanced(false);
    } finally {
      setSavingPath(false);
    }
  };

  // Sync the advanced inputs when the section opens.
  const toggleAdvanced = () => {
    if (!showAdvanced) {
      setPathInput(state.serverPath ?? "");
      setArgsInput("");
      setJavaHomeInput("");
    }
    setShowAdvanced(!showAdvanced);
  };

  const busy = installing || checking || state.installing;

  return (
    <div className="px-4 py-3">
      {/* Header row: label + toggle */}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-content">{meta.label}</span>
            <StatusBadge state={state} />
          </div>
          <div className="mt-0.5 text-[0.7857em] text-content-subtle">
            {meta.hintKey ? t(meta.hintKey) : meta.hint}
          </div>
        </div>
        <Switch checked={state.enabled} onCheckedChange={doToggle} label={state.enabled ? t("settings.on") : t("settings.off")} />      </div>

      {/* Resolved path */}
      {state.serverPath && (
        <div className="mt-2 truncate font-mono text-[0.7857em] text-content-muted" title={state.serverPath}>
          {state.serverPath}
        </div>
      )}

      {/* Java-specific version note: explains JDK/jdtls compatibility */}
      {state.language === "java" && (
        <div className="mt-2 rounded bg-surface-muted/40 px-2.5 py-1.5 text-[0.72em] leading-relaxed text-content-muted">
          <strong className="text-content">{t("settings.lsp.javaNoteTitle")}</strong>
          {t("settings.lsp.javaNoteDetect")}
          <br />
          • Java 21+ → jdtls 1.40.0　　• Java 17 → jdtls 1.37.0
          <br />
          {t("settings.lsp.javaNoteRuntimePre")}
          <span className="text-content">{t("settings.lsp.javaNoteNoImpact")}</span>。
          {t("settings.lsp.javaNoteJava8")}
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {!state.installed ? (
          <Button variant="primary" size="sm" onClick={doInstall} disabled={busy}>
            {installing || state.installing ? (
              <>
                <IconLoader2 size={12} className="animate-spin" />
                {t("settings.lsp.installing")}
              </>
            ) : (
              t("settings.lsp.install")
            )}
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={doInstall} disabled={busy}>
              {installing || state.installing ? (
                <>
                  <IconLoader2 size={12} className="animate-spin" />
                  {t("settings.lsp.reinstalling")}
                </>
              ) : (
                <>
                  <IconRefresh size={12} />
                  {t("settings.lsp.reinstall")}
                </>
              )}
            </Button>
            <Button variant="outline" size="sm" onClick={doHealthCheck} disabled={busy}>
              {checking ? (
                <IconLoader2 size={12} className="animate-spin" />
              ) : (
                <IconStethoscope size={12} />
              )}
              {t("settings.lsp.healthCheck")}
            </Button>
            <Button variant="outline" size="sm" onClick={doUninstall} disabled={busy}>
              <IconTrash size={12} />
              {t("settings.lsp.uninstall")}
            </Button>
            {state.running && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => doToggle(false)}
                title={t("settings.lsp.stopTitle")}
              >
                <IconPlayerStop size={12} />
                {t("settings.lsp.stop")}
              </Button>
            )}
          </>
        )}
        {/* Manual-download fallback: open the download page in a browser, then
            install from the user-downloaded file. Shown for every language
            regardless of install state, as a network-issue escape hatch. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={doOpenDownloadPage}
          title={t(meta.downloadHintKey)}
        >
          <IconDownload size={12} />
          {t("settings.lsp.openDownloadPage")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={doInstallFromFile}
          disabled={busy}
          title={t(meta.downloadHintKey)}
        >
          {installing ? (
            <IconLoader2 size={12} className="animate-spin" />
          ) : (
            <IconFileImport size={12} />
          )}
          {t("settings.lsp.installFromFile")}
        </Button>
        <button
          type="button"
          onClick={toggleAdvanced}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
        >
          {showAdvanced ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          {t("settings.lsp.advanced")}
        </button>
      </div>

      {/* Health check result */}
      {healthResult && (
        <div
          className={cn(
            "mt-2 flex items-center gap-1.5 rounded px-2 py-1 text-[0.7857em]",
            healthResult.startsWith("✓")
              ? "bg-accent/10 text-accent"
              : "bg-danger/10 text-danger",
          )}
        >
          {healthResult.startsWith("✓") ? (
            <IconCheck size={12} />
          ) : (
            <IconAlertTriangle size={12} />
          )}
          {healthResult}
        </div>
      )}

      {/* Server error (e.g. "jdtls requires at least Java 21") -- shown when
          the server failed to start, so the user knows the actual reason. */}
      {state.lastError && !state.running && (
        <div className="mt-2 flex items-start gap-1.5 rounded bg-danger/10 px-2 py-1.5 text-[0.7857em] text-danger">
          <IconAlertTriangle size={12} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{state.lastError}</span>
        </div>
      )}

      {/* Install log (collapsible) */}
      {state.installLog && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowLog(!showLog)}
            className="text-[0.7857em] text-content-subtle hover:text-content-muted"
          >
            {showLog ? t("settings.lsp.hideLog") : t("settings.lsp.showLog")}
          </button>
          {showLog && (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-surface-muted/40 p-2 font-mono text-[0.72em] text-content-muted whitespace-pre-wrap">
              {state.installLog}
            </pre>
          )}
        </div>
      )}

      {/* Advanced: custom path + args */}
      {showAdvanced && (
        <div className="mt-3 space-y-2 rounded border border-edge bg-surface-muted/30 p-3">
          <Field label={t("settings.lsp.serverPathLabel")}>
            <input
              className={inputCls}
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder={t("settings.lsp.serverPathPlaceholder")}
            />
          </Field>
          <Field label={t("settings.lsp.argsLabel")}>
            <input
              className={inputCls}
              value={argsInput}
              onChange={(e) => setArgsInput(e.target.value)}
              placeholder={t("settings.lsp.argsPlaceholder")}
            />
          </Field>
          {state.language === "java" && (
            <Field label={t("settings.lsp.javaHomeLabel")}>
              <input
                className={inputCls}
                value={javaHomeInput}
                onChange={(e) => setJavaHomeInput(e.target.value)}
                placeholder={t("settings.lsp.javaHomePlaceholder")}
              />
              <p className="mt-1 text-[0.72em] text-content-subtle">
                {t("settings.lsp.javaHomeNote")}
              </p>
            </Field>
          )}
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setShowAdvanced(false)} disabled={savingPath}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={doSavePath} disabled={savingPath}>
              {savingPath ? <IconLoader2 size={12} className="animate-spin" /> : t("common.save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── small components ───────────────────────── */

function StatusBadge({ state }: { state: LspLanguageState }) {
  const { t } = useI18n();
  if (state.installing) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-1.5 py-0.5 text-[0.72em] text-accent">
        <IconLoader2 size={9} className="animate-spin" />
        {t("settings.lsp.statusInstalling")}
      </span>
    );
  }
  if (state.running) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-1.5 py-0.5 text-[0.72em] text-accent">
        <IconCheck size={9} />
        {t("settings.lsp.statusRunning")}
      </span>
    );
  }
  if (state.installed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-surface-hover px-1.5 py-0.5 text-[0.72em] text-content-muted">
        {t("settings.lsp.statusInstalled")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-hover px-1.5 py-0.5 text-[0.72em] text-content-subtle">
      <IconX size={9} />
      {t("settings.lsp.statusNotInstalled")}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[0.7857em] font-medium text-content-muted">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "min-w-0 flex-1 w-full rounded border border-edge bg-surface px-2 py-1 font-mono text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";
