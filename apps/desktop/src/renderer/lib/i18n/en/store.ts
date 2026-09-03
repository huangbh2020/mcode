/** English mirror of `zh/store.ts`. */
export const en = {
  // ── event-ingest toasts (sessionStore.ingestEvent → pushToast) ──
  "store.toast.backgroundTaskDone": "Background task finished",
  "store.toast.backgroundTaskDoneBody": "A subagent task has finished",
  "store.toast.agentQuestion": "The agent has a question for you",
  "store.toast.toolApprovalNeeded": "Tool call needs approval",
  "store.toast.planApprovalPending": "Plan awaiting approval",
  "store.toast.planApprovalPendingBody": "Review and approve the plan",
  "store.toast.errorOccurred": "Error occurred",
  "store.toast.turnComplete": "Turn complete",
  "store.toast.turnCompleteBody": "The agent has finished this turn",
  "store.toast.turnIncomplete": "Task ended early",
  // ── send-time model guard (sessionStore.raiseModelGuard) ──
  "store.toast.selectModelFirst": "Select a model first",
  "store.toast.selectModelFirstBody": "Pick a model from the composer's model picker before sending",
} as const;
