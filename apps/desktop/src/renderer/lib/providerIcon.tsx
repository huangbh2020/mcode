/**
 * Provider → icon+color mapping for session rows, tabs, and the title bar.
 *
 * The renderer never hardcodes a provider's brand icon in more than one
 * place: adding a new provider means adding one entry here, and every
 * surface (LeftBar rows, SessionTabs, Titlebar chip) picks it up.
 *
 * Icons: claude uses the Simple Icons brand mark (SiClaude); pi uses its
 * official brand mark (PiBrandIcon, inlined from pi.dev since react-icons
 * doesn't carry it). The pi glyph is monochrome (currentColor) and is shown
 * in the official black — falling back to the content token in dark mode so
 * it stays visible on the dark surface.
 */
import type { ComponentType } from "react";
import { SiClaude, IconTerminal, PiBrandIcon } from "@renderer/lib/icons.js";

export interface ProviderIconMeta {
  Icon: ComponentType<{ size?: number; className?: string }>;
  /** Tailwind text-color class (brand accent). */
  color: string;
  /** Brand hex for the small leading dot in stream-sidebar cards (the full
   *  icon is too heavy inside a 3-line card; a 7px dot carries the identity). */
  dot: string;
  /** Short brand name for the card's meta line. */
  label: string;
}

/** Fallback for unknown provider ids (e.g. a persisted id whose provider
 *  wasn't registered) — a neutral message glyph. */
const FALLBACK: ProviderIconMeta = {
  Icon: IconTerminal,
  color: "text-content-subtle",
  dot: "#9ea2ab",
  label: "",
};

const PROVIDER_ICONS: Record<string, ProviderIconMeta> = {
  "claude-sdk": { Icon: SiClaude, color: "text-[#D97757]", dot: "#D97757", label: "Claude" },
  "pi-sdk": { Icon: PiBrandIcon, color: "text-black dark:text-content", dot: "#A78BFA", label: "Pi" },
};

export function getProviderIcon(providerId: string | null | undefined): ProviderIconMeta {
  if (!providerId) return FALLBACK;
  return PROVIDER_ICONS[providerId] ?? FALLBACK;
}
