import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { WORKTREE_ROOT_SETTING_KEY } from "@contracts/ipc";
import { Button } from "@renderer/components/ui/index.js";
import { IconFolder, IconLoader2 } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * "Worktree root directory" setting — where isolated-session worktrees are
 * created. Defaults to <userData>/worktrees (system drive); users can point
 * it anywhere (e.g. another drive close to their projects). The value is
 * read fresh on every worktree creation in main, so this only affects
 * FUTURE worktrees — sessions already materialized keep their recorded
 * path.
 */
export function WorktreeRootSetting() {
  const { t } = useI18n();
  const [root, setRoot] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.setting
      .get({ key: WORKTREE_ROOT_SETTING_KEY })
      .then((res) => setRoot(res.value || null))
      .catch(() => setRoot(null))
      .finally(() => setLoaded(true));
  }, []);

  const save = async (value: string | null) => {
    setBusy(true);
    try {
      await api.setting.set({ key: WORKTREE_ROOT_SETTING_KEY, value: value ?? "" });
      setRoot(value);
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    if (busy) return;
    const { path } = await api.pickFolder();
    if (path) await save(path);
  };

  if (!loaded) {
    return (
      <div className="flex items-center gap-1.5 py-2 text-xs text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div
        className="flex min-w-0 items-center gap-1.5 rounded-md border border-edge bg-surface-muted px-2.5 py-1.5 font-mono text-xs text-content"
        title={root ?? undefined}
      >
        <IconFolder size={12} className="shrink-0 text-content-subtle" />
        <span className="truncate">
          {root ?? t("settings.git.worktreeRootDefault")}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={browse} disabled={busy}>
          <IconFolder size={12} />
          {t("settings.git.worktreeRootBrowse")}
        </Button>
        {root && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void save(null)}
            disabled={busy}
          >
            {t("settings.git.worktreeRootReset")}
          </Button>
        )}
      </div>
    </div>
  );
}
