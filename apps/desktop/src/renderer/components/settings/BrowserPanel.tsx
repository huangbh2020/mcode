import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
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
  return (
    <section className="space-y-4">
      <PanelHeader
        title="浏览器"
        desc="配置应用内浏览器的行为：截图存放目录、浏览器数据目录，以及清理缓存数据。"
      />
      <ScreenshotDirSection />
      <DataDirSection />
      <CacheSection />
    </section>
  );
}

function ScreenshotDirSection() {
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
    <SettingsSection
      title="截图存放目录"
      desc="agent 使用浏览器截图工具(browser_screenshot)时,截取的图片会保存到该目录,并按会话和对话轮次分子目录:截图目录/会话ID/turn-轮次/。留空则保存到系统图片目录。"
    >
      <SettingRow
        layout="vertical"
        title="截图目录"
        desc="选择或输入一个文件夹路径。留空时使用系统图片目录。"
      >
        <div className="flex gap-2">
          <Input
            value={dir}
            onChange={(e) => {
              setDir((e.target as HTMLInputElement).value);
              setSaved(false);
            }}
            placeholder="留空使用系统图片目录"
            spellCheck={false}
            disabled={!loaded}
            className="min-w-0 flex-1 font-mono"
          />
          <Button variant="secondary" size="sm" onClick={() => void pickDir()} disabled={!loaded}>
            选择目录…
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={saving || !loaded}
          >
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
        {saved && (
          <p className="mt-1 text-[0.7857em] text-accent">已保存。后续浏览器截图将保存到此目录。</p>
        )}
      </SettingRow>
    </SettingsSection>
  );
}

/** Browser session data directory (cookies / form & login records / local
 *  storage / IndexedDB …). Mirrors ScreenshotDirSection; the main process
 *  reads `browser.dataDir` when creating the browser session partition. */
function DataDirSection() {
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
    <SettingsSection
      title="浏览器数据目录"
      desc="浏览器会话数据(Cookie、表单/登录记录、本地存储、IndexedDB 等)实时写入该目录。留空使用应用默认位置。更改后需重启应用才生效。"
    >
      <SettingRow
        layout="vertical"
        title="数据目录"
        desc="选择或输入一个文件夹路径。留空时使用应用默认位置。"
      >
        <div className="flex gap-2">
          <Input
            value={dir}
            onChange={(e) => {
              setDir((e.target as HTMLInputElement).value);
              setSaved(false);
            }}
            placeholder="留空使用默认位置"
            spellCheck={false}
            disabled={!loaded}
            className="min-w-0 flex-1 font-mono"
          />
          <Button variant="secondary" size="sm" onClick={() => void pickDir()} disabled={!loaded}>
            选择目录…
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={saving || !loaded}
          >
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
        {saved && (
          <p className="mt-1 text-[0.7857em] text-accent">
            已保存。重启应用后浏览器数据将保存到新目录。
          </p>
        )}
      </SettingRow>
    </SettingsSection>
  );
}

/** Clear the browser's HTTP cache + temporary site storage. A danger button
 *  guarded by a ConfirmDialog; cookies & login state are kept, so the user
 *  stays signed in. */
function CacheSection() {
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
      title="缓存数据"
      desc="清理浏览器缓存与临时站点数据。Cookie 与登录状态会被保留,不需要重新登录网站。"
    >
      <SettingRow
        layout="horizontal"
        title="清除缓存数据"
        desc="清除 HTTP 缓存以及 localStorage / IndexedDB 等临时站点数据,释放磁盘空间。"
      >
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmOpen(true)}
          >
            {busy ? "清理中…" : "清除缓存数据"}
          </Button>
          {result === "ok" && (
            <span className="text-[0.7857em] text-accent">已清除,登录状态已保留。</span>
          )}
          {result === "error" && (
            <span className="text-[0.7857em] text-danger">清理失败,请查看主进程日志。</span>
          )}
        </div>
      </SettingRow>
      <ConfirmDialog
        open={confirmOpen}
        title="清除浏览器缓存数据"
        description={
          <>
            将清除 HTTP 缓存和临时站点数据(localStorage、IndexedDB 等)。
            <span className="font-medium">Cookie 与登录状态会保留</span>,已登录的网站不需要重新登录。确定继续吗?
          </>
        }
        confirmText="清除"
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
