import { useMemo } from "react";
import { cn } from "@renderer/lib/cn.js";
import { formatPathWithMaxDirs } from "@renderer/lib/path.js";

/**
 * Compact display for tool file paths:
 * Displays the filename on the left, followed by a gap, and the directory structure
 * clamped to at most 5 levels.
 * Full path is preserved on hover via the title attribute.
 */
export function ToolPathDisplay({
  filePath,
  maxDirs = 5,
  className,
  highlightFileName = false,
}: {
  filePath: string;
  maxDirs?: number;
  className?: string;
  highlightFileName?: boolean;
}) {
  const { fileName, dirDisplay, fullPath } = useMemo(
    () => formatPathWithMaxDirs(filePath, maxDirs),
    [filePath, maxDirs],
  );

  return (
    <span
      className={cn("inline-flex min-w-0 max-w-full items-baseline gap-1.5 overflow-hidden font-mono", className)}
      title={fullPath}
    >
      <span
        className={cn(
          "shrink-0 font-medium",
          highlightFileName ? "text-accent-strong" : "text-content",
        )}
      >
        {fileName}
      </span>
      {dirDisplay && (
        <span className="min-w-0 truncate text-content-subtle">
          {dirDisplay}
        </span>
      )}
    </span>
  );
}
