/**
 * Address-bar history for the embedded browser panel.
 *
 * All writes go through main (BrowserManager records on did-navigate) so there
 * is a single writer — the renderer only reads (setting.get) and requests
 * removals via the browser.historyRemove / historyClear RPCs. Entries are
 * stored as a JSON array (most-recent first, capped at MAX_ENTRIES) under the
 * `browser.addressHistory` settings key.
 */
import {
  BROWSER_ADDRESS_HISTORY_SETTING_KEY,
  type BrowserHistoryEntry,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";

/** Cap on stored entries. Navigation frequency is low, so the array stays
 *  small; 50 matches typical browser history dropdowns. */
const MAX_ENTRIES = 50;

function read(): BrowserHistoryEntry[] {
  const raw = SettingRepo.get(BROWSER_ADDRESS_HISTORY_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as BrowserHistoryEntry[]).filter(
      (e) => e && typeof e.url === "string",
    );
  } catch {
    return [];
  }
}

function write(entries: BrowserHistoryEntry[]): void {
  SettingRepo.set(
    BROWSER_ADDRESS_HISTORY_SETTING_KEY,
    JSON.stringify(entries.slice(0, MAX_ENTRIES)),
  );
}

export const AddressHistory = {
  /** Record a main-frame navigation: dedupe by URL (move to front), cap.
   *  Only http(s)/file URLs are kept — internal pages (about:, error pages,
   *  data:) would be noise in the dropdown. */
  record(url: string, title: string): void {
    if (!/^(https?|file):/i.test(url)) return;
    const entries = read().filter((e) => e.url !== url);
    entries.unshift({ url, title: title ?? "", at: Date.now() });
    write(entries);
  },

  /** Remove one entry by URL. */
  remove(url: string): void {
    write(read().filter((e) => e.url !== url));
  },

  /** Clear everything. */
  clear(): void {
    write([]);
  },
};
