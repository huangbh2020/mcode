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
import { SiClaude, IconTerminal, PiBrandIcon, OpenAIBrandIcon } from "@renderer/lib/icons.js";
import { AntigravityBrandIcon } from "@renderer/lib/antigravityBrandIcon.js";
import { OpenCodeBrandIcon } from "@renderer/lib/opencodeBrandIcon.js";

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
  "codex-sdk": { Icon: OpenAIBrandIcon, color: "text-content", dot: "#10A37F", label: "Codex" },
  // Antigravity terminal CLI (`agy`) — official brand mark, inlined from
  // antigravity.google's favicon (Google-colored arch; see
  // antigravityBrandIcon.tsx).
  antigravity: { Icon: AntigravityBrandIcon, color: "", dot: "#3186FF", label: "Antigravity" },
  // OpenCode terminal CLI — official brand mark, inlined from opencode.ai's
  // favicon (square ring + cursor block; see opencodeBrandIcon.tsx). The
  // brand is pure monochrome, so the icon rides currentColor and the dot
  // picks a neutral gray that stays visible on both surface themes.
  opencode: { Icon: OpenCodeBrandIcon, color: "text-content", dot: "#9CA3AF", label: "OpenCode" },
  // OpenCode GUI provider — same official mark (shared with the terminal CLI
  // entry; both surfaces identify the same backend).
  "opencode-sdk": { Icon: OpenCodeBrandIcon, color: "text-content", dot: "#9CA3AF", label: "OpenCode" },
};

export function getProviderIcon(providerId: string | null | undefined): ProviderIconMeta {
  if (!providerId) return FALLBACK;
  return PROVIDER_ICONS[providerId] ?? FALLBACK;
}
