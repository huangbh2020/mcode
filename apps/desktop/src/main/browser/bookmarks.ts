/**
 * Page bookmarks for the browser panel's "More" menu.
 *
 * Same single-writer discipline as AddressHistory: writes go through main
 * (browser.bookmarkAdd / browser.bookmarkRemove RPCs), the renderer only
 * reads via setting.get. Entries are a JSON array (most-recent first, capped
 * at MAX_ENTRIES) under the `browser.bookmarks` settings key.
 */
import { BROWSER_BOOKMARKS_SETTING_KEY, type BrowserBookmarkEntry } from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";

/** Cap on stored bookmarks. Bookmarking is deliberate and rare; 100 is far
 *  more than a panel dropdown shows and keeps the settings row bounded. */
const MAX_ENTRIES = 100;

function read(): BrowserBookmarkEntry[] {
  const raw = SettingRepo.get(BROWSER_BOOKMARKS_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as BrowserBookmarkEntry[]).filter(
      (e) => e && typeof e.url === "string",
    );
  } catch {
    return [];
  }
}

function write(entries: BrowserBookmarkEntry[]): void {
  SettingRepo.set(
    BROWSER_BOOKMARKS_SETTING_KEY,
    JSON.stringify(entries.slice(0, MAX_ENTRIES)),
  );
}

export const Bookmarks = {
  /** Bookmark a page: dedupe by URL (re-adding moves it to the front and
   *  refreshes the title), cap. Like AddressHistory.record, only web URLs
   *  are kept — internal pages (about:, error pages, data:) would be noise. */
  add(url: string, title: string): void {
    if (!/^(https?|file):/i.test(url)) return;
    const entries = read().filter((e) => e.url !== url);
    entries.unshift({ url, title: title ?? "", addedAt: Date.now() });
    write(entries);
  },

  /** Remove one bookmark by URL. */
  remove(url: string): void {
    write(read().filter((e) => e.url !== url));
  },
};
