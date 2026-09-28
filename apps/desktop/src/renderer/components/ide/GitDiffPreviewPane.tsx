import { useState, useEffect, useRef, useCallback } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { joinPath, extname, basename } from "@renderer/lib/path.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useMonacoTheme, languageForExt } from "./FileEditor.js";
import { lineDiff, diffSummary } from "@renderer/lib/lineDiff.js";
import { Button, Dialog } from "@renderer/components/ui/index.js";
import {
  IconGitBranch,
  IconGitCommit,
  IconLoader2,
  IconArrowsSplit,
  IconSquare,
  IconCheck,
  IconX,
  IconAlertTriangle,
  IconTrash,
  IconPlus,
  IconMinus,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

function parsePatchToBeforeAfter(patch: string): { before: string; after: string } {
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  const lines = patch.split("\n");
  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("@@")) continue;
    if (line.startsWith("-")) {
      beforeLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      afterLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      const text = line.slice(1);
      beforeLines.push(text);
      afterLines.push(text);
    }
  }
  return {
    before: beforeLines.join("\n"),
    after: afterLines.join("\n"),
  };
}

export function GitDiffPreviewPane() {
  const { t } = useI18n();
  const selected = useSessionStore((s) => s.selectedGitDiffFile);
  const setSelected = useSessionStore((s) => s.setSelectedGitDiffFile);
  const diffShowLineNumbers = useSessionStore((s) => s.diffShowLineNumbers);
  const setDiffShowLineNumbers = useSessionStore((s) => s.setDiffShowLineNumbers);

  const [splitMode, setSplitMode] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);
  const [before, setBefore] = useState<string>("");
  const [after, setAfter] = useState<string>("");
  const [diffTally, setDiffTally] = useState<{ adds: number; dels: number } | null>(null);
  const [busy, setBusy] = useState<"stage" | "unstage" | "discard" | null>(null);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);

  const theme = useMonacoTheme();
  const filePath = selected?.filePath ?? "";
  const language = languageForExt(extname(filePath));

  // Keep track of load requests to prevent stale responses
  const activeReqRef = useRef(0);

  const loadDiff = useCallback(async () => {
    if (!selected) {
      setBefore("");
      setAfter("");
      setDiffTally(null);
      setLoading(false);
      return;
    }

    const reqId = ++activeReqRef.current;
    setLoading(true);

    try {
      const { repoPath, filePath, staged } = selected;
      const absPath = joinPath(repoPath, filePath);

      // Async tally calculation
      api.git
        .diff({ repoPath, filePath, staged })
        .then(({ patch }) => {
          if (activeReqRef.current !== reqId || !patch) return;
          const { before: b, after: a } = parsePatchToBeforeAfter(patch);
          const diff = lineDiff(b, a);
          setDiffTally(diffSummary(diff));
        })
        .catch(() => {});

      let beforeContent = "";
      let afterContent = "";

      if (staged) {
        const [headRes, indexRes] = await Promise.allSettled([
          api.git.fileBlob({ repoPath, filePath, side: "HEAD" }),
          api.git.fileBlob({ repoPath, filePath, side: "index" }),
        ]);
        beforeContent = headRes.status === "fulfilled" ? headRes.value.content : "";
        afterContent = indexRes.status === "fulfilled" ? indexRes.value.content : "";
      } else {
        // Unstaged: before is git index, after is working tree on disk
        try {
          const indexRes = await api.git.fileBlob({ repoPath, filePath, side: "index" });
          beforeContent = indexRes.content;
        } catch {
          beforeContent = "";
        }

        try {
          const fileRes = await api.file.readFile({ filePath: absPath });
          afterContent = fileRes.content;
        } catch {
          afterContent = "";
        }
      }

      if (activeReqRef.current === reqId) {
        setBefore(beforeContent);
        setAfter(afterContent);
      }
    } catch {
      if (activeReqRef.current === reqId) {
        setBefore("");
        setAfter("");
      }
    } finally {
      if (activeReqRef.current === reqId) {
        setLoading(false);
      }
    }
  }, [selected]);

  useEffect(() => {
    void loadDiff();
  }, [loadDiff]);

  const handleStage = async () => {
    if (!selected || busy) return;
    setBusy("stage");
    try {
      const res = await api.git.stage({
        repoPath: selected.repoPath,
        filePaths: [selected.filePath],
      });
      if (res.ok) {
        setSelected({ ...selected, staged: true });
        useSessionStore.getState().bumpGitStatusNonce();
      }
    } finally {
      setBusy(null);
    }
  };

  const handleUnstage = async () => {
    if (!selected || busy) return;
    setBusy("unstage");
    try {
      const res = await api.git.unstage({
        repoPath: selected.repoPath,
        filePaths: [selected.filePath],
      });
      if (res.ok) {
        setSelected({ ...selected, staged: false });
        useSessionStore.getState().bumpGitStatusNonce();
      }
    } finally {
      setBusy(null);
    }
  };

  const handleDiscardConfirm = async () => {
    if (!selected || busy) return;
    setBusy("discard");
    try {
      const absPath = joinPath(selected.repoPath, selected.filePath);
      const res = await api.git.discard({
        repoPath: selected.repoPath,
        filePaths: [absPath],
      });
      if (res.ok) {
        setSelected(null);
        useSessionStore.getState().bumpGitStatusNonce();
      }
    } finally {
      setBusy(null);
      setDiscardDialogOpen(false);
    }
  };

  if (!selected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2.5 p-6 text-center select-none">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-muted text-content-subtle">
          <IconGitBranch size={24} />
        </div>
        <p className="text-xs font-medium text-content-muted">{t("ide.git.noDiffSelected")}</p>
        <p className="max-w-[320px] text-[11px] leading-relaxed text-content-subtle">
          {t("ide.git.noDiffSelectedHint")}
        </p>
      </div>
    );
  }

  const filename = basename(selected.filePath);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface">
      {/* ── Stage Header ── */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-edge bg-surface-muted/40 px-3 gap-2">
        {/* Left: repo badge + path + staged pill */}
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <span
            className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent truncate max-w-[130px]"
            title={selected.repoPath}
          >
            {selected.repoName}
          </span>
          <span
            className="truncate font-mono text-[11px] font-medium text-content"
            title={selected.filePath}
          >
            {selected.filePath}
          </span>
          {selected.staged ? (
            <span className="shrink-0 rounded border border-success/30 bg-success/15 px-1 py-0.2 text-[9px] font-medium text-success">
              {t("ide.git.staged")}
            </span>
          ) : (
            <span className="shrink-0 rounded border border-warning/30 bg-warning/15 px-1 py-0.2 text-[9px] font-medium text-warning">
              {t("ide.git.changes")}
            </span>
          )}
          {diffTally && (diffTally.adds > 0 || diffTally.dels > 0) && (
            <span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums ml-1">
              {diffTally.adds > 0 && <span className="text-success font-medium">+{diffTally.adds}</span>}
              {diffTally.dels > 0 && <span className="text-danger font-medium">−{diffTally.dels}</span>}
            </span>
          )}
        </div>

        {/* Right: view mode toggle & actions */}
        <div className="flex shrink-0 items-center gap-1">
          {/* Split / Unified toggle */}
          <div className="flex items-center rounded border border-edge bg-surface p-0.5">
            <button
              type="button"
              onClick={() => setSplitMode(true)}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors",
                splitMode
                  ? "bg-accent text-surface font-medium"
                  : "text-content-muted hover:text-content",
              )}
              title={t("ide.git.splitView")}
            >
              <IconArrowsSplit size={11} />
              <span>{t("ide.git.splitView")}</span>
            </button>
            <button
              type="button"
              onClick={() => setSplitMode(false)}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors",
                !splitMode
                  ? "bg-accent text-surface font-medium"
                  : "text-content-muted hover:text-content",
              )}
              title={t("ide.git.unifiedView")}
            >
              <IconSquare size={11} />
              <span>{t("ide.git.unifiedView")}</span>
            </button>
          </div>

          {/* Line numbers toggle */}
          <button
            type="button"
            onClick={() => setDiffShowLineNumbers(!diffShowLineNumbers)}
            className={cn(
              "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors",
              diffShowLineNumbers
                ? "border-accent/40 bg-accent/15 text-accent font-medium"
                : "border-edge bg-surface text-content-muted hover:text-content",
            )}
            title={diffShowLineNumbers ? t("ide.git.hideLineNumbers") : t("ide.git.showLineNumbers")}
          >
            <span>{t("ide.git.lineNumbers")}</span>
          </button>

          <div className="h-3.5 w-px bg-edge mx-0.5" />

          {/* Staged: Unstage action */}
          {selected.staged ? (
            <button
              type="button"
              onClick={handleUnstage}
              disabled={busy !== null}
              title={t("ide.git.unstageFile")}
              className="flex items-center gap-1 rounded border border-edge bg-surface px-2 py-0.5 text-[11px] text-content-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {busy === "unstage" ? <IconLoader2 size={11} className="animate-spin" /> : <IconMinus size={11} />}
              <span>{t("ide.git.unstage")}</span>
            </button>
          ) : (
            <>
              {/* Unstaged: Stage & Discard action */}
              <button
                type="button"
                onClick={handleStage}
                disabled={busy !== null}
                title={t("ide.git.stageFile")}
                className="flex items-center gap-1 rounded border border-edge bg-surface px-2 py-0.5 text-[11px] text-content-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {busy === "stage" ? <IconLoader2 size={11} className="animate-spin" /> : <IconPlus size={11} />}
                <span>{t("ide.git.stage")}</span>
              </button>
              <button
                type="button"
                onClick={() => setDiscardDialogOpen(true)}
                disabled={busy !== null}
                title={t("ide.git.discard")}
                className="flex items-center gap-1 rounded border border-edge bg-surface p-1 text-[11px] text-content-subtle transition-colors hover:border-danger/40 hover:bg-danger/10 hover:text-danger disabled:opacity-50"
              >
                <IconTrash size={11} />
              </button>
            </>
          )}

          {/* Close diff preview */}
          <button
            type="button"
            onClick={() => setSelected(null)}
            title={t("ide.git.closeDiff")}
            className="flex h-6 w-6 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
          >
            <IconX size={13} />
          </button>
        </div>
      </div>

      {/* ── Monaco Diff Editor Body ── */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-content-subtle">
            <IconLoader2 size={14} className="animate-spin" />
            <span>{t("ide.editor.loadingDiff")}</span>
          </div>
        ) : (
          <DiffEditor
            height="100%"
            language={language}
            original={before}
            modified={after}
            theme={theme}
            options={{
              readOnly: true,
              renderSideBySide: splitMode,
              useInlineViewWhenSpaceIsLimited: false,
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              glyphMargin: false,
              lineNumbers: diffShowLineNumbers ? "on" : "off",
              lineDecorationsWidth: diffShowLineNumbers ? 8 : 0,
              lineNumbersMinChars: diffShowLineNumbers ? 3 : 1,
            }}
          />
        )}
      </div>

      {/* ── Discard Confirmation Dialog ── */}
      <Dialog.Root open={discardDialogOpen} onOpenChange={setDiscardDialogOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[360px] max-w-[90vw] p-4">
            <div className="flex items-start gap-3 pr-6">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
                <IconAlertTriangle size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <Dialog.Title>{t("ide.git.discardQ")}</Dialog.Title>
                <Dialog.Description className="mt-1 text-xs text-content-subtle">
                  {t("ide.git.discardDesc", { n: 1 })} ({filename})
                </Dialog.Description>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDiscardDialogOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" size="sm" onClick={handleDiscardConfirm} disabled={busy !== null}>
                {busy === "discard" ? <IconLoader2 size={12} className="animate-spin" /> : <IconTrash size={12} />}
                {t("ide.git.discard")}
              </Button>
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
