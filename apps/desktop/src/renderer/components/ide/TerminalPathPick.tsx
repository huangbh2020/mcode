/**
 * Pick list for an ambiguous bare filename clicked in terminal output —
 * the renderer half of the "ambiguous name degrades to a choice, not a
 * dead click" flow. The main-side resolver returns the same-name match
 * list (it refuses to guess); this panel asks the user which one to open.
 *
 * Anchored to the click point (viewport coordinates from the xterm link
 * activation event), clamped into the viewport; a full-screen backdrop
 * closes it on outside click / Escape. Opens via openFileInIde — preview
 * mode covers images/videos, so media artifacts open as previews.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";

export interface TerminalPathPickState {
  /** Viewport coordinates of the link activation (panel anchor). */
  x: number;
  y: number;
  /** The name exactly as printed in the terminal — the panel's subject. */
  printed: string;
  /** Absolute candidate paths from the main-side resolver (2..8 entries). */
  candidates: string[];
}

interface Props {
  pick: TerminalPathPickState;
  /** Project root the resolver walked — candidates under it display
   *  root-relative (the directory context is exactly what disambiguates). */
  root: string;
  onPick: (absolutePath: string) => void;
  onClose: () => void;
}

/** Split an absolute candidate into {dir, base} for display, collapsing the
 *  project-root prefix when the candidate lives under it. Renderer has no
 *  node:path — string ops over both separator styles, case-insensitive on
 *  the Windows root prefix (drive-letter casing drifts freely). */
function displayParts(candidate: string, root: string): { dir: string; base: string } {
  const sep = candidate.includes("\\") ? "\\" : "/";
  const normRoot = root.replace(/[\\/]+$/, "");
  let shown = candidate;
  const prefix = normRoot + sep;
  if (
    sep === "/"
      ? candidate.startsWith(prefix)
      : candidate.toLowerCase().startsWith(prefix.toLowerCase())
  ) {
    shown = candidate.slice(prefix.length);
  }
  const cut = shown.lastIndexOf(sep);
  return cut >= 0
    ? { dir: shown.slice(0, cut + 1), base: shown.slice(cut + 1) }
    : { dir: "", base: shown };
}

const PANEL_MAX_W = 460;
const ROW_H = 28;
const PANEL_CHROME = 64; // header + padding + borders

export function TerminalPathPick({ pick, root, onPick, onClose }: Props) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Anchored/clamped position, settled after first layout so the real panel
  // height (long candidate lists) drives the flip-above decision.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const w = panelRef.current?.offsetWidth ?? PANEL_MAX_W;
    const h = panelRef.current?.offsetHeight ?? PANEL_CHROME + pick.candidates.length * ROW_H;
    const left = Math.max(8, Math.min(pick.x, window.innerWidth - w - 8));
    const top =
      pick.y + h + 8 > window.innerHeight
        ? Math.max(8, pick.y - h - 8)
        : Math.min(pick.y + 4, window.innerHeight - h - 8);
    setPos({ left, top });
  }, [pick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* Backdrop: outside click closes. Sits below the panel in paint order
          (same z, earlier in DOM) — clicks on candidates never reach it. */}
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div
        ref={panelRef}
        role="menu"
        className="fixed z-50 max-w-[460px] overflow-hidden rounded-lg border border-line bg-surface shadow-xl"
        style={{ left: pos?.left ?? pick.x, top: pos?.top ?? pick.y, visibility: pos ? "visible" : "hidden" }}
      >
        <div className="border-b border-line px-3 py-2">
          <div className="text-xs font-medium text-content">{t("ide.term.pathPickTitle")}</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-content-subtle">{pick.printed}</div>
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {pick.candidates.map((c) => {
            const parts = displayParts(c, root);
            return (
              <button
                key={c}
                type="button"
                onClick={() => onPick(c)}
                className="flex w-full items-baseline gap-0.5 px-3 py-1 text-left font-mono text-[11px] text-content-muted hover:bg-surface-hover hover:text-content"
              >
                <span className="truncate text-content-subtle">{parts.dir}</span>
                <span className="shrink-0">{parts.base}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
