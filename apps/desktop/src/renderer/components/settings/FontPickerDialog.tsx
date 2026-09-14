import { useEffect, useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { Dialog, Input } from "@renderer/components/ui/index.js";
import { IconCheck } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * Font picker dialog for the custom UI font (appearance panel). Lists the
 * font families installed on the system (enumerated by the main process —
 * Chromium's queryLocalFonts doesn't exist in Electron), with a search box
 * and each candidate rendered as a specimen in its OWN face so coverage and
 * flavor are visible at a glance. Picking applies live (optimistic store
 * update); "default" resets to the stylesheet stack.
 *
 * No virtualization: system family counts are low hundreds (246 measured on
 * macOS, similar on Windows), and the search box shrinks the list further —
 * plain rows render fine. Revisit if a font-manager machine ever lags.
 */

/** Specimen rendered in each candidate's own face: a CJK glyph (coverage at
 *  a glance), latin upper/lowercase and digits. Font-specimen content, not
 *  UI copy — deliberately not in the i18n dictionaries. */
const FONT_SPECIMEN = "永 Aa 123";

/** Curated families floated to the top of the list when installed — saves
 *  zh-locale users from scrolling hundreds of Latin faces to find a CJK one.
 *  Font identifiers (data), never translated; filtered by actual presence. */
const PINNED_FAMILIES = [
  "Microsoft YaHei",
  "PingFang SC",
  "Noto Sans CJK SC",
  "Source Han Sans SC",
  "Sarasa Gothic SC",
  "HarmonyOS Sans SC",
  "MiSans",
  "Inter",
  "Segoe UI",
];

type LoadState = "idle" | "loading" | "ready" | "error";

/** One list row: specimen in the family's own face + the family name (UI
 *  font, muted) + a check when selected. */
function FontRow({
  family,
  label,
  selected,
  nameClass,
  onPick,
  pickLabel,
}: {
  family: string;
  /** Display name override (the default row shows a translated label). */
  label?: string;
  selected: boolean;
  /** Extra classes for the name — the default row styles it normally. */
  nameClass?: string;
  onPick: (family: string) => void;
  pickLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(family)}
      aria-pressed={selected}
      aria-label={pickLabel}
      className={cn(
        "flex w-full items-center gap-3 rounded px-3 py-2 text-left transition-colors hover:bg-surface-muted",
        selected && "bg-surface-muted",
      )}
    >
      <span
        className="w-24 shrink-0 truncate text-[15px] leading-tight"
        style={family ? { fontFamily: `"${family}", sans-serif` } : undefined}
      >
        {FONT_SPECIMEN}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-xs", nameClass ?? "text-content-muted")}>
        {label ?? family}
      </span>
      {selected && <IconCheck size={14} className="shrink-0 text-accent" />}
    </button>
  );
}

export function FontPickerDialog({
  open,
  onOpenChange,
  current,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Currently applied family ("" = default). Drives the check mark. */
  current: string;
  /** Called with the picked family ("" for the default row); the caller
   *  applies it via the store so the whole UI flips live behind the dialog. */
  onPick: (family: string) => void;
}) {
  const { t } = useI18n();
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [families, setFamilies] = useState<string[]>([]);
  const [query, setQuery] = useState("");

  const load = (refresh: boolean) => {
    setLoadState("loading");
    api.fonts
      .listSystemFamilies({ refresh })
      .then((r) => {
        setFamilies(r.families);
        setLoadState("ready");
      })
      .catch((err) => {
        console.error("fonts.listSystemFamilies failed:", err);
        setLoadState("error");
      });
  };

  // Fetch once per mount when first opened; the list survives close/reopen
  // (main caches too). Retry after a failure forces a fresh enumeration.
  useEffect(() => {
    if (open && loadState === "idle") load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loadState]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? families.filter((f) => f.toLowerCase().includes(q)) : families),
    [families, q],
  );
  const pinned = useMemo(
    () => PINNED_FAMILIES.filter((f) => filtered.includes(f)),
    [filtered],
  );
  const rest = useMemo(
    () => filtered.filter((f) => !pinned.includes(f)),
    [filtered, pinned],
  );

  const pick = (family: string) => {
    onPick(family);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[80vh] w-[440px] flex-col p-0">
          <Dialog.Title className="px-4 pt-4">
            {t("settings.appearance.fontPickerTitle")}
          </Dialog.Title>
          <Dialog.Description className="px-4 pt-1">
            {t("settings.appearance.fontPickerDesc")}
          </Dialog.Description>
          <Dialog.Close />
          <div className="px-4 pb-2 pt-3">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.appearance.fontPickerSearch")}
              spellCheck={false}
              aria-label={t("settings.appearance.fontPickerSearch")}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {loadState === "loading" && (
              <p className="px-3 py-6 text-center text-xs text-content-subtle">
                {t("settings.appearance.fontPickerLoading")}
              </p>
            )}
            {loadState === "error" && (
              <div className="flex flex-col items-center gap-2 px-3 py-6">
                <p className="text-xs text-danger">
                  {t("settings.appearance.fontPickerError")}
                </p>
                <button
                  type="button"
                  onClick={() => load(true)}
                  className="rounded border border-edge px-2 py-1 text-xs text-content-muted hover:bg-surface-muted hover:text-content"
                >
                  {t("settings.appearance.fontPickerRetry")}
                </button>
              </div>
            )}
            {loadState === "ready" && filtered.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-content-subtle">
                {t("settings.appearance.fontPickerEmpty")}
              </p>
            )}
            {loadState === "ready" && filtered.length > 0 && (
              <>
                <FontRow
                  family=""
                  label={t("settings.appearance.uiFontDefault")}
                  selected={current === ""}
                  nameClass="text-content"
                  onPick={pick}
                  pickLabel={t("settings.appearance.uiFontDefault")}
                />
                {pinned.length > 0 && (
                  <>
                    <p className="px-3 pb-1 pt-3 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
                      {t("settings.appearance.fontPickerPinned")}
                    </p>
                    {pinned.map((f) => (
                      <FontRow
                        key={f}
                        family={f}
                        selected={current === f}
                        onPick={pick}
                        pickLabel={f}
                      />
                    ))}
                  </>
                )}
                <p className="px-3 pb-1 pt-3 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
                  {t("settings.appearance.fontPickerAll")}
                </p>
                {rest.map((f) => (
                  <FontRow
                    key={f}
                    family={f}
                    selected={current === f}
                    onPick={pick}
                    pickLabel={f}
                  />
                ))}
              </>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
