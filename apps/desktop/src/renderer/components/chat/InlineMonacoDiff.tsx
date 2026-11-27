import { useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import "@renderer/lib/monacoSetup.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { extname } from "@renderer/lib/path.js";
import { analyzeCompactDiff } from "@renderer/lib/lineDiff.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useMonacoTheme, languageForExt } from "@renderer/components/ide/FileEditor.js";
import { IconArrowsSplit, IconExternalLink, IconSquare } from "@renderer/lib/icons.js";
import { DiffView } from "./DiffView.js";

const DIFF_CONTEXT_LINES = 3;

/**
 * Compact Git-style Monaco DiffEditor embedded inside chat tool drawers.
 * Defaults to side-by-side comparison (`renderSideBySide: true`) with
 * `hideUnchangedRegions` enabled so only changed locations (+3 context lines)
 * are shown instead of dumping the entire file.
 */
export default function InlineMonacoDiff({
  filePath,
  original,
  modified,
  label,
  onOpenInEditor,
  heightPx,
}: {
  filePath: string;
  original: string;
  modified: string;
  label?: string;
  onOpenInEditor?: () => void;
  heightPx?: number;
}) {
  const { t } = useI18n();
  const theme = useMonacoTheme();
  const diffShowLineNumbers = useSessionStore((s) => s.diffShowLineNumbers);
  const setDiffShowLineNumbers = useSessionStore((s) => s.setDiffShowLineNumbers);
  const [splitMode, setSplitMode] = useState(true);
  const [changesOnly, setChangesOnly] = useState(true);

  const editorRef = useRef<import("monaco-editor").editor.IDiffEditor | null>(null);
  const modelsRef = useRef<{
    original: import("monaco-editor").editor.ITextModel | null;
    modified: import("monaco-editor").editor.ITextModel | null;
  }>({ original: null, modified: null });
  const didRevealRef = useRef(false);

  const language = useMemo(() => languageForExt(extname(filePath)), [filePath]);

  const { diff: fallbackDiff, adds, dels, visibleLines, hasCollapsibleContext } = useMemo(
    () => analyzeCompactDiff(original, modified, DIFF_CONTEXT_LINES),
    [original, modified],
  );

  const autoHeight = useMemo(() => {
    if (heightPx !== undefined) return heightPx;
    if (!changesOnly) {
      const total = Math.max(original.split("\n").length, modified.split("\n").length);
      return Math.min(420, Math.max(140, total * 19 + 18));
    }
    return Math.min(380, Math.max(110, visibleLines * 19 + 24));
  }, [heightPx, changesOnly, original, modified, visibleLines]);

  useEffect(() => {
    didRevealRef.current = false;
  }, [filePath, original, modified]);

  useEffect(() => {
    return () => {
      // Dispose the DiffEditor widget BEFORE its TextModels to avoid
      // @monaco-editor/react's model-disposed-before-widget race.
      const editor = editorRef.current;
      const { original: origModel, modified: modModel } = modelsRef.current;
      editorRef.current = null;
      modelsRef.current = { original: null, modified: null };
      if (editor) {
        try {
          editor.dispose();
        } catch {
          // already disposed
        }
      }
      try {
        origModel?.dispose();
      } catch {
        // ignore
      }
      try {
        modModel?.dispose();
      } catch {
        // ignore
      }
    };
  }, []);

  if (original === modified) {
    return (
      <div className="rounded border border-edge/60 bg-surface-card p-2 text-content-subtle [font-size:var(--chat-fs-xs)]">
        {t("chatStream.diff.noChanges")}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-edge/70 bg-surface-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge/60 bg-surface-muted/40 px-2 py-1 [font-size:var(--chat-fs-xxs)]">
        <div className="flex min-w-0 items-center gap-2">
          {label && <span className="truncate text-content-muted">{label}</span>}
          <span className="flex shrink-0 items-center gap-1 font-mono">
            {adds > 0 && <span className="text-success">+{adds}</span>}
            {dels > 0 && <span className="text-danger">−{dels}</span>}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasCollapsibleContext && (
            <button
              type="button"
              onClick={() => setChangesOnly((v) => !v)}
              className={cn(
                "rounded border px-1.5 py-0.5 transition-colors",
                changesOnly
                  ? "border-accent/40 bg-accent/15 font-medium text-accent"
                  : "border-edge/70 bg-surface text-content-muted hover:text-content",
              )}
            >
              {t("chatStream.diff.changesOnly")}
            </button>
          )}
          <div className="flex items-center overflow-hidden rounded border border-edge/70 bg-surface">
            <button
              type="button"
              onClick={() => setSplitMode(true)}
              className={cn(
                "flex items-center gap-1 px-1.5 py-0.5 transition-colors",
                splitMode ? "bg-accent/15 font-medium text-accent" : "text-content-muted hover:text-content",
              )}
              title={t("ide.git.splitView")}
            >
              <IconArrowsSplit size={10} />
              <span>{t("ide.git.splitView")}</span>
            </button>
            <button
              type="button"
              onClick={() => setSplitMode(false)}
              className={cn(
                "flex items-center gap-1 border-l border-edge/60 px-1.5 py-0.5 transition-colors",
                !splitMode ? "bg-accent/15 font-medium text-accent" : "text-content-muted hover:text-content",
              )}
              title={t("ide.git.unifiedView")}
            >
              <IconSquare size={10} />
              <span>{t("ide.git.unifiedView")}</span>
            </button>
          </div>
          <button
            type="button"
            onClick={() => setDiffShowLineNumbers(!diffShowLineNumbers)}
            className={cn(
              "rounded border px-1.5 py-0.5 transition-colors",
              diffShowLineNumbers
                ? "border-accent/40 bg-accent/15 font-medium text-accent"
                : "border-edge/70 bg-surface text-content-muted hover:text-content",
            )}
            title={diffShowLineNumbers ? t("ide.git.hideLineNumbers") : t("ide.git.showLineNumbers")}
          >
            {t("ide.git.lineNumbers")}
          </button>
          {onOpenInEditor && (
            <button
              type="button"
              onClick={onOpenInEditor}
              title={t("chatStream.turnFiles.reviewDiff")}
              className="flex items-center gap-1 rounded border border-edge/70 bg-surface px-1.5 py-0.5 text-content-muted transition-colors hover:border-accent/40 hover:text-accent"
            >
              <IconExternalLink size={10} />
              <span>{t("chatStream.turnFiles.reviewDiff")}</span>
            </button>
          )}
        </div>
      </div>

      <div style={{ height: `${autoHeight}px` }} className="w-full overflow-hidden">
        <DiffEditor
          height="100%"
          language={language}
          original={original}
          modified={modified}
          theme={theme}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          loading={<DiffView diff={fallbackDiff} scrollClassName="h-full" />}
          onMount={(editor) => {
            editorRef.current = editor;
            modelsRef.current = {
              original: editor.getOriginalEditor().getModel(),
              modified: editor.getModifiedEditor().getModel(),
            };
            const revealFirst = () => {
              if (didRevealRef.current) return;
              const changes = editor.getLineChanges();
              if (changes && changes.length > 0) {
                didRevealRef.current = true;
                editor.getModifiedEditor().revealLineInCenterIfOutsideViewport(changes[0].modifiedStartLineNumber);
              }
            };
            revealFirst();
            editor.onDidUpdateDiff(revealFirst);
          }}
          options={{
            readOnly: true,
            renderSideBySide: splitMode,
            useInlineViewWhenSpaceIsLimited: false,
            hideUnchangedRegions: {
              enabled: changesOnly,
              contextLineCount: DIFF_CONTEXT_LINES,
              minimumLineCount: 3,
              revealLineCount: 20,
            },
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            glyphMargin: false,
            folding: false,
            renderOverviewRuler: false,
            lineNumbers: diffShowLineNumbers ? "on" : "off",
            lineDecorationsWidth: diffShowLineNumbers ? 8 : 0,
            lineNumbersMinChars: diffShowLineNumbers ? 3 : 1,
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          }}
        />
      </div>
    </div>
  );
}
