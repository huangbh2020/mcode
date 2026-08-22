/**
 * Small shared value-formatting helpers (bytes, rates).
 *
 * Extracted from AboutPanel so the global update notification card can render
 * the same "12.3 MB / 45.6 MB · 1.2 MB/s" style byte/speed readouts.
 */

/** Format a byte count as a human-readable string (e.g. "12.3 MB"). */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Format a transfer speed in bytes/second (e.g. "1.2 MB/s"). */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}
