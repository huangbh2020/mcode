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
  "browser.exitPick": "Exit element picking",
  "browser.pickElement": "Pick page element",
  "browser.collapseDeviceToolbar": "Collapse device toolbar",
  "browser.deviceToolbar": "Device toolbar (resize)",
  "browser.moreMenu": "More",
  "browser.bookmarks": "Bookmarks",
  "browser.bookmarkPage": "Bookmark this page",
  "browser.unbookmarkPage": "Remove bookmark from this page",
  "browser.bookmarkEmpty": "No bookmarks yet",
  "browser.removeBookmark": "Remove this bookmark",
  "browser.historyEmpty": "No history yet",

  /* ── panel ── */
  "browser.selectProjectFirst": "Select a project first",
  "browser.pickSidebarHint": "Click a page element to add it straight to the input · Esc to exit",
  "browser.pickOverlayHint": "Click page elements to add them to the input · Esc to exit",
  "browser.addedToInput": "Added to input",
  "browser.pickedToList": "Picked to list",

  /* ── basic auth prompt ── */
  "browser.authTitle": "Sign in required — {host}",
  "browser.authDesc": "{origin} is asking for a username and password (HTTP Basic Auth).",
  "browser.username": "Username",
  "browser.password": "Password",
  "browser.signIn": "Sign in",

  /* ── device toolbar ── */
  "browser.device": "Device",
  "browser.desktopDevice": "Desktop",
  "browser.customDevice": "Custom",
  "browser.fullWidth": "Full width",
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

  /* ── download bar ── */
  "browser.downloadBarLabel": "Downloads",
  "browser.downloadStateProgressing": "Downloading",
  "browser.downloadStateCompleted": "Done",
  "browser.downloadStateCancelled": "Cancelled",
  "browser.downloadStateInterrupted": "Failed",
  "browser.downloadOpenFile": "Open file",
  "browser.downloadRevealFolder": "Show in folder",
  "browser.downloadDismiss": "Dismiss",
} as const;
