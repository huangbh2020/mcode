/** English mirror of `zh/browser.ts`. */
export const en = {
  /* ── tab strip ── */
  "browser.newTab": "New tab",
  "browser.createTab": "New tab",
  "browser.closeTabAria": "Close tab",

  /* ── toolbar ── */
  "browser.backToWorkspace": "Back to workspace",
  "browser.switchToSidebar": "Switch to sidebar",
  "browser.expandFullscreen": "Expand to fullscreen",
  "browser.back": "Back",
  "browser.forward": "Forward",
  "browser.addressPlaceholder": "Enter a URL, local file path, or search…",
  "browser.history": "History",
  "browser.removeHistoryEntry": "Remove this entry",
  "browser.clearHistory": "Clear history…",
  "browser.credentials": "Password vault",
  "browser.exitPick": "Exit element picking",
  "browser.pickElement": "Pick page element",
  "browser.collapseDeviceToolbar": "Collapse device toolbar",
  "browser.deviceToolbar": "Device toolbar (resize)",
  "browser.closeBrowser": "Close browser",

  /* ── panel ── */
  "browser.selectProjectFirst": "Select a project first",
  "browser.pickSidebarHint": "Click a page element to add it straight to the input · Esc to exit",
  "browser.pickOverlayHint": "Click page elements to add them to the input · Esc to exit",
  "browser.addedToInput": "Added to input",
  "browser.pickedToList": "Picked to list",
  "browser.closeBrowserQ": "Close browser?",
  "browser.closeBrowserDesc": "All open tabs will be destroyed and unsaved page content will be lost.",
  "browser.confirmClose": "Close",

  /* ── basic auth prompt ── */
  "browser.authTitle": "Sign in required — {host}",
  "browser.authDesc": "{origin} is asking for a username and password (HTTP Basic Auth).",
  "browser.username": "Username",
  "browser.password": "Password",
  "browser.savePassword": "Save password (encrypted; signs in automatically next time)",
  "browser.signIn": "Sign in",

  /* ── credential vault ── */
  "browser.vaultTitle": "Browser password vault",
  "browser.vaultDesc":
    "Save credentials per site (encrypted with the OS keychain). HTTP Basic Auth prompts use them automatically, and the toolbar key menu can fill the current page's login form.",
  "browser.noCredentials": "No saved credentials",
  "browser.editingCredential": "Edit {origin}",
  "browser.addCredential": "Add credential",
  "browser.passwordKeep": "Password (leave blank to keep)",
  "browser.invalidOrigin": "Enter a valid site origin (e.g. https://example.com)",
  "browser.usernameRequired": "Username is required",
  "browser.cancelEdit": "Cancel editing",

  /* ── device toolbar ── */
  "browser.device": "Device",
  "browser.desktopDevice": "Desktop",
  "browser.customDevice": "Custom",
  "browser.pcFullWidth": "PC full width",
  "browser.deviceTitle": "Device: {label} {dims}",
  "browser.customWidthTitle": "Custom width (px)",
  "browser.customWidthAria": "Custom width",
  "browser.customHeightTitle": "Custom height (px)",
  "browser.customHeightAria": "Custom height",
  "browser.rotateToPortrait": "Switch to portrait",
  "browser.rotateToLandscape": "Switch to landscape",
  "browser.collapse": "Collapse",

  /* ── picked elements bar ── */
  "browser.pickedCount": "Picked {n} elements",
  "browser.clearPickedHint": "Clear picked list",
  "browser.clear": "Clear",
  "browser.add": "Add",
  "browser.addAndReturn": "Add to input and return to the main panel",
} as const;
