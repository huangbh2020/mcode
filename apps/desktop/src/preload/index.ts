import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@contracts/ipc";
import type { RpcMap } from "@contracts/ipc";
import type { MainToRendererMessage } from "@contracts/ipc";

/**
 * The typed API exposed to the renderer via contextBridge.
 * This is the ONLY bridge into Node — the renderer cannot require() anything.
 */
const api = {
  // ── RPC (renderer → main) ──
  claude: {
    startSession: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_START_SESSION, input)) as RpcMap["claude.startSession"],
    listSideChats: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_LIST_SIDE_CHATS, input)) as RpcMap["claude.listSideChats"],
    sendTurn: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_SEND_TURN, input)) as RpcMap["claude.sendTurn"],
    interrupt: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_INTERRUPT, input)) as RpcMap["claude.interrupt"],
    approve: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_APPROVE, input)) as RpcMap["claude.approve"],
    respondQuestion: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_RESPOND_QUESTION, input)) as RpcMap["claude.respondQuestion"],
    respondPlanApproval: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_RESPOND_PLAN_APPROVAL, input)) as RpcMap["claude.respondPlanApproval"],
    rewindTurn: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_REWIND_TURN, input)) as RpcMap["claude.rewindTurn"],
  },
  project: {
    create: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_CREATE, input)) as RpcMap["project.create"],
    list: (() => ipcRenderer.invoke(IPC.PROJECT_LIST)) as RpcMap["project.list"],
    sessions: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_SESSIONS, input)) as RpcMap["project.sessions"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_DELETE, input)) as RpcMap["project.delete"],
    archive: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_ARCHIVE, input)) as RpcMap["project.archive"],
    setGroup: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_SET_GROUP, input)) as RpcMap["project.setGroup"],
    reorder: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_REORDER, input)) as RpcMap["project.reorder"],
    setPinned: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_PIN, input)) as RpcMap["project.pin"],
    rename: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_RENAME, input)) as RpcMap["project.rename"],
  },
  session: {
    /** Cross-project session title search (Ctrl+K unified search). */
    search: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_SEARCH, input)) as RpcMap["session.search"],
    searchBookmarks: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_SEARCH_BOOKMARKS, input)) as RpcMap["session.searchBookmarks"],
    messages: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_MESSAGES, input)) as RpcMap["session.messages"],
    saveMessages: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_SAVE_MESSAGES, input)) as RpcMap["session.saveMessages"],
    upsertMessages: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_UPSERT_MESSAGES, input)) as RpcMap["session.upsertMessages"],
    truncateAndInsertMessages: ((input) =>
      ipcRenderer.invoke(
        IPC.SESSION_TRUNCATE_AND_INSERT_MESSAGES,
        input,
      )) as RpcMap["session.truncateAndInsertMessages"],
    updateSettings: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_UPDATE_SETTINGS, input)) as RpcMap["session.updateSettings"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_DELETE, input)) as RpcMap["session.delete"],
    archive: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_ARCHIVE, input)) as RpcMap["session.archive"],
    rename: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_RENAME, input)) as RpcMap["session.rename"],
    pin: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_PIN, input)) as RpcMap["session.pin"],
    updateBookmarks: ((input) =>
      ipcRenderer.invoke(
        IPC.SESSION_UPDATE_BOOKMARKS,
        input,
      )) as RpcMap["session.updateBookmarks"],
    listPinned: (() =>
      ipcRenderer.invoke(IPC.SESSION_LIST_PINNED)) as RpcMap["session.listPinned"],
    listAll: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_LIST_ALL, input)) as RpcMap["session.listAll"],
  },
  setting: {
    get: ((input) =>
      ipcRenderer.invoke(IPC.SETTING_GET, input)) as RpcMap["setting.get"],
    set: ((input) =>
      ipcRenderer.invoke(IPC.SETTING_SET, input)) as RpcMap["setting.set"],
    getMany: ((input) =>
      ipcRenderer.invoke(IPC.SETTING_GET_MANY, input)) as RpcMap["setting.getMany"],
  },
  /** Speech-to-text (voice input) — drives sherpa-onnx ASR in main. The
   *  renderer streams 16 kHz mono PCM via `feed`; live results arrive on
   *  `voiceResult`. */
  voice: {
    start: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_START, input)) as RpcMap["voice.start"],
    feed: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_FEED, input)) as RpcMap["voice.feed"],
    stop: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_STOP, input)) as RpcMap["voice.stop"],
    cancel: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_CANCEL, input)) as RpcMap["voice.cancel"],
    modelList: (() =>
      ipcRenderer.invoke(IPC.VOICE_MODEL_LIST)) as RpcMap["voice.modelList"],
    downloadModel: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_DOWNLOAD_MODEL, input)) as RpcMap["voice.downloadModel"],
    cancelModelDownload: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_CANCEL_MODEL_DOWNLOAD, input)) as RpcMap["voice.cancelModelDownload"],
    selectModel: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_SELECT_MODEL, input)) as RpcMap["voice.selectModel"],
    removeModel: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_REMOVE_MODEL, input)) as RpcMap["voice.removeModel"],
    getModelDir: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_GET_MODEL_DIR, input)) as RpcMap["voice.getModelDir"],
    setModelDir: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_SET_MODEL_DIR, input)) as RpcMap["voice.setModelDir"],
  },

  /** Notification preferences + OS notification click handling. */
  notification: {
    getPrefs: (() =>
      ipcRenderer.invoke(IPC.NOTIFICATION_GET_PREFS)) as RpcMap["notification.getPrefs"],
    setPrefs: ((input) =>
      ipcRenderer.invoke(IPC.NOTIFICATION_SET_PREFS, input)) as RpcMap["notification.setPrefs"],
    focusSession: ((input) =>
      ipcRenderer.invoke(IPC.NOTIFICATION_FOCUS_SESSION, input)) as RpcMap["notification.focusSession"],
  },

  /** Provider list — returns all registered backends with capabilities. */
  provider: {
    list: (() => ipcRenderer.invoke(IPC.PROVIDER_LIST)) as RpcMap["provider.list"],
  },

  /** Custom-model configs (user-defined Anthropic-compatible endpoints).
   *  Keys are encrypted at rest; the renderer only ever receives a masked form. */
  customModel: {
    list: (() => ipcRenderer.invoke(IPC.CUSTOM_MODEL_LIST)) as RpcMap["customModel.list"],
    save: ((input) =>
      ipcRenderer.invoke(IPC.CUSTOM_MODEL_SAVE, input)) as RpcMap["customModel.save"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.CUSTOM_MODEL_DELETE, input)) as RpcMap["customModel.delete"],
    test: ((input) =>
      ipcRenderer.invoke(IPC.CUSTOM_MODEL_TEST, input)) as RpcMap["customModel.test"],
    /** Settings UI eye-icon only — returns cleartext token for display. */
    getToken: ((input) =>
      ipcRenderer.invoke(IPC.CUSTOM_MODEL_GET_TOKEN, input)) as RpcMap["customModel.getToken"],
  },

  /** Pi models visual editor — reads/writes ~/.pi/agent/models.json.
   *  apiKey fields are $ENV_VAR references (never plaintext), so returning
   *  them to the renderer is safe. */
  piModels: {
    list: (() => ipcRenderer.invoke(IPC.PI_MODELS_LIST)) as RpcMap["piModels.list"],
    save: ((input) =>
      ipcRenderer.invoke(IPC.PI_MODELS_SAVE, input)) as RpcMap["piModels.save"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.PI_MODELS_DELETE, input)) as RpcMap["piModels.delete"],
    listAvailable: (() => ipcRenderer.invoke(IPC.PI_MODELS_LIST_AVAILABLE)) as RpcMap["piModels.listAvailable"],
    /** Settings UI eye-icon only — returns cleartext apiKey for display. */
    getApiKey: ((input) =>
      ipcRenderer.invoke(IPC.PI_MODELS_GET_API_KEY, input)) as RpcMap["piModels.getApiKey"],
  },

  /** Color scheme: get/set the preference; theme.changed fires when the
   *  effective theme changes (incl. OS-side changes in 'system' mode). */
  theme: {
    get: (() => ipcRenderer.invoke(IPC.THEME_GET)) as RpcMap["theme.get"],
    set: ((input) =>
      ipcRenderer.invoke(IPC.THEME_SET, input)) as RpcMap["theme.set"],
  },

  /** App + runtime info (version, Electron/Node/Chromium, platform) for the
   *  About panel. Parameterless RPC. */
  app: {
    info: (() => ipcRenderer.invoke(IPC.APP_INFO)) as RpcMap["app.info"],
    /** Check for updates on the GitHub Releases channel. */
    checkForUpdates: (() =>
      ipcRenderer.invoke(IPC.APP_CHECK_FOR_UPDATES)) as RpcMap["app.checkForUpdates"],
    /** Start downloading the pending update (user opted in). */
    downloadUpdate: (() =>
      ipcRenderer.invoke(IPC.APP_DOWNLOAD_UPDATE)) as RpcMap["app.downloadUpdate"],
    /** Quit and install a downloaded update. */
    quitAndInstall: (() =>
      ipcRenderer.invoke(IPC.APP_QUIT_AND_INSTALL)) as RpcMap["app.quitAndInstall"],
  },

  /** Open a project root in the OS file manager. Main refuses any path that
   *  isn't an exact match for a known project root, so only directories the
   *  user has added as projects can be opened. */
  shell: {
    openPath: ((input) =>
      ipcRenderer.invoke(IPC.SHELL_OPEN_PATH, input)) as RpcMap["shell.openPath"],
    /** Reveal a file or directory inside a project root in the OS file
     *  manager, selecting it. Used by the file-tree context menu. */
    showItemInFolder: ((input) =>
      ipcRenderer.invoke(
        IPC.SHELL_SHOW_ITEM_IN_FOLDER,
        input,
      )) as RpcMap["shell.showItemInFolder"],
    /** Open a file inside a project root with the OS default application
     *  (e.g. .docx in Word, .pdf in Preview). Used by the editor's
     *  unsupported-file pane. */
    openFile: ((input) =>
      ipcRenderer.invoke(IPC.SHELL_OPEN_FILE, input)) as RpcMap["shell.openFile"],
  },

  /** Filesystem operations for the IDE right panel + diff rendering. Every
   *  path must resolve inside a known project root (main enforces this);
   *  read/list degrade to empty on refusal or failure, write returns ok:false. */
  file: {
    readFile: ((input) =>
      ipcRenderer.invoke(IPC.FILE_READ, input)) as RpcMap["file.readFile"],
    /** Read a binary file as a base64 data URL (image preview). */
    readBinary: ((input) =>
      ipcRenderer.invoke(IPC.FILE_READ_BINARY, input)) as RpcMap["file.readBinary"],
    /** OS dialog image picker → base64 images (composer 图片 button). */
    pickImages: ((input) =>
      ipcRenderer.invoke(IPC.FILE_PICK_IMAGES, input)) as RpcMap["file.pickImages"],
    /** List one level of a directory (non-recursive) for the file tree. */
    listDir: ((input) =>
      ipcRenderer.invoke(IPC.FILE_LIST_DIR, input)) as RpcMap["file.listDir"],
    /** Recursive file search under a project root (composer @ / add-context). */
    search: ((input) =>
      ipcRenderer.invoke(IPC.FILE_SEARCH, input)) as RpcMap["file.search"],
    /** Grep file contents under a project root (line-level matches). */
    grep: ((input) =>
      ipcRenderer.invoke(IPC.FILE_GREP, input)) as RpcMap["file.grep"],
    /** Write utf-8 content to a file (creates parent dirs). Returns ok. */
    writeFile: ((input) =>
      ipcRenderer.invoke(IPC.FILE_WRITE, input)) as RpcMap["file.writeFile"],
    /** Create a directory (recursive). Returns ok. */
    mkdir: ((input) =>
      ipcRenderer.invoke(IPC.FILE_MKDIR, input)) as RpcMap["file.mkdir"],
    /** Delete a file or directory (moves to system trash). Returns ok. */
    delete: ((input) =>
      ipcRenderer.invoke(IPC.FILE_DELETE, input)) as RpcMap["file.delete"],
    /** Rename a file or directory in place. Returns ok. */
    rename: ((input) =>
      ipcRenderer.invoke(IPC.FILE_RENAME, input)) as RpcMap["file.rename"],
    /** Copy a file into a directory (auto-renames on name clash). Returns ok. */
    copy: ((input) =>
      ipcRenderer.invoke(IPC.FILE_COPY, input)) as RpcMap["file.copy"],
  },

  /** ripgrep availability + one-click install (search dialog banner). */
  rg: {
    status: (() => ipcRenderer.invoke(IPC.RG_STATUS)) as RpcMap["rg.status"],
    install: (() => ipcRenderer.invoke(IPC.RG_INSTALL)) as RpcMap["rg.install"],
  },

  /** Clipboard-pasted external files (images / files copied from the OS) →
   *  materialized to a temp path the agent can read (composer paste). */
  clipboardFile: {
    save: ((input) =>
      ipcRenderer.invoke(IPC.CLIPBOARD_SAVE_FILE, input)) as RpcMap["clipboard.saveFile"],
    /** Copy an image data URL onto the OS clipboard (image lightbox 复制). */
    writeImage: ((input) =>
      ipcRenderer.invoke(
        IPC.CLIPBOARD_WRITE_IMAGE,
        input,
      )) as RpcMap["clipboard.writeImage"],
  },

  /** Git operations for the Git panel. All paths must resolve inside a known
   *  project root (main enforces this). Auth for push/pull is handled by the
   *  system's git configuration (SSH keys, credential helpers). */
  git: {
    discoverRepos: ((input) =>
      ipcRenderer.invoke(IPC.GIT_DISCOVER_REPOS, input)) as RpcMap["git.discoverRepos"],
    status: ((input) =>
      ipcRenderer.invoke(IPC.GIT_STATUS, input)) as RpcMap["git.status"],
    stage: ((input) =>
      ipcRenderer.invoke(IPC.GIT_STAGE, input)) as RpcMap["git.stage"],
    unstage: ((input) =>
      ipcRenderer.invoke(IPC.GIT_UNSTAGE, input)) as RpcMap["git.unstage"],
    commit: ((input) =>
      ipcRenderer.invoke(IPC.GIT_COMMIT, input)) as RpcMap["git.commit"],
    push: ((input) =>
      ipcRenderer.invoke(IPC.GIT_PUSH, input)) as RpcMap["git.push"],
    pull: ((input) =>
      ipcRenderer.invoke(IPC.GIT_PULL, input)) as RpcMap["git.pull"],
    diff: ((input) =>
      ipcRenderer.invoke(IPC.GIT_DIFF, input)) as RpcMap["git.diff"],
    fileBlob: ((input) =>
      ipcRenderer.invoke(IPC.GIT_FILE_BLOB, input)) as RpcMap["git.fileBlob"],
    discard: ((input) =>
      ipcRenderer.invoke(IPC.GIT_DISCARD, input)) as RpcMap["git.discard"],
    generateCommitMessage: ((input) =>
      ipcRenderer.invoke(IPC.GIT_GENERATE_COMMIT, input)) as RpcMap["git.generateCommitMessage"],
    cancelGenerateCommitMessage: ((input) =>
      ipcRenderer.invoke(IPC.GIT_CANCEL_GENERATE_COMMIT, input)) as RpcMap["git.cancelGenerateCommitMessage"],
    resolveConflicts: ((input) =>
      ipcRenderer.invoke(IPC.GIT_RESOLVE_CONFLICTS, input)) as RpcMap["git.resolveConflicts"],
    log: ((input) =>
      ipcRenderer.invoke(IPC.GIT_LOG, input)) as RpcMap["git.log"],
    showCommit: ((input) =>
      ipcRenderer.invoke(IPC.GIT_SHOW_COMMIT, input)) as RpcMap["git.showCommit"],
    showFile: ((input) =>
      ipcRenderer.invoke(IPC.GIT_SHOW_FILE, input)) as RpcMap["git.showFile"],
    listBranches: ((input) =>
      ipcRenderer.invoke(IPC.GIT_LIST_BRANCHES, input)) as RpcMap["git.listBranches"],
    checkout: ((input) =>
      ipcRenderer.invoke(IPC.GIT_CHECKOUT, input)) as RpcMap["git.checkout"],
    mergePreview: ((input) =>
      ipcRenderer.invoke(IPC.GIT_MERGE_PREVIEW, input)) as RpcMap["git.mergePreview"],
    merge: ((input) =>
      ipcRenderer.invoke(IPC.GIT_MERGE, input)) as RpcMap["git.merge"],
    mergeAbort: ((input) =>
      ipcRenderer.invoke(IPC.GIT_MERGE_ABORT, input)) as RpcMap["git.mergeAbort"],
    worktreeList: ((input) =>
      ipcRenderer.invoke(IPC.GIT_WORKTREE_LIST, input)) as RpcMap["git.worktreeList"],
    worktreeStatus: ((input) =>
      ipcRenderer.invoke(IPC.GIT_WORKTREE_STATUS, input)) as RpcMap["git.worktreeStatus"],
    worktreeMergeBack: ((input) =>
      ipcRenderer.invoke(IPC.GIT_WORKTREE_MERGE_BACK, input)) as RpcMap["git.worktreeMergeBack"],
    worktreeRemove: ((input) =>
      ipcRenderer.invoke(IPC.GIT_WORKTREE_REMOVE, input)) as RpcMap["git.worktreeRemove"],
  },

  /** Integrated terminal (xterm in renderer ↔ node-pty in main). Paths on
   *  create must resolve inside a known project root (main enforces this). */
  terminal: {
    create: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_CREATE, input)) as RpcMap["terminal.create"],
    write: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_WRITE, input)) as RpcMap["terminal.write"],
    resize: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_RESIZE, input)) as RpcMap["terminal.resize"],
    kill: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_KILL, input)) as RpcMap["terminal.kill"],
    list: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_LIST, input)) as RpcMap["terminal.list"],
  },

  /** Embedded browser (WebContentsView in main ↔ browser panel in renderer).
   *  The view is an OS-level surface overlaid on the main window; the renderer
   *  measures a placeholder div and syncs pixel bounds via setBounds. Pick mode
   *  injects a script into the page's main world to capture clicked elements. */
  browser: {
    create: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_CREATE, input)) as RpcMap["browser.create"],
    loadUrl: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_LOAD_URL, input)) as RpcMap["browser.loadUrl"],
    goBack: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_GO_BACK, input)) as RpcMap["browser.goBack"],
    goForward: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_GO_FORWARD, input)) as RpcMap["browser.goForward"],
    reload: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_RELOAD, input)) as RpcMap["browser.reload"],
    setBounds: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_SET_BOUNDS, input)) as RpcMap["browser.setBounds"],
    setPickMode: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_SET_PICK_MODE, input)) as RpcMap["browser.setPickMode"],
    show: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_SHOW, input)) as RpcMap["browser.show"],
    hide: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_HIDE, input)) as RpcMap["browser.hide"],
    close: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_CLOSE, input)) as RpcMap["browser.close"],
    setDevice: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_SET_DEVICE, input)) as RpcMap["browser.setDevice"],
    clearCache: (() =>
      ipcRenderer.invoke(IPC.BROWSER_CLEAR_CACHE)) as RpcMap["browser.clearCache"],
    historyRemove: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_HISTORY_REMOVE, input)) as RpcMap["browser.historyRemove"],
    historyClear: (() =>
      ipcRenderer.invoke(IPC.BROWSER_HISTORY_CLEAR)) as RpcMap["browser.historyClear"],
    authRespond: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_AUTH_RESPOND, input)) as RpcMap["browser.authRespond"],
  },

  /** Language servers (LSP): install/enable per language, then sync documents
   *  and forward capability requests (definition/references/hover) to the
   *  server process running in main. All paths must resolve inside a known
   *  project root (main enforces this). */
  lsp: {
    list: (() => ipcRenderer.invoke(IPC.LSP_LIST)) as RpcMap["lsp.list"],
    install: ((input) =>
      ipcRenderer.invoke(IPC.LSP_INSTALL, input)) as RpcMap["lsp.install"],
    installFromFile: ((input) =>
      ipcRenderer.invoke(IPC.LSP_INSTALL_FROM_FILE, input)) as RpcMap["lsp.installFromFile"],
    uninstall: ((input) =>
      ipcRenderer.invoke(IPC.LSP_UNINSTALL, input)) as RpcMap["lsp.uninstall"],
    toggle: ((input) =>
      ipcRenderer.invoke(IPC.LSP_TOGGLE, input)) as RpcMap["lsp.toggle"],
    setPath: ((input) =>
      ipcRenderer.invoke(IPC.LSP_SET_PATH, input)) as RpcMap["lsp.setPath"],
    healthCheck: ((input) =>
      ipcRenderer.invoke(IPC.LSP_HEALTH_CHECK, input)) as RpcMap["lsp.healthCheck"],
    prewarm: ((input) =>
      ipcRenderer.invoke(IPC.LSP_PREWARM, input)) as RpcMap["lsp.prewarm"],
    restart: ((input) =>
      ipcRenderer.invoke(IPC.LSP_RESTART, input)) as RpcMap["lsp.restart"],
    openDocument: ((input) =>
      ipcRenderer.invoke(IPC.LSP_OPEN_DOC, input)) as RpcMap["lsp.openDocument"],
    closeDocument: ((input) =>
      ipcRenderer.invoke(IPC.LSP_CLOSE_DOC, input)) as RpcMap["lsp.closeDocument"],
    didChange: ((input) =>
      ipcRenderer.invoke(IPC.LSP_DID_CHANGE, input)) as RpcMap["lsp.didChange"],
    didSave: ((input) =>
      ipcRenderer.invoke(IPC.LSP_DID_SAVE, input)) as RpcMap["lsp.didSave"],
    request: ((input) =>
      ipcRenderer.invoke(IPC.LSP_REQUEST, input)) as RpcMap["lsp.request"],
  },

  // ── Main-only helpers ──
  /** Open a native folder picker; returns the chosen path or null. */
  pickFolder: (): Promise<{ path: string | null }> =>
    ipcRenderer.invoke("dialog:pickFolder"),
  /** Open a native multi-file picker (project-external files allowed).
   *  Returns the selected absolute paths; empty when the user cancels. */
  pickFiles: ((input) =>
    ipcRenderer.invoke(IPC.DIALOG_PICK_FILES, input)) as RpcMap["dialog.pickFiles"],

  /** Skill discovery + management. `list` scans ~/.mcode/skills + the active
   *  project's .claude/skills; read/save/delete operate on a single skill.
   *  scanSources/import support importing skills from external tools. */
  skills: {
    list: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_LIST, input)) as RpcMap["skills.list"],
    read: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_READ, input)) as RpcMap["skills.read"],
    save: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_SAVE, input)) as RpcMap["skills.save"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_DELETE, input)) as RpcMap["skills.delete"],
    scanSources: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_SCAN_SOURCES, input)) as RpcMap["skills.scanSources"],
    import: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_IMPORT, input)) as RpcMap["skills.import"],
  },

  /** MCP server management (settings panel): list the three server sources
   *  (user config file / project .mcp.json / built-in browser server), toggle
   *  them, add/remove user-scope servers, and import from the local Claude
   *  CLI config. Changes take effect on the next turn. */
  mcp: {
    list: ((input) =>
      ipcRenderer.invoke(IPC.MCP_LIST, input)) as RpcMap["mcp.list"],
    toggle: ((input) =>
      ipcRenderer.invoke(IPC.MCP_TOGGLE, input)) as RpcMap["mcp.toggle"],
    save: ((input) =>
      ipcRenderer.invoke(IPC.MCP_SAVE, input)) as RpcMap["mcp.save"],
    remove: ((input) =>
      ipcRenderer.invoke(IPC.MCP_REMOVE, input)) as RpcMap["mcp.remove"],
    scanImport: ((input) =>
      ipcRenderer.invoke(IPC.MCP_SCAN_IMPORT, input)) as RpcMap["mcp.scanImport"],
    import: ((input) =>
      ipcRenderer.invoke(IPC.MCP_IMPORT, input)) as RpcMap["mcp.import"],
  },

  /** Output styles (settings panel): list built-in + user styles. The
   *  selection is persisted via the generic setting channels and applies to
   *  Claude sessions from the next turn. */
  outputStyle: {
    list: ((input) =>
      ipcRenderer.invoke(IPC.OUTPUT_STYLE_LIST, input)) as RpcMap["outputStyle.list"],
  },

  /** Usage stats (settings panel): aggregated token/cost usage over the
   *  persisted per-turn history (summary + per-model + per-day heatmap). */
  usage: {
    stats: ((input) =>
      ipcRenderer.invoke(IPC.USAGE_STATS, input)) as RpcMap["usage.stats"],
  },

  /** Probe whether the default provider is functional. */
  claudeHealthCheck: (): Promise<{
    installed: boolean;
    source: string | null;
    command: string | null;
  }> => ipcRenderer.invoke("claude:healthCheck"),

  /** Mobile companion (LAN pairing + device management) — drives the PC-side
   *  "connect phone" dialog. The mobile HTTP server + pairing handshake itself
   *  lives in main; this only exposes start/cancel/list/revoke/status. */
  mobile: {
    startPairing: ((input) =>
      ipcRenderer.invoke(IPC.MOBILE_START_PAIRING, input)) as RpcMap["mobile.startPairing"],
    getPairing: (() => ipcRenderer.invoke(IPC.MOBILE_GET_PAIRING)) as RpcMap["mobile.getPairing"],
    cancelPairing: (() => ipcRenderer.invoke(IPC.MOBILE_CANCEL_PAIRING)) as RpcMap["mobile.cancelPairing"],
    listDevices: (() => ipcRenderer.invoke(IPC.MOBILE_LIST_DEVICES)) as RpcMap["mobile.listDevices"],
    revokeDevice: ((input) =>
      ipcRenderer.invoke(IPC.MOBILE_REVOKE_DEVICE, input)) as RpcMap["mobile.revokeDevice"],
    getStatus: (() => ipcRenderer.invoke(IPC.MOBILE_GET_STATUS)) as RpcMap["mobile.getStatus"],
    getActiveCount: (() => ipcRenderer.invoke(IPC.MOBILE_GET_ACTIVE_COUNT)) as RpcMap["mobile.getActiveCount"],
  },

  /** Relay (SSH-based remote access via user's own VPS) — drives the PC-side
   *  "remote access" panel. Save/read VPS config, connect/disconnect. */
  relay: {
    saveConfig: ((input) =>
      ipcRenderer.invoke(IPC.RELAY_SAVE_CONFIG, input)) as RpcMap["relay.saveConfig"],
    getConfig: (() => ipcRenderer.invoke(IPC.RELAY_GET_CONFIG)) as RpcMap["relay.getConfig"],
    connect: (() => ipcRenderer.invoke(IPC.RELAY_CONNECT)) as RpcMap["relay.connect"],
    disconnect: (() => ipcRenderer.invoke(IPC.RELAY_DISCONNECT)) as RpcMap["relay.disconnect"],
    status: (() => ipcRenderer.invoke(IPC.RELAY_STATUS)) as RpcMap["relay.status"],
  },

  // ── Push events (main → renderer) ──
  on: {
    /** Subscribe to claude:event push channel. Returns an unsubscribe fn. */
    claudeEvent(handler: (msg: Extract<MainToRendererMessage, { channel: "claude:event" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.CLAUDE_EVENT) handler(msg);
      };
      ipcRenderer.on(IPC.CLAUDE_EVENT, listener);
      return () => {
        ipcRenderer.off(IPC.CLAUDE_EVENT, listener);
      };
    },
    /** Subscribe to session:titleUpdated push channel. Fired when the main
     *  process's background title-gen routine overwrites a session's title.
     *  The renderer patches its in-memory session lists from this; no IPC
     *  round-trip needed (the DB is already updated). */
    sessionTitleUpdated(handler: (msg: Extract<MainToRendererMessage, { channel: "session:titleUpdated" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.SESSION_TITLE_UPDATED) handler(msg);
      };
      ipcRenderer.on(IPC.SESSION_TITLE_UPDATED, listener);
      return () => {
        ipcRenderer.off(IPC.SESSION_TITLE_UPDATED, listener);
      };
    },
    terminalData(handler: (msg: Extract<MainToRendererMessage, { channel: "terminal:data" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.TERMINAL_DATA) handler(msg);
      };
      ipcRenderer.on(IPC.TERMINAL_DATA, listener);
      return () => {
        ipcRenderer.off(IPC.TERMINAL_DATA, listener);
      };
    },
    /** Fires when a PTY exits (shell `exit`, crash, or kill). */
    terminalExit(handler: (msg: Extract<MainToRendererMessage, { channel: "terminal:exit" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.TERMINAL_EXIT) handler(msg);
      };
      ipcRenderer.on(IPC.TERMINAL_EXIT, listener);
      return () => {
        ipcRenderer.off(IPC.TERMINAL_EXIT, listener);
      };
    },
    /** LSP push events: diagnostics, server log messages, and running-state
     *  changes. Filter by `msg.type` in the handler. */
    lspEvent(handler: (msg: Extract<MainToRendererMessage, { channel: "lsp:event" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.LSP_EVENT) handler(msg);
      };
      ipcRenderer.on(IPC.LSP_EVENT, listener);
      return () => {
        ipcRenderer.off(IPC.LSP_EVENT, listener);
      };
    },
    /** Browser push events: navigation (URL/title/back/forward), loading state,
     *  pickResult (a clicked element's data), and crashed. Filter by `msg.type`
     *  and `msg.browserId` in the handler. */
    browserEvent(handler: (msg: Extract<MainToRendererMessage, { channel: "browser:event" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.BROWSER_EVENT) handler(msg);
      };
      ipcRenderer.on(IPC.BROWSER_EVENT, listener);
      return () => {
        ipcRenderer.off(IPC.BROWSER_EVENT, listener);
      };
    },
    /** Fires when the effective theme changes (user picked one, or OS changed
     *  while in 'system' mode). */
    themeChanged(handler: (msg: Extract<MainToRendererMessage, { channel: "theme:changed" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.THEME_CHANGED) handler(msg);
      };
      ipcRenderer.on(IPC.THEME_CHANGED, listener);
      return () => {
        ipcRenderer.off(IPC.THEME_CHANGED, listener);
      };
    },
    /** Fires when the updater finds a newer version on the release channel.
     *  autoDownload is off, so the renderer should prompt the user to download. */
    updateAvailable(handler: (msg: Extract<MainToRendererMessage, { channel: "update:available" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.UPDATE_AVAILABLE) handler(msg);
      };
      ipcRenderer.on(IPC.UPDATE_AVAILABLE, listener);
      return () => {
        ipcRenderer.off(IPC.UPDATE_AVAILABLE, listener);
      };
    },
    /** Fires repeatedly while an update downloads, carrying percent + byte
     *  counts so the About panel can render a progress bar. */
    updateDownloadProgress(handler: (msg: Extract<MainToRendererMessage, { channel: "update:downloadProgress" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.UPDATE_DOWNLOAD_PROGRESS) handler(msg);
      };
      ipcRenderer.on(IPC.UPDATE_DOWNLOAD_PROGRESS, listener);
      return () => {
        ipcRenderer.off(IPC.UPDATE_DOWNLOAD_PROGRESS, listener);
      };
    },
    /** Fires when a downloaded update is ready to install. */
    updateDownloaded(handler: (msg: Extract<MainToRendererMessage, { channel: "update:downloaded" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.UPDATE_DOWNLOADED) handler(msg);
      };
      ipcRenderer.on(IPC.UPDATE_DOWNLOADED, listener);
      return () => {
        ipcRenderer.off(IPC.UPDATE_DOWNLOADED, listener);
      };
    },
    /** Fires when the main window gains or loses focus (app switch, minimize,
     *  restore). The renderer uses this to decide whether background events
     *  warrant an OS notification or just an in-app badge. */
    windowFocusChanged(handler: (msg: Extract<MainToRendererMessage, { channel: "window:focusChanged" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.WINDOW_FOCUS_CHANGED) handler(msg);
      };
      ipcRenderer.on(IPC.WINDOW_FOCUS_CHANGED, listener);
      return () => {
        ipcRenderer.off(IPC.WINDOW_FOCUS_CHANGED, listener);
      };
    },
    /** Fires when the user clicks an OS notification. Main has already shown +
     *  focused the window; this event tells the renderer which session to
     *  navigate to. */
    notificationFocusSession(handler: (msg: Extract<MainToRendererMessage, { channel: "notification:focusSession" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.NOTIFICATION_FOCUS_SESSION) handler(msg);
      };
      ipcRenderer.on(IPC.NOTIFICATION_FOCUS_SESSION, listener);
      return () => {
        ipcRenderer.off(IPC.NOTIFICATION_FOCUS_SESSION, listener);
      };
    },
    /** Relay state changes (connecting, deployed, connected, error). */
    relayEvent(handler: (msg: Extract<MainToRendererMessage, { channel: "relay:event" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.RELAY_EVENT) handler(msg);
      };
      ipcRenderer.on(IPC.RELAY_EVENT, listener);
      return () => {
        ipcRenderer.off(IPC.RELAY_EVENT, listener);
      };
    },
    /** Live ASR results (partial/final) for an active voice-input session. */
    voiceResult(handler: (msg: Extract<MainToRendererMessage, { channel: "voice:result" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.VOICE_RESULT) handler(msg);
      };
      ipcRenderer.on(IPC.VOICE_RESULT, listener);
      return () => {
        ipcRenderer.off(IPC.VOICE_RESULT, listener);
      };
    },
    /** Voice-model download progress (Settings → 语音输入 → 下载语言模型). */
    voiceDownloadProgress(handler: (msg: Extract<MainToRendererMessage, { channel: "voice:downloadProgress" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.VOICE_DOWNLOAD_PROGRESS) handler(msg);
      };
      ipcRenderer.on(IPC.VOICE_DOWNLOAD_PROGRESS, listener);
      return () => {
        ipcRenderer.off(IPC.VOICE_DOWNLOAD_PROGRESS, listener);
      };
    },
  },
} as const;

contextBridge.exposeInMainWorld("api", api);
// Explicit Electron marker — read by renderer/lib/platform.ts to pick the
// desktop vs. web shell. Deliberately NOT derived from UA: Electron-based
// third-party webviews (which have no preload) would otherwise be mis-classed
// as the desktop shell. Only a real Mcode window (with this preload) carries
// the marker, and it's set before any page script runs, so the check is
// immune to module-evaluation order.
contextBridge.exposeInMainWorld("mcodeElectron", true);

// Type declaration so the renderer sees `window.api`.
export type Api = typeof api;
