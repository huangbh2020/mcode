import { useCallback, useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { Button } from "@renderer/components/ui/button.js";
import { Input } from "@renderer/components/ui/input.js";
import { Dialog } from "@renderer/components/ui/index.js";
import { IconKey, IconTrash, IconUser, IconWorldWww } from "@renderer/lib/icons.js";
import type { BrowserCredentialPublic } from "@contracts/ipc";

/**
 * Manual credential vault for the embedded browser — manage per-origin
 * username/password entries (Basic Auth auto-fill + one-click login-form
 * fill). Passwords live encrypted in main (safeStorage) and are never
 * returned to the renderer; the form here only sends what the user types.
 *
 * The dialog is renderer DOM; the caller (BrowserPanel) hides the OS-level
 * WebContentsView while it's open so it stays clickable.
 */
export function CredentialDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [credentials, setCredentials] = useState<BrowserCredentialPublic[]>([]);
  const [origin, setOrigin] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingOrigin, setEditingOrigin] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await api.browser.credentialsList({});
    setCredentials(res.credentials);
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const resetForm = () => {
    setOrigin("");
    setUsername("");
    setPassword("");
    setEditingOrigin(null);
    setError(null);
  };

  const handleSubmit = async () => {
    const normalizedOrigin = normalizeOrigin(origin);
    if (!normalizedOrigin) {
      setError("请输入有效的站点 origin（如 https://example.com）");
      return;
    }
    if (!username.trim()) {
      setError("用户名不能为空");
      return;
    }
    const res = await api.browser.credentialsSave({
      origin: normalizedOrigin,
      username: username.trim(),
      password,
    });
    setCredentials(res.credentials);
    resetForm();
  };

  const handleRemove = async (target: string) => {
    const res = await api.browser.credentialsRemove({ origin: target });
    setCredentials(res.credentials);
    if (editingOrigin === target) resetForm();
  };

  const handleEdit = (c: BrowserCredentialPublic) => {
    setEditingOrigin(c.origin);
    setOrigin(c.origin);
    setUsername(c.username);
    setPassword("");
    setError(null);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) resetForm(); onOpenChange(o); }}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[440px] max-w-[90vw] p-4">
          <div className="mb-3 flex items-center gap-2">
            <IconKey size={16} className="text-accent" />
            <Dialog.Title className="text-sm font-semibold text-content">
              浏览器密码库
            </Dialog.Title>
          </div>
          <Dialog.Description className="mb-3 text-xs leading-relaxed text-content-muted">
            按站点保存账号密码（OS 钥匙串加密存储）。HTTP Basic Auth 弹窗会自动使用；工具栏钥匙菜单可一键填充到当前页登录表单。
          </Dialog.Description>

          {/* Saved list */}
          <div className="mb-3 max-h-52 space-y-1 overflow-y-auto">
            {credentials.length === 0 && (
              <p className="py-4 text-center text-xs text-content-subtle">暂无保存的凭证</p>
            )}
            {credentials.map((c) => (
              <div
                key={c.origin}
                className={cn(
                  "flex items-center gap-2 rounded border border-edge bg-surface-muted px-2.5 py-1.5",
                  editingOrigin === c.origin && "border-accent",
                )}
              >
                <IconWorldWww size={14} className="shrink-0 text-content-subtle" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-content">{c.origin}</div>
                  <div className="flex items-center gap-1 text-[11px] text-content-muted">
                    <IconUser size={11} />
                    {c.username}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleEdit(c)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-content-muted hover:bg-surface-hover hover:text-content"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => void handleRemove(c.origin)}
                  title="删除"
                  className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-danger"
                >
                  <IconTrash size={13} />
                </button>
              </div>
            ))}
          </div>

          {/* Add / edit form */}
          <div className="space-y-2 rounded border border-edge bg-surface-muted p-2.5">
            <p className="text-[11px] font-medium text-content-muted">
              {editingOrigin ? `编辑 ${editingOrigin}` : "新增凭证"}
            </p>
            <Input
              placeholder="https://example.com"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              disabled={editingOrigin != null}
              spellCheck={false}
            />
            <Input
              placeholder="用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              spellCheck={false}
            />
            <Input
              type="password"
              placeholder={editingOrigin ? "密码（留空 = 不修改）" : "密码"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              spellCheck={false}
            />
            {error && <p className="text-[11px] text-danger">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              {editingOrigin && (
                <Button variant="ghost" size="sm" onClick={resetForm}>
                  取消编辑
                </Button>
              )}
              <Button size="sm" onClick={() => void handleSubmit()}>
                保存
              </Button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Tolerant origin normalizer: add https:// when the scheme is missing, then
 *  keep scheme://host[:port] only (path/query dropped). Empty when invalid. */
function normalizeOrigin(input: string): string {
  const s = input.trim();
  if (!s) return "";
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).origin;
  } catch {
    return "";
  }
}
