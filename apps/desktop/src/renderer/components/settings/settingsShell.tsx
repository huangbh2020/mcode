/**
 * SettingsShellContext — the layout contract between the settings shell
 * (`SettingsPage`) and the panel page header (`PanelHeader`).
 *
 * Plan-A settings layout (prototypes/settings-redesign.html) has ONE scroll
 * container and ONE fixed page header: the header spans the full page width
 * above the scrolling body instead of being a `sticky` element inside it.
 * `SettingsPage` therefore owns the header slot and the page identity (icon +
 * one-line description of the active nav item); `PanelHeader` renders its
 * markup into that slot through a portal.
 *
 * Kept in its own module so `PanelHeader` never has to import `SettingsPage`
 * (which imports every panel — a cycle).
 */
import { createContext, useContext, type ComponentType } from "react";
import type { TablerIconProps } from "@renderer/lib/icons.js";

export interface SettingsShellValue {
  /** DOM node hosting the page header. `null` until the shell has mounted. */
  headerSlot: HTMLElement | null;
  /** Icon of the active nav item — default page-header icon. */
  pageIcon?: ComponentType<TablerIconProps>;
  /** One-line description of the active page — default header subtitle. */
  pageDesc?: string;
}

/** `null` = no settings shell above (a bare `PanelHeader` elsewhere). */
const SettingsShellContext = createContext<SettingsShellValue | null>(null);

export const SettingsShellProvider = SettingsShellContext.Provider;

export function useSettingsShell(): SettingsShellValue | null {
  return useContext(SettingsShellContext);
}
