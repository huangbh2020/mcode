/**
 * IPC handler for opening a path in the OS file manager.
 *
 * Three channels:
 *  - `shell:openPath`           - open a workspace root folder itself. The path
 *    MUST be an exact match (after normalization) for a known project root or
 *    a materialized session worktree root.
 *  - `shell:showItemInFolder`   - reveal a file or sub-directory inside a
 *    workspace root, selecting it in Finder/Explorer. The path MUST resolve
 *    inside (or equal) a workspace root - the same containment rule the file
 *    handlers use (`findContainingWorkspaceRoot`).
 *  - `shell:showImageInFolder`  - reveal a chat image (the one the user is
 *    looking at in the lightbox). Takes the displayed *bytes*, never a path:
 *    main resolves them to the artifact it saved earlier or to a deduped cache
 *    copy (see `lib/imageArtifacts.ts`), so this surface cannot be pointed at
 *    an arbitrary location at all.
 *
 * We never let the renderer open arbitrary locations - only paths under
 * workspace roots (projects ∪ session worktrees; a worktree checkout sits
 * OUTSIDE every project root by design, yet its file tree / editor operate
 * there). A refused or failing call logs and resolves (no throw into the
 * renderer).
 */
import type { IpcMain } from "electron";
import { shell } from "electron";
import {
  IPC,
  OpenPathSchema,
  ShowItemInFolderSchema,
  OpenFileSchema,
  ShowImageInFolderSchema,
} from "@contracts/ipc";
import {
  isKnownWorkspaceRoot,
  findContainingWorkspaceRoot,
} from "@main/lib/pathGuard.js";
import { revealImageInFolder } from "@main/lib/imageArtifacts.js";
import { log } from "@main/lib/logger.js";

export function registerShellHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.SHELL_OPEN_PATH, async (_evt, raw) => {
    const input = OpenPathSchema.parse(raw);
    // Only allow opening a directory that is an exact match for a workspace
    // root (project root or session worktree checkout).
    if (!isKnownWorkspaceRoot(input.path)) {
      log.warn(`shell.openPath refused (not a workspace root): ${input.path}`);
      return;
    }
    // openPath returns an error string on failure ("" on success).
    const err = await shell.openPath(input.path);
    if (err) {
      log.warn(`shell.openPath failed for "${input.path}": ${err}`);
    }
  });

  ipcMain.handle(IPC.SHELL_SHOW_ITEM_IN_FOLDER, async (_evt, raw) => {
    const input = ShowItemInFolderSchema.parse(raw);
    // Accept any path that resolves inside a workspace root (or equals it).
    // This lets the file-tree context menu reveal individual files/sub-dirs —
    // including worktree sessions, whose checkout lives outside every project
    // root — while still refusing anything outside a workspace.
    if (!findContainingWorkspaceRoot(input.path)) {
      log.warn(`shell.showItemInFolder refused (outside workspace root): ${input.path}`);
      return;
    }
    // showItemInFolder opens the containing folder and selects the item. It
    // has no error return; on failure the OS simply does nothing.
    shell.showItemInFolder(input.path);
  });

  ipcMain.handle(IPC.SHELL_OPEN_FILE, async (_evt, raw) => {
    const input = OpenFileSchema.parse(raw);
    // Same containment rule as showItemInFolder: the path must resolve inside
    // a workspace root. This lets the editor's unsupported file pane open
    // .docx/.pdf/etc. in the OS default app without letting the renderer open
    // arbitrary locations.
    if (!findContainingWorkspaceRoot(input.path)) {
      log.warn(`shell.openFile refused (outside workspace root): ${input.path}`);
      return;
    }
    // openPath opens a file with its default application (or the folder in
    // the file manager for a directory). Returns an error string on failure.
    const err = await shell.openPath(input.path);
    if (err) {
      log.warn(`shell.openFile failed for "${input.path}": ${err}`);
    }
  });

  ipcMain.handle(IPC.SHELL_SHOW_IMAGE_IN_FOLDER, async (_evt, raw) => {
    // No path containment check here on purpose: the renderer cannot name a
    // path at all. It sends the bytes it is displaying, and main only ever
    // reveals a file it wrote itself (the screenshot/image-generation
    // artifact, or a cache copy of those same bytes).
    const input = ShowImageInFolderSchema.parse(raw);
    return revealImageInFolder(input.dataUrl);
  });
}
