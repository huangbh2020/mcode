/** Convert a local filesystem path into a `file://` URL that Electron's
 *  `webContents.loadURL` can open natively. Handles Windows drive paths
 *  (`C:\\…` / `C:/…`) and Unix absolute paths (`/…`). Backslashes are
 *  normalised to forward slashes and non-URL-safe characters (spaces, CJK,
 *  etc.) are percent-encoded so paths with spaces or Chinese characters load
 *  correctly.
 *
 *  Caller is expected to have already determined the input is a local path
 *  (e.g. starts with a drive letter or `/`); this helper does the encoding. */
export function localPathToFileUrl(p: string): string {
  const norm = p.trim().replace(/\\/g, "/");
  // Windows drive path → file:///C:/…
  if (/^[a-z]:\//i.test(norm)) return `file:///${encodeURI(norm)}`;
  // Unix absolute path → file:///foo (file:// + /foo)
  return `file://${encodeURI(norm)}`;
}
