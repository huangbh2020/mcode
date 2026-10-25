/**
 * "受信任域名" settings section (browser trusted-domain list).
 *
 * Companion editor to the browser-navigation domain gate
 * (main/browser/domainGate.ts): domains listed here are navigable by the
 * agent's browser tools without a first-visit approval prompt. localhost /
 * file origins are always allowed and never need an entry. Trusting a parent
 * domain covers its subdomains (github.com also allows api.github.com).
 *
 * Whole-list read/replace over the `claude:list/saveTrustedBrowserDomains`
 * RPCs (same pattern as ToolApprovalPanel); optimistic local state, the next
 * reopen re-syncs from main's source of truth.
 */
import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import { GlobeIcon, IconX } from "@renderer/lib/icons.js";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

/** Normalize one entry the same way main does (lowercase, strip trailing
 *  dots) so the chips the user sees match the stored set exactly. */
function normalize(v: string): string {
  let d = v.trim().toLowerCase();
  while (d.endsWith(".")) d = d.slice(0, -1);
  return d;
}

export function TrustedDomainsPanel() {
  const { t } = useI18n();
  // null = still loading; [] = loaded, list empty.
  const [domains, setDomains] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    void api.claude
      .listTrustedBrowserDomains()
      .then((res) => setDomains(res.domains))
      .catch((err) => {
        console.error("claude.listTrustedBrowserDomains failed:", err);
        setDomains([]);
      });
  }, []);

  /** Whole-list replace: normalize, drop empties/duplicates/invalid, sort. */
  const commit = (next: string[]) => {
    const normalized = [
      ...new Set(next.map(normalize).filter((d) => /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(d))),
    ].sort();
    setDomains(normalized);
    void api.claude.saveTrustedBrowserDomains({ domains: normalized }).catch((err) => {
      console.error("claude.saveTrustedBrowserDomains failed:", err);
    });
  };

  const addDraft = () => {
    const d = normalize(draft);
    if (!d || domains?.includes(d)) {
      setDraft("");
      return;
    }
    commit([...(domains ?? []), d]);
    setDraft("");
    setError(false);
  };

  const draftInvalid = draft.trim().length > 0 && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(normalize(draft));

  return (
    <SettingsSection
      title={t("settings.trustedDomains.title")}
      desc={t("settings.trustedDomains.desc")}
      icon={GlobeIcon}
    >
      <SettingRow
        title={t("settings.trustedDomains.rowTitle")}
        desc={t("settings.trustedDomains.rowDesc")}
        layout="vertical"
      >
        <div className="space-y-2.5">
          {/* Current trusted list as removable chips. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {domains === null ? (
              <span className="text-[11px] text-content-subtle">
                {t("settings.trustedDomains.loading")}
              </span>
            ) : domains.length === 0 ? (
              <span className="text-[11px] text-content-subtle">
                {t("settings.trustedDomains.empty")}
              </span>
            ) : (
              domains.map((d) => (
                <span
                  key={d}
                  className="inline-flex items-center gap-1 rounded-full border border-edge bg-surface-muted/60 py-0.5 pl-2 pr-1 font-mono text-[11px] text-content"
                >
                  {d}
                  <button
                    type="button"
                    onClick={() => commit(domains.filter((x) => x !== d))}
                    className="rounded-full p-0.5 text-content-muted transition-colors hover:bg-surface-hover hover:text-danger"
                    aria-label={t("settings.trustedDomains.removeAria", { domain: d })}
                    title={t("settings.trustedDomains.removeTitle")}
                  >
                    <IconX size={11} />
                  </button>
                </span>
              ))
            )}
          </div>

          {/* Add field. */}
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (draftInvalid) {
                    setError(true);
                    return;
                  }
                  addDraft();
                }
              }}
              placeholder={t("settings.trustedDomains.placeholder")}
              className="flex-1"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (draftInvalid) {
                  setError(true);
                  return;
                }
                addDraft();
              }}
              disabled={!draft.trim()}
            >
              {t("settings.trustedDomains.add")}
            </Button>
          </div>

          <p className={error ? "text-[11px] leading-relaxed text-danger" : "text-[11px] leading-relaxed text-content-subtle"}>
            {error ? t("settings.trustedDomains.invalid") : t("settings.trustedDomains.hint")}
          </p>
        </div>
      </SettingRow>
    </SettingsSection>
  );
}
