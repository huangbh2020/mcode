import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ConfirmDialog, Input } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import {
  BROWSER_DATA_DIR_SETTING_KEY,
  BROWSER_SCREENSHOT_DIR_SETTING_KEY,
} from "@contracts/ipc";

/**
 * Browser settings — screenshot directory, browser data directory, cache.
 *
 * - Screenshot dir: where the agent's browser_screenshot tool saves PNGs
 *   (bound to `browser.screenshotDir`, read by the main-process saver on every
 *   save — no store field / no new IPC).
 * - Data dir: where the embedded browser's session data (cookies, form/login
 *   records, localStorage, IndexedDB …) lives. Bound to `browser.dataDir`; the
 *   main process reads it when creating the browser session. Electron caches
 *   Session objects by partition string, so a change only takes effect after
 *   an app restart — the UI says so.
 * - Cache: clears HTTP cache + temporary site storage via `api.browser.clearCache`
 *   (a dedicated IPC into main). Cookies/login state are preserved.
 */
export function BrowserPanel() {
  const { t } = useI18n();
  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader title={t("settings.browser.title")} />

      {/* 存储位置 — 截图目录与数据目录合并为一张卡(两行) */}
      <SettingsSection title={t("settings.browser.sectionStorage")}>
        <ScreenshotDirRow />
        <DataDirRow />
      </SettingsSection>

      <CacheSection />
    </section>
  );
}

function ScreenshotDirRow() {
  const { t } = useI18n();
  const [dir, setDir] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Load the current setting on mount (panel is freshly mounted per nav
  // switch, so reload its value each time it's shown).
  useEffect(() => {
    setSaved(false);
    void (async () => {
      const { value } = await api.setting.get({ key: BROWSER_SCREENSHOT_DIR_SETTING_KEY });
      setDir(value ?? "");
      setLoaded(true);
    })();
  }, []);

  const pickDir = async () => {
    const { path } = await api.pickFolder();
    if (path) {
      setDir(path);
      setSaved(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.setting.set({ key: BROWSER_SCREENSHOT_DIR_SETTING_KEY, value: dir.trim() });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      layout="vertical"
      title={t("settings.browser.screenshotDir")}
      desc={t("settings.browser.screenshotDirDesc")}
    >
      <div className="flex gap-2">
        <Input
          value={dir}
          onChange={(e) => {
            setDir((e.target as HTMLInputElement).value);
            setSaved(false);
          }}
          placeholder={t("settings.browser.screenshotPlaceholder")}
          spellCheck={false}
          disabled={!loaded}
          className="min-w-0 flex-1 font-mono"
        />
        <Button variant="secondary" size="sm" onClick={() => void pickDir()} disabled={!loaded}>
          {t("settings.browser.chooseDir")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={saving || !loaded}
        >
          {saving ? t("settings.saving") : t("common.save")}
        </Button>
      </div>
      {saved && (
        <p className="mt-1 text-[0.7857em] text-accent">{t("settings.browser.savedScreenshot")}</p>
      )}
    </SettingRow>
  );
}

/** Browser session data directory (cookies / form & login records / local
 *  storage / IndexedDB …). Mirrors ScreenshotDirRow; the main process
 *  reads `browser.dataDir` when creating the browser session partition. */
function DataDirRow() {
  const { t } = useI18n();
  const [dir, setDir] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSaved(false);
    void (async () => {
      const { value } = await api.setting.get({ key: BROWSER_DATA_DIR_SETTING_KEY });
      setDir(value ?? "");
      setLoaded(true);
    })();
  }, []);

  const pickDir = async () => {
    const { path } = await api.pickFolder();
    if (path) {
      setDir(path);
      setSaved(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.setting.set({ key: BROWSER_DATA_DIR_SETTING_KEY, value: dir.trim() });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      layout="vertical"
      title={t("settings.browser.dataDir")}
      desc={t("settings.browser.dataDirDesc")}
    >
      <div className="flex gap-2">
        <Input
          value={dir}
          onChange={(e) => {
            setDir((e.target as HTMLInputElement).value);
            setSaved(false);
          }}
          placeholder={t("settings.browser.dataDirPlaceholder")}
          spellCheck={false}
          disabled={!loaded}
          className="min-w-0 flex-1 font-mono"
        />
        <Button variant="secondary" size="sm" onClick={() => void pickDir()} disabled={!loaded}>
          {t("settings.browser.chooseDir")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={saving || !loaded}
        >
          {saving ? t("settings.saving") : t("common.save")}
        </Button>
      </div>
      {saved && (
        <p className="mt-1 text-[0.7857em] text-accent">
          {t("settings.browser.savedDataDir")}
        </p>
      )}
    </SettingRow>
  );
}

/** Clear the browser's HTTP cache + temporary site storage. A danger button
 *  guarded by a ConfirmDialog; cookies & login state are kept, so the user
 *  stays signed in. */
function CacheSection() {
  const { t } = useI18n();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"ok" | "error" | null>(null);

  const clear = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.browser.clearCache();
      setResult(res.ok ? "ok" : "error");
    } catch {
      setResult("error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title={t("settings.browser.sectionCache")}
      desc={t("settings.browser.cacheSectionDesc")}
    >
      <SettingRow
        layout="horizontal"
        title={t("settings.browser.clearCache")}
        desc={t("settings.browser.clearCacheDesc")}
      >
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmOpen(true)}
          >
            {busy ? t("settings.browser.clearing") : t("settings.browser.clearCache")}
          </Button>
          {result === "ok" && (
            <span className="text-[0.7857em] text-accent">{t("settings.browser.clearOk")}</span>
          )}
          {result === "error" && (
            <span className="text-[0.7857em] text-danger">{t("settings.browser.clearFailed")}</span>
          )}
        </div>
      </SettingRow>
      <ConfirmDialog
        open={confirmOpen}
        title={t("settings.browser.clearConfirmTitle")}
        description={
          <>
            {t("settings.browser.clearConfirmDesc1")}
            <span className="font-medium">{t("settings.browser.clearConfirmKeep")}</span>
            {t("settings.browser.clearConfirmDesc2")}
          </>
        }
        confirmText={t("settings.browser.clear")}
        danger
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false);
        }}
        onConfirm={() => {
          void clear();
        }}
      />
    </SettingsSection>
  );
}
