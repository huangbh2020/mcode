import type { Locale } from "@contracts/ipc";
import { zh as zhCommon } from "./zh/common.js";
import { zh as zhLayout } from "./zh/layout.js";
import { zh as zhLib } from "./zh/lib.js";
import { zh as zhChatStream } from "./zh/chat-stream.js";
import { zh as zhChatComposer } from "./zh/chat-composer.js";
import { zh as zhIde } from "./zh/ide.js";
import { zh as zhBrowser } from "./zh/browser.js";
import { zh as zhSettings } from "./zh/settings.js";
import { zh as zhStore } from "./zh/store.js";
import { en as enCommon } from "./en/common.js";
import { en as enLayout } from "./en/layout.js";
import { en as enLib } from "./en/lib.js";
import { en as enChatStream } from "./en/chat-stream.js";
import { en as enChatComposer } from "./en/chat-composer.js";
import { en as enIde } from "./en/ide.js";
import { en as enBrowser } from "./en/browser.js";
import { en as enSettings } from "./en/settings.js";
import { en as enStore } from "./en/store.js";

/**
 * Flat message catalogs, merged per locale. The zh catalog is the source of
 * truth: `MessageId` is derived from its keys, and the en catalog is typed as
 * `Record<MessageId, string>` so a missing/en-extra key fails typecheck.
 *
 * Keys are flat dotted ids namespaced per area file (`common.*`, `layout.*`,
 * `chat.*`, `ide.*`, `browser.*`, `settings.*`, `store.*`, …). Keep new keys in
 * the area file that owns the components using them — the split exists so
 * parallel migrations never touch the same file.
 */
const zh = {
  ...zhCommon,
  ...zhLayout,
  ...zhLib,
  ...zhChatStream,
  ...zhChatComposer,
  ...zhIde,
  ...zhBrowser,
  ...zhSettings,
  ...zhStore,
};

export type MessageId = keyof typeof zh;

const en: Record<MessageId, string> = {
  ...enCommon,
  ...enLayout,
  ...enLib,
  ...enChatStream,
  ...enChatComposer,
  ...enIde,
  ...enBrowser,
  ...enSettings,
  ...enStore,
};

/**
 * Look up `key` in `locale`'s catalog, interpolating `{name}` placeholders
 * from `params`. Falls back to the zh entry when an en key is missing at
 * runtime (typecheck should make this unreachable; it's a safety net for
 * hand-edited dictionaries), and to the raw key when even zh lacks it.
 *
 * Pure + dependency-free so non-React modules (stores, lib helpers) can call
 * it with the locale they hold, without importing the store-bound hook.
 */
export function translate(
  locale: Locale,
  key: MessageId,
  params?: Record<string, string | number>,
): string {
  const raw = locale === "en" ? (en[key] ?? zh[key]) : zh[key];
  const text = raw ?? (key as string);
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  );
}
