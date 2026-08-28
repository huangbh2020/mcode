/** English mirror of `zh/lib.ts`. */
export const en = {
  /* ── shared ── */
  "lib.untitledSession": "Untitled session",

  /* ── lib/commands.ts (command palette labels) ── */
  "lib.commands.closeTab": "Close current tab",
  "lib.commands.openPalette": "Open command palette",
  "lib.commands.displaySingle": "Display mode: single session",
  "lib.commands.displayTabs": "Display mode: tabs",
  "lib.commands.displayToggle": "Toggle display mode",
  "lib.commands.rightPanelFiles": "Right panel: files",
  "lib.commands.searchFiles": "Search files",
  "lib.commands.rightPanelGit": "Right panel: Git",
  "lib.commands.rightPanelTurns": "Right panel: turn flow",
  "lib.commands.openSettings": "Open settings",
  "lib.commands.navBack": "Editor: go back",
  "lib.commands.navForward": "Editor: go forward",
  "lib.commands.focusComposer": "Focus chat input",
  "lib.commands.voiceDictation": "Voice input (hold to talk / tap to toggle)",
  "lib.commands.toggleLeft": "Toggle left sidebar",
  "lib.commands.toggleRight": "Toggle right sidebar",
  "lib.commands.toggleTerminal": "Toggle bottom terminal",
  "lib.commands.toggleBrowser": "Toggle browser panel",
  "lib.commands.openSideChat": "Sub-sessions (won't interrupt the session)",
  "lib.commands.toggleWide": "Toggle wide mode (chat + panel)",
  "lib.commands.themeLight": "Theme: light",
  "lib.commands.themeDark": "Theme: dark",
  "lib.commands.themeToggle": "Toggle light/dark theme",
  "lib.commands.switchToSession": "Switch to session: {title}",

  /* ── lib/contextWindow.ts ── */
  "lib.context.title": "Context usage",
  "lib.context.input": "Input",
  "lib.context.cacheRead": "Cache read",
  "lib.context.cacheHit": "Cache hit",
  "lib.context.output": "Output",
  "lib.context.processed": "Processed this turn",

  /* ── lib/time.ts ── */
  "lib.time.justNow": "Just now",
  "lib.time.minutesAgo": "{n} min ago",
  "lib.time.hoursAgo": "{n} hr ago",
  "lib.time.daysAgo": "{n} days ago",
  "lib.time.monthsAgo": "{n} mo ago",
  "lib.time.yearsAgo": "{n} yr ago",

  /* ── lib/slashCommands.ts (built-in / commands shown in the picker) ── */
  "lib.slash.compact": "Compact the conversation (summarize and release context)",
  "lib.slash.init": "Generate the project guide file AGENTS.md",
  "lib.slash.browser": "Open a page in the built-in browser (navigate/snapshot/click/screenshot)",
  "lib.slash.sidechat": "Open sub-sessions (won't interrupt this session)",

  /* ── lib/imageResize.ts (send-time errors surfaced as toasts) ── */
  "lib.image.invalidData": "{name}: not valid image data",
  "lib.image.decodeFailed": "{name}: image failed to decode",
  "lib.image.canvasFailed": "{name}: unable to create a canvas",
  "lib.image.compressFailed": "{name}: image compression failed",
  "lib.image.stillTooLarge": "{name}: still too large after compression, please pick a smaller image",

  /* ── lib/webApi.ts (phone-side errors) ── */
  "lib.web.pairFailed": "Pairing failed ({status})",
  "lib.web.notPaired": "Not paired — generate a QR code on the computer first",
  "lib.web.deviceRevoked": "This device was removed on the computer — please pair again",
  "lib.web.rpcFailed": "Request failed ({status})",
  "lib.web.timeout": "Request timed out ({sec} s) — the computer may be restarting or the network is unstable, please retry later",
  "lib.web.unavailable": "api.{name} is not available on mobile",
  "lib.web.pickerFailed": "Unable to open the file picker",
  "lib.web.pasteUnsupported": "Pasting external files is not supported on mobile, images only",
} as const;
