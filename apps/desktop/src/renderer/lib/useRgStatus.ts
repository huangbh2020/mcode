/**
 * ripgrep availability + one-click install state, shared by the search
 * surfaces (SearchDialog and the CommandPalette's 文件/文件内容 scopes).
 *
 * Checks `rg.status` whenever `active` flips on (a `cancelled` guard drops
 * stale responses if the surface closes mid-check); a failed status check
 * degrades to "assume available" so the banner never nags when we can't
 * tell. `install` runs the one-click install and flips `ready` on success;
 * the surface formats the raw error into its own i18n copy.
 */
import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";

export function useRgStatus(active: boolean) {
  const [ready, setReady] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setError(null);
    void api.rg
      .status()
      .then((s) => {
        if (cancelled) return;
        setReady(s.available);
        setInstalling(s.installing);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      const res = await api.rg.install({});
      if (res.ok) {
        setReady(true);
      } else {
        setError(res.error ?? "unknown");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  return { ready, installing, error, install };
}