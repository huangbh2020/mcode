import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import { BROWSER_SCREENSHOT_DIR_SETTING_KEY } from "@contracts/ipc";

/**
 * Browser settings — screenshot storage directory.
 *
 * The agent's browser_screenshot tool saves every captured PNG under the
 * configured directory, organized as `<dir>/<sessionId>/turn-<N>/`. When the
 * setting is empty the system Pictures directory is used instead. Bound
 * directly to the `browser.screenshotDir` setting key (main-process
 * screenshot saver reads it on every save — no store field / no new IPC),
 * following the same pattern as the terminal shell setting.
 */
export function BrowserPanel() {
  return (
    <section className="space-y-4">
      <PanelHeader
        title="浏览器"
        desc="配置应用内浏览器的行为。当前支持设置 agent 截图的存放目录。"
      />
      <ScreenshotDirSection />
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
