/** English mirror of `zh/chat-stream.ts`. */
export const en = {
  // ── MessageTimeline ──
  "chatStream.timeline.current": "Current",
  "chatStream.timeline.noText": "(no text)",
  "chatStream.timeline.attachmentLine": "[Attachment] {text}",

  // ── MessageRow: user prompt overflow (5-line collapse) ──
  "chatStream.userMsg.expand": "Expand",
  "chatStream.userMsg.collapse": "Collapse",

  // ── MessageBlocks: batch tool group ──
  "chatStream.opCount": "{n} operations",

  // ── Chat stream · Plan A (spine): turn summary / reply mark ──
  "chatStream.stepCount": "{n} steps",
  "chatStream.filesChanged": "{n} files changed",
  "chatStream.waitingModel": "Waiting for model…",

  // ── Running ledger (borderless form) header ──
  "chatStream.ledgerRunning": "Running",
  "chatStream.tokensUsed": "{n} tokens",
  "chatStream.filesChangedShort": "{n} files",

  // ── RenderErrorBoundary: per-segment render-failure fallback ──
  "chatStream.renderError": "This item failed to render and was skipped (everything else is unaffected)",

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
  "chatStream.attachment.externalTitle": "Can't view external file",
  "chatStream.attachment.externalBody": "This file is outside every project and worktree, so the app can't read it.",
  "chatStream.attachment.stackSummary": "Contains {n} attachments",
  "chatStream.attachment.collapse": "Collapse",
  "chatStream.attachment.expandTooltip": "Click to expand all {n} attachments",
  "chatStream.attachment.openInIde": "Open in editor",
  "chatStream.attachment.typeCode": "File",
  "chatStream.attachment.typePaste": "Clipboard snippet",
  "chatStream.attachment.typeImage": "Image",

  // ── Markdown ──
  "chatStream.copyCode": "Copy code",
  "chatStream.code.expand": "Expand",
  "chatStream.code.collapse": "Collapse",

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

  // ── Activity rail + console (chat right edge) ──
  "chatStream.activity.close": "Close",
  "chatStream.activity.now": "now",
  "chatStream.activity.emptyGroup": "Nothing in this filter",
  "chatStream.activity.tabAll": "All",
  // Collapsing cluster (方案 B) — round button + urgency-grown text bar
  "chatStream.activity.cluster.aria": "Activity",
  "chatStream.activity.cluster.running": "{n} subagents running",
  "chatStream.activity.cluster.commands": "{n} commands running",
  "chatStream.activity.cluster.services": "{n} services running",
  "chatStream.activity.cluster.failed": "{n} subagents failed",
  "chatStream.activity.cluster.waiting": "Waiting for your answer",
  "chatStream.activity.cluster.tasks": "Tasks {done}/{total}",
  "chatStream.activity.cluster.plans": "{n} plans",
  "chatStream.activity.cluster.noPlans": "No plans",
  "chatStream.activity.cluster.openPlans": "Open plans",
  // Apple HIG style Control Deck & Dynamic Island
  "chatStream.activity.deck.title": "Session Control Deck",
  "chatStream.activity.deck.escHint": "ESC to close",
  "chatStream.activity.deck.liveServices": "Live Services",
  "chatStream.activity.deck.commandsAndAgents": "Commands & Subagents",
  "chatStream.activity.deck.todos": "Task Progress",
  "chatStream.activity.deck.assets": "Session Assets",
  "chatStream.activity.deck.allSettled": "All Settled",
  "chatStream.activity.deck.shortServices": "{n} services",
  "chatStream.activity.deck.shortCommands": "{n} cmds",
  "chatStream.activity.deck.shortAgents": "{n} agents",
  "chatStream.activity.deck.shortPlans": "{n} plans",
  "chatStream.activity.deck.shortBookmarks": "{n} bookmarks",
  "chatStream.activity.deck.viewFull": "View Full Details",
  "chatStream.activity.deck.sched": "Scheduled Tasks",
  "chatStream.activity.deck.schedSubtitle": "{total} scheduled · {running} in progress",
  "chatStream.activity.deck.schedSubtitleIdle": "{n} scheduled tasks",
  "chatStream.activity.deck.schedInFlight": "{n} running",
  "chatStream.activity.deck.schedNext": "Next: {time}",
  "chatStream.activity.deck.schedEmpty": "No scheduled tasks",
  "chatStream.activity.deck.openSched": "Manage",
  "chatStream.activity.deck.newSched": "+ New",
  "chatStream.activity.cluster.schedRunning": "Scheduled task running",
  // Node names (console header / node tab strip)
  "chatStream.activity.node.overview": "Overview",
  "chatStream.activity.node.tasks": "Tasks",
  "chatStream.activity.node.subagents": "Subagents",
  "chatStream.activity.node.commands": "Commands",
  "chatStream.activity.node.services": "Services",
  "chatStream.activity.node.plans": "Plans",
  "chatStream.activity.node.bookmarks": "Bookmarks",
  "chatStream.activity.node.sched": "Scheduled",
  // Group headers and filter chips
  "chatStream.activity.groupRunning": "Running",
  "chatStream.activity.groupSettled": "Settled",
  "chatStream.activity.groupCompleted": "Completed",
  "chatStream.activity.groupFailed": "Failed",
  "chatStream.activity.groupInProgress": "In progress",
  "chatStream.activity.groupPending": "Pending",
  "chatStream.activity.groupToday": "Today",
  "chatStream.activity.groupEarlier": "Earlier",
  "chatStream.activity.groupStale": "Stale",
  // Subagents panel
  "chatStream.activity.subagentsSubRunning": "{running} running · {ended} settled",
  "chatStream.activity.subagentsSubIdle": "{n} · all settled",
  "chatStream.activity.unitAgents": "total",
  "chatStream.activity.labelRunning": "running",
  "chatStream.activity.labelCumulative": "total",
  "chatStream.activity.subagentsFooter": "Bars are each agent's real span; running ones reach “now”",
  "chatStream.activity.noDescription": "(no description)",
  "chatStream.activity.viewSubagent": "View subagent transcript",
  // Tasks panel
  "chatStream.activity.tasksSubtitle": "{done}/{total} done · {rest} left",
  "chatStream.activity.tasksDoneSuffix": "done",
  "chatStream.activity.tasksRest": "{n} left",
  "chatStream.activity.tasksFooter": "This node hides itself once every task is done",
  "chatStream.activity.priorityHigh": "High",
  "chatStream.activity.priorityMedium": "Med",
  "chatStream.activity.priorityLow": "Low",
  // Plans panel
  "chatStream.activity.plansSubtitle": "{n} plans, newest first",
  "chatStream.activity.unitPlans": "plans",
  "chatStream.activity.latestChip": "Latest",
  "chatStream.activity.openPlan": "Open",
  "chatStream.activity.plansFooter": "Click any plan to open it in the plan panel",
  "chatStream.activity.planFallback": "(Plan {n})",
  "chatStream.activity.viewPlan": "Click to view the full plan",
  // Bookmarks panel
  "chatStream.activity.bookmarksSub": "{n} bookmarks",
  "chatStream.activity.bookmarksSubStale": "{n} · {stale} stale",
  "chatStream.activity.unitBookmarks": "total",
  "chatStream.activity.bookmarksFooter": "Select text to add one; stale bookmarks are dimmed, never deleted",
  "chatStream.subagent.statusRunning": "Running",
  "chatStream.subagent.statusCompleted": "Completed",
  "chatStream.subagent.statusFailed": "Failed",
  "chatStream.subagent.statusKilled": "Terminated",

  // ── Agent-started bash commands (activity「Commands」node) ──
  "chatStream.bashTask.statusRunning": "Running",
  "chatStream.bashTask.statusCompleted": "Completed",
  "chatStream.bashTask.statusFailed": "Failed",
  "chatStream.bashTask.statusKilled": "Stopped",
  "chatStream.bashTask.backgrounded": "BG",
  "chatStream.bashTask.noCommand": "(unknown command)",
  "chatStream.bashTask.stop": "Stop",
  "chatStream.bashTask.stopTitle": "Stop this command (the turn continues)",
  "chatStream.bashTask.stopFailed": "Failed to stop command",
  "chatStream.bashTask.subRunning": "{running} running · {total} total",
  "chatStream.bashTask.subIdle": "{n} · all settled",
  "chatStream.bashTask.unitCommands": "total",
  "chatStream.bashTask.footer": "Commands the agent started via the Bash tool (services, scripts); they are killed when the app quits",

  // ── Agent-started services (activity「Services」node, port-scan discovered) ──
  "chatStream.service.statusRunning": "Running",
  "chatStream.service.stop": "Stop",
  "chatStream.service.stopTitle": "Stop the service listening on port {port} (its whole process tree)",
  "chatStream.service.stopFailed": "Failed to stop service",
  "chatStream.service.open": "Open",
  "chatStream.service.openTitle": "Open http://localhost:{port} in the in-app browser",
  "chatStream.service.subRunning": "{n} services listening",
  "chatStream.service.unitServices": "total",
  "chatStream.service.unitPorts": "ports",
  "chatStream.service.footer": "Services the agent started that are listening on a port; stopping kills their whole process tree",

  // ── Message bookmarks (selection toolbar / capsule / timeline) ──
  "chatStream.bookmark.add": "Add bookmark",
  "chatStream.bookmark.askSideChat": "Send to sub-session",
  "chatStream.bookmark.copied": "Copied",
  "chatStream.bookmark.capsuleTitle": "Bookmarks ({n})",
  "chatStream.bookmark.sectionTitle": "Bookmarks · {n}",
  "chatStream.bookmark.jumpTitle": "Click to jump to the message",
  "chatStream.bookmark.remove": "Remove bookmark",
  "chatStream.bookmark.rename": "Rename bookmark",
  "chatStream.bookmark.renamePlaceholder": "Bookmark name",
  "chatStream.bookmark.stale": "Message removed",
  "chatStream.bookmark.addedToast": "Bookmark added",

  // ── ChatPane: streaming spinner hint ──
  "chatStream.upstreamRetry": "Upstream connection issue — retrying ({attempt}/{attempts})",

  // ── MessageBlocks: turn-incomplete warning card ──
  "chatStream.turnIncomplete.title": "Task ended early",
  "chatStream.turnIncomplete.danglingDesc":
    "The model channel returned an empty response mid-task, so this turn ended unfinished. Send “Continue” to resume from where it stopped.",
  "chatStream.turnIncomplete.emptyDesc":
    "The model channel returned no reply text this turn. Try resending or switching models.",
  "chatStream.turnIncomplete.unfinishedDesc":
    "The model's final text stops mid-sentence — the next step it announced never ran. Send “Continue” to resume from where it stopped.",
  "chatStream.turnIncomplete.pendingTools": "Unfinished calls: {tools}",

  // ── MessageBlocks: ExitPlanMode approval-channel failure ──
  "chatStream.planApprovalBroken.title": "Plan approval prompt failed to show",
  "chatStream.planApprovalBroken.desc":
    "The approval request broke in transit (not a user rejection). The plan is usually saved to the plan file — reply to approve it or request changes.",

  // ── EmptyThreadWelcome ──
  "chatStream.welcome.title": "Start a new chat",
  "chatStream.welcome.withProject": "Start a new chat in {name}",
  "chatStream.welcome.todayUsage": "{turns} turns today · {tokens} tokens used",
} as const;
