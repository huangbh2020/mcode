import type { IpcMain } from "electron";
import {
  IPC,
  CreateProjectSchema,
  DeleteProjectSchema,
  ArchiveProjectSchema,
  SetProjectGroupSchema,
  ReorderProjectsSchema,
  PinProjectSchema,
  RenameProjectSchema,
  DeleteSessionSchema,
  ArchiveSessionSchema,
  PinSessionSchema,
  ProjectSessionsSchema,
  SessionListAllSchema,
  RenameSessionSchema,
  SessionSearchSchema,
  BookmarkSearchSchema,
  UpdateBookmarksSchema,
} from "@contracts/ipc";
import type { Project } from "@contracts/session";
import { uid } from "@main/utils.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { broadcastSessionChanged, broadcastSessionDeleted } from "@main/lib/sessionSync.js";
import { log } from "@main/lib/logger.js";

export function registerProjectHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.PROJECT_CREATE, (_evt, raw) => {
    const input = CreateProjectSchema.parse(raw);
    const now = Date.now();
    const project: Project = {
      id: uid("proj_"),
      name: input.name,
      path: input.path,
      archived: false,
      pinnedAt: null,
      // Placeholder — ProjectRepo.create overwrites this with MAX+1; the
      // re-read below returns the authoritative row (with the real sort_order).
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    };
    ProjectRepo.create(project);
    const created = ProjectRepo.get(project.id);
    if (!created) throw new Error(`project not found after create: ${project.id}`);
    log.info(`project created: ${created.name} (${created.path})`);
    return { project: created };
  });

  ipcMain.handle(IPC.PROJECT_LIST, () => {
    return { projects: ProjectRepo.list() };
  });

  ipcMain.handle(IPC.PROJECT_SESSIONS, (_evt, raw) => {
    const input = ProjectSessionsSchema.parse(raw);
    const archived = input.archived;
    // The archived bin lists every archived item (no pagination); the active
    // thread list paginates with a default page size of 5.
    const limit = input.limit ?? (archived ? undefined : 5);
    const offset = input.offset ?? 0;
    const sessions = SessionRepo.listByProject(input.projectId, { limit, offset, archived });
    const total = SessionRepo.countByProject(input.projectId, archived);
    const hasMore = limit !== undefined ? offset + sessions.length < total : false;
    return { sessions, hasMore, total };
  });

  // Cross-project session title search (Ctrl+K unified search palette).
  ipcMain.handle(IPC.SESSION_SEARCH, (_evt, raw) => {
    const input = SessionSearchSchema.parse(raw);
    const sessions = SessionRepo.searchByTitle(input.query, { limit: input.limit });
    return { sessions };
  });

  // Cross-session bookmark search (Ctrl+K unified search palette).
  ipcMain.handle(IPC.SESSION_SEARCH_BOOKMARKS, (_evt, raw) => {
    const input = BookmarkSearchSchema.parse(raw);
    const results = SessionRepo.searchBookmarks(input.query, { limit: input.limit });
    return { results };
  });

  // Hard-delete a project (cascades to its sessions + messages via DB FKs).
  ipcMain.handle(IPC.PROJECT_DELETE, (_evt, raw) => {
    const input = DeleteProjectSchema.parse(raw);
    ProjectRepo.delete(input.id);
    log.info(`project deleted: ${input.id}`);
  });

  // Set a project's archived flag (soft-delete; restorable).
  ipcMain.handle(IPC.PROJECT_ARCHIVE, (_evt, raw) => {
    const input = ArchiveProjectSchema.parse(raw);
    ProjectRepo.setArchived(input.id, input.archived);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new Error(`project not found after archive: ${input.id}`);
    log.info(`project ${input.archived ? "archived" : "restored"}: ${input.id}`);
    return { project };
  });

  // Assign a project to a group (left-bar "grouped" view). null removes it.
  ipcMain.handle(IPC.PROJECT_SET_GROUP, (_evt, raw) => {
    const input = SetProjectGroupSchema.parse(raw);
    ProjectRepo.setGroup(input.id, input.group);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new Error(`project not found after setGroup: ${input.id}`);
    log.info(`project group set: ${input.id} -> ${input.group ?? "(none)"}`);
    return { project };
  });

  // Persist a drag-to-reorder: writes sort_order = index for each id.
  ipcMain.handle(IPC.PROJECT_REORDER, (_evt, raw) => {
    const input = ReorderProjectsSchema.parse(raw);
    ProjectRepo.reorder(input.orderedIds);
    log.info(`projects reordered: ${input.orderedIds.length} items`);
  });

  // Pin/unpin a project. Pinned projects leave the flat list / their group
  // and render in the left bar's pinned section above the project tree
  // (most recent pin first). Mirrors the session pin handler's shape.
  ipcMain.handle(IPC.PROJECT_PIN, (_evt, raw) => {
    const input = PinProjectSchema.parse(raw);
    ProjectRepo.setPinned(input.id, input.pinned);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new Error(`project not found after pin: ${input.id}`);
    log.info(`project ${input.pinned ? "pinned" : "unpinned"}: ${input.id}`);
    return { project };
  });

  // Rename a project (display-only; the path — the functional key for cwd /
  // path guards — is never touched).
  ipcMain.handle(IPC.PROJECT_RENAME, (_evt, raw) => {
    const input = RenameProjectSchema.parse(raw);
    ProjectRepo.rename(input.id, input.name);
    const project = ProjectRepo.get(input.id);
    if (!project) throw new Error(`project not found after rename: ${input.id}`);
    log.info(`project renamed: ${input.id} -> "${input.name}"`);
    return { project };
  });

  // Hard-delete a session (cascades to its messages via DB FK).
  ipcMain.handle(IPC.SESSION_DELETE, (_evt, raw) => {
    const input = DeleteSessionSchema.parse(raw);
    SessionRepo.delete(input.id);
    // Keep connected mobile clients' session lists in sync.
    broadcastSessionDeleted(input.id);
    log.info(`session deleted: ${input.id}`);
  });

  // Set a session's archived flag (soft-delete; restorable).
  ipcMain.handle(IPC.SESSION_ARCHIVE, (_evt, raw) => {
    const input = ArchiveSessionSchema.parse(raw);
    SessionRepo.setArchived(input.id, input.archived);
    const session = SessionRepo.get(input.id);
    if (!session) throw new Error(`session not found after archive: ${input.id}`);
    broadcastSessionChanged(session);
    log.info(`session ${input.archived ? "archived" : "restored"}: ${input.id}`);
    return { session };
  });

  // Rename a session (persist a user-edited title).
  ipcMain.handle(IPC.SESSION_RENAME, (_evt, raw) => {
    const input = RenameSessionSchema.parse(raw);
    SessionRepo.updateTitle(input.id, input.title);
    const session = SessionRepo.get(input.id);
    if (!session) throw new Error(`session not found after rename: ${input.id}`);
    broadcastSessionChanged(session);
    log.info(`session renamed: ${input.id} -> "${input.title}"`);
    return { session };
  });

  // Pin/unpin a session. Pinned sessions LEAVE their project's active list
  // and render in the left bar's global pinned section above the project
  // tree (cross-project, most recent pin first). Mirrors the archive
  // handler's shape.
  ipcMain.handle(IPC.SESSION_PIN, (_evt, raw) => {
    const input = PinSessionSchema.parse(raw);
    SessionRepo.setPinned(input.id, input.pinned);
    const session = SessionRepo.get(input.id);
    if (!session) throw new Error(`session not found after pin: ${input.id}`);
    broadcastSessionChanged(session);
    log.info(`session ${input.pinned ? "pinned" : "unpinned"}: ${input.id}`);
    return { session };
  });

  // Replace a session's bookmark list (full-array write from the renderer).
  // The mutating renderer patches its cached row from the returned full
  // session; other clients only get the slim session.changed broadcast (the
  // desktop is single-window, so no other renderer holds the bookmark bucket).
  ipcMain.handle(IPC.SESSION_UPDATE_BOOKMARKS, (_evt, raw) => {
    const input = UpdateBookmarksSchema.parse(raw);
    // `title` is optional in the schema (pre-rename rows parse unchanged);
    // normalize absent → null so the stored domain type stays strict.
    const bookmarks = input.bookmarks.map((b) => ({ ...b, title: b.title ?? null }));
    SessionRepo.updateBookmarks(input.id, bookmarks);
    const session = SessionRepo.get(input.id);
    if (!session) throw new Error(`session not found after updateBookmarks: ${input.id}`);
    broadcastSessionChanged(session);
    return { session };
  });

  // All pinned sessions across projects — feeds the left bar's pinned section.
  ipcMain.handle(IPC.SESSION_LIST_PINNED, () => {
    return { sessions: SessionRepo.listPinned() };
  });

  // Cross-project aggregate (stream sidebar's flat "全部项目" list). Same
  // paging contract as PROJECT_SESSIONS: default page 5, hasMore/total. The
  // optional scope filters make a scoped view's hasMore/total count ITS set
  // — without them the bottom "显示更多" button keeps the unfiltered
  // aggregate's count after a project switch.
  ipcMain.handle(IPC.SESSION_LIST_ALL, (_evt, raw) => {
    const input = SessionListAllSchema.parse(raw);
    const limit = input.limit ?? 10;
    const offset = input.offset ?? 0;
    const scope = { projectIds: input.projectIds, worktreeKey: input.worktreeKey };
    const sessions = SessionRepo.listAll({ limit, offset, ...scope });
    const total = SessionRepo.countAll(scope);
    const hasMore = offset + sessions.length < total;
    return { sessions, hasMore, total };
  });
}
