/** English mirror of `zh/chat-stream.ts`. */
export const en = {
  // ── MessageTimeline ──
  "chatStream.timeline.current": "Current",
  "chatStream.timeline.noText": "(no text)",
  "chatStream.timeline.attachmentLine": "[Attachment] {text}",

  // ── MessageBlocks: batch tool group ──
  "chatStream.opCount": "{n} operations",

  // ── MessageBlocks: thinking / tool cards ──
  "chatStream.thinking": "Thinking",
  "chatStream.tool.input": "Input",
  "chatStream.tool.result": "Result",
  "chatStream.lineCount": "{n} lines",
  "chatStream.emptyPlaceholder": "(empty)",
  "chatStream.truncatedSuffix": "(truncated)",

  // ── MessageBlocks: compact summary ──
  "chatStream.compact.manual": "History compacted manually",
  "chatStream.compact.auto": "History compacted automatically",
  "chatStream.compact.freed": "· Freed {n} tokens",

  // ── MessageBlocks: images ──
  "chatStream.image.browserScreenshot": "Browser screenshot",
  "chatStream.image.userImage": "User image",
  "chatStream.imageRenderedAbove": "[image rendered above]",

  // ── MessageBlocks: image gallery ──
  "chatStream.gallery.screenshotAlt": "Screenshot {n}/{total}",
  "chatStream.gallery.prev": "Previous",
  "chatStream.gallery.next": "Next",
  "chatStream.gallery.imageN": "Image {n}",

  // ── MessageBlocks: attachment chip ──
  "chatStream.attachment.viewImage": "View image",
  "chatStream.attachment.viewContent": "View content",
  "chatStream.attachment.collapseImage": "Collapse image",
  "chatStream.attachment.collapseContent": "Collapse content",

  // ── Markdown ──
  "chatStream.copyCode": "Copy code",

  // ── FileLink ──
  "chatStream.fileLink.clickToOpen": "Click to open file",
  "chatStream.fileLink.noMatch": "No matching files found",
  "chatStream.fileLink.matchCount": "{n} matches · pick one to open",

  // ── DiffView / Write card diff labels ──
  "chatStream.diff.noChanges": "(no changes)",
  "chatStream.diff.newFile": "New file",
  "chatStream.diff.vsPreTurn": "Diff vs pre-turn",
  "chatStream.diff.newFileContent": "New file content",

  // ── TurnFilesCard ──
  "chatStream.turnFiles.titleLong": "Modified {n} files this turn",
  "chatStream.turnFiles.titleShort": "{n} files changed",
  "chatStream.turnFiles.created": "{n} created",
  "chatStream.turnFiles.modified": "{n} modified",
  "chatStream.turnFiles.rewindLong": "Undo this turn",
  "chatStream.turnFiles.rewindShort": "Undo",
  "chatStream.turnFiles.rewinding": "Undoing…",
  "chatStream.turnFiles.rewoundCheck": "Undone ✓",
  "chatStream.turnFiles.rewoundBadge": "Undone",
  "chatStream.turnFiles.rewindLatestTitle": "Restore all files from this turn to their pre-turn state",
  "chatStream.turnFiles.rewindHistoryTitle":
    "Restore this past turn's file changes to their pre-edit state (may affect later turns)",
  "chatStream.turnFiles.confirmTitle": "Undo this turn's changes",
  "chatStream.turnFiles.confirmDescLatest": "Files changed this turn will be restored to their pre-turn state.",
  "chatStream.turnFiles.confirmDescHistory1": "Undoing a past turn restores its changed files to their pre-edit state,",
  "chatStream.turnFiles.confirmDescHistory2": "which may affect later turns that edited the same files. Continue?",
  "chatStream.turnFiles.reviewDiff": "Review changes in the editor",
  "chatStream.turnFiles.locateTitle": "Reveal this file in the file tree",
  "chatStream.turnFiles.createdThisTurn": "Created this turn",
  "chatStream.turnFiles.modifiedThisTurn": "Modified this turn",
  "chatStream.turnFiles.noChanges": "No changes",

  // ── StatusCapsule / ActivityPopover ──
  "chatStream.activity.capsuleTitle": "View activity details (plans / tasks / subagents)",
  "chatStream.activity.plansTitle": "Plans · {n}",
  "chatStream.activity.planFallback": "(Plan {n})",
  "chatStream.activity.viewPlan": "Click to view the full plan",
  "chatStream.activity.tasksTitle": "Tasks",
  "chatStream.activity.subagentsTitle": "Subagents · {n}",
  "chatStream.activity.runningCount": "{n} running",
  "chatStream.activity.noDescription": "(no description)",
  "chatStream.subagent.statusRunning": "Running",
  "chatStream.subagent.statusCompleted": "Completed",
  "chatStream.subagent.statusFailed": "Failed",
  "chatStream.subagent.statusKilled": "Terminated",

  // ── ChatPane: streaming spinner hint ──
  "chatStream.upstreamRetry": "Upstream connection issue — retrying ({attempt}/{attempts})",

  // ── MessageBlocks: turn-incomplete warning card ──
  "chatStream.turnIncomplete.title": "Task ended early",
  "chatStream.turnIncomplete.danglingDesc":
    "The model channel returned an empty response mid-task, so this turn ended unfinished. Send “Continue” to resume from where it stopped.",
  "chatStream.turnIncomplete.emptyDesc":
    "The model channel returned no reply text this turn. Try resending or switching models.",
  "chatStream.turnIncomplete.pendingTools": "Unfinished calls: {tools}",

  // ── EmptyThreadWelcome ──
  "chatStream.welcome.title": "Start a new chat",
  "chatStream.welcome.withProject": "Start a new chat in {name}",
  "chatStream.welcome.todayUsage": "{turns} turns today · {tokens} tokens used",
} as const;
