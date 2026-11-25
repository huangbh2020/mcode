import { useMemo } from "react";
import { cn } from "@renderer/lib/cn.js";
import { formatPathWithMaxDirs } from "@renderer/lib/path.js";

/**
 * Compact display for tool file paths:
 * Displays only the filename; full path is preserved on hover via the title attribute.
 */
export function ToolPathDisplay({
  filePath,
  maxDirs = 5,
  className,
  highlightFileName = true,
}: {
  filePath: string;
  maxDirs?: number;
  className?: string;
  highlightFileName?: boolean;
}) {
  const { fileName, fullPath } = useMemo(
    () => formatPathWithMaxDirs(filePath, maxDirs),
    [filePath, maxDirs],
  );

  return (
    <span
      className={cn("inline-flex min-w-0 max-w-full items-baseline overflow-hidden font-mono", className)}
      title={fullPath}
    >
      <span
        className={cn(
          "truncate font-medium",
          highlightFileName ? "text-accent-strong" : "text-content",
        )}
      >
        {fileName}
      </span>
    </span>
  );
}
