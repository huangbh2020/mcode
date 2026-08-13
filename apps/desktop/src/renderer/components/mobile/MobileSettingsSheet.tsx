/**
 * MobileSettingsSheet — the minimal settings surface of the web (phone) shell.
 *
 * The desktop SettingsPage (language servers, models, shortcuts, …) is
 * Electron-bound; the phone gets the essentials instead: theme, the server it
 * is paired with, and unpairing. Rendered as a bottom sheet over the chat.
 */
import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { applyThemeClass } from "@renderer/lib/theme.js";
import { clearAuth } from "@renderer/lib/webApi.js";
import type { ThemeName } from "@contracts/theme";
import { IconX, IconSun, IconMoon, IconDeviceDesktop, IconUnlink, IconLink } from "@renderer/lib/icons.js";

const THEME_OPTIONS: Array<{ value: ThemeName; label: string; icon: typeof IconSun }> = [
  { value: "system", label: "跟随系统", icon: IconDeviceDesktop },
  { value: "light", label: "浅色", icon: IconSun },
  { value: "dark", label: "深色", icon: IconMoon },
];

export function MobileSettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [theme, setTheme] = useState<ThemeName>("system");
  const [unpairConfirm, setUnpairConfirm] = useState(false);

  useEffect(() => {
    if (!open) return;
    void api.theme.get().then((s) => setTheme(s.theme)).catch(() => {
      // ignore — keep the default
    });
  }, [open]);

  if (!open) return null;

  const pickTheme = (next: ThemeName) => {
    setTheme(next);
    void api.theme.set({ theme: next }).then((s) => {
      applyThemeClass(s.effective);
    });
  };

  const unpair = () => {
    clearAuth();
    // Back to the pairing gate (full reload keeps the module state clean).
    window.location.reload();
  };

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop — tap to dismiss. */}
      <button
        type="button"
        aria-label="关闭设置"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-4 rounded-t-2xl border-t border-edge bg-surface p-4 pb-6 text-content">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">设置</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-content-muted hover:bg-surface-muted"
          >
            <IconX size={16} />
          </button>
        </div>

        {/* Theme */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-content-muted">外观</span>
          <div className="grid grid-cols-3 gap-2">
            {THEME_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = theme === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => pickTheme(opt.value)}
                  className={cn(
                    "flex h-16 flex-col items-center justify-center gap-1 rounded-xl border text-xs",
                    active
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-edge bg-surface-muted/50 text-content-muted hover:bg-surface-muted",
                  )}
                >
                  <Icon size={18} />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Server */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-content-muted">连接</span>
          <div className="flex items-center gap-2 rounded-xl border border-edge bg-surface-muted/50 px-3 py-2.5 text-xs text-content-muted">
            <IconLink size={14} className="shrink-0" />
            <span className="truncate">已连接至 {window.location.origin || "未知服务器"}</span>
          </div>
          {unpairConfirm ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={unpair}
                className="flex h-8 flex-1 items-center justify-center rounded-lg bg-danger px-3 text-xs font-medium text-surface"
              >
                确认解除配对
              </button>
              <button
                type="button"
                onClick={() => setUnpairConfirm(false)}
                className="flex h-8 flex-1 items-center justify-center rounded-lg border border-edge px-3 text-xs text-content-muted"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setUnpairConfirm(true)}
              className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-edge px-3 text-xs text-danger hover:bg-surface-muted"
            >
              <IconUnlink size={14} />
              解除与这台电脑的配对
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
