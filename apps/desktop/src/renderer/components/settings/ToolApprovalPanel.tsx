/**
 * "工具自动允许" settings section (global always-allow tool list).
 *
 * Multi-turn tasks under moderated modes (isolated in particular) used to
 * re-prompt the SAME tool every turn — the session-scoped always-allow
 * checkbox died with the app and never covered new sessions. This editor
 * manages the PERSISTED global allowlist (settings key
 * `approval.globalAllowedTools`, held live by the ApprovalBridge in main):
 * tools listed here are auto-approved in every session of every provider
 * (Claude / Pi / Codex all consult `ctx.isToolAlwaysAllowed`) in every
 * permission mode EXCEPT plan mode. Host-side hard boundaries still run
 * FIRST in each provider's tool gate — out-of-project writes, bash write
 * targets, and isolated-mode out-of-project reads are denied regardless of
 * this list, so the grant can never widen the project fence.
 *
 * Whole-list read/replace over the `claude:list/saveGlobalAllowedTools`
 * RPCs; optimistic local state (a failed save keeps the editing session's
 * view, the next reopen re-syncs from main's source of truth).
 */
import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import { IconShieldCheck, IconX } from "@renderer/lib/icons.js";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

/** Datalist suggestions for the add field — the common built-in tool names
 *  users would want to pre-allow. Free-form input stays available for MCP
 *  tools (`mcp__server__tool`) and anything else the providers surface. */
const TOOL_PRESETS = [
  "Bash",
  "WebSearch",
  "WebFetch",
  "Task",
  "Read",
  "Grep",
  "Glob",
  "Write",
  "Edit",
  "TodoWrite",
  "Skill",
] as const;

export function ToolApprovalPanel() {
  const { t } = useI18n();
  // null = still loading; [] = loaded, list empty.
  const [tools, setTools] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    void api.claude
      .listGlobalAllowedTools()
      .then((res) => setTools(res.tools))
      .catch((err) => {
        console.error("claude.listGlobalAllowedTools failed:", err);
        setTools([]);
      });
  }, []);

  /** Whole-list replace: trim, drop empties/duplicates, sort, persist. */
  const commit = (next: string[]) => {
    const normalized = [...new Set(next.map((s) => s.trim()).filter(Boolean))].sort();
    setTools(normalized);
    void api.claude.saveGlobalAllowedTools({ tools: normalized }).catch((err) => {
      console.error("claude.saveGlobalAllowedTools failed:", err);
    });
  };

  const addDraft = () => {
    const name = draft.trim();
    if (!name || tools?.includes(name)) {
      setDraft("");
      return;
    }
    commit([...(tools ?? []), name]);
    setDraft("");
  };

  return (
    <SettingsSection
      title={t("settings.toolApproval.title")}
      desc={t("settings.toolApproval.desc")}
      icon={IconShieldCheck}
    >
      <SettingRow
        title={t("settings.toolApproval.rowTitle")}
        desc={t("settings.toolApproval.rowDesc")}
        layout="vertical"
      >
        <div className="space-y-2.5">
          {/* Current allowlist as removable chips. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {tools === null ? (
              <span className="text-[11px] text-content-subtle">
                {t("settings.toolApproval.loading")}
              </span>
            ) : tools.length === 0 ? (
              <span className="text-[11px] text-content-subtle">
                {t("settings.toolApproval.empty")}
              </span>
            ) : (
              tools.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-1 rounded-full border border-edge bg-surface-muted/60 py-0.5 pl-2 pr-1 font-mono text-[11px] text-content"
                >
                  {name}
                  <button
                    type="button"
                    onClick={() => commit(tools.filter((x) => x !== name))}
                    className="rounded-full p-0.5 text-content-muted transition-colors hover:bg-surface-hover hover:text-danger"
                    aria-label={t("settings.toolApproval.removeAria", { tool: name })}
                    title={t("settings.toolApproval.removeTitle")}
                  >
                    <IconX size={11} />
                  </button>
                </span>
              ))
            )}
          </div>

          {/* Add field with preset suggestions. */}
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDraft();
                }
              }}
              placeholder={t("settings.toolApproval.placeholder")}
              list="tool-approval-presets"
              className="flex-1"
            />
            <datalist id="tool-approval-presets">
              {TOOL_PRESETS.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <Button
              size="sm"
              variant="ghost"
              onClick={addDraft}
              disabled={!draft.trim()}
            >
              {t("settings.toolApproval.add")}
            </Button>
          </div>

          <p className="text-[11px] leading-relaxed text-content-subtle">
            {t("settings.toolApproval.hint")}
          </p>
        </div>
      </SettingRow>
    </SettingsSection>
  );
}
