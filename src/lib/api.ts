import { Channel, invoke } from "@tauri-apps/api/core";

export interface TreeNode {
  name: string;
  /** 相对笔记库根目录，`/` 分隔 */
  path: string;
  isDir: boolean;
  children: TreeNode[];
  modifiedMs: number | null;
  createdMs: number | null;
  /** 表格簿（`.book` 文件夹）：isDir 为 true，name 不含后缀，children 是各张表（按表格簿里的顺序） */
  book?: BookInfo;
}

export interface BookInfo {
  /** 不能显示成表的项目（子文件夹、不认识的文件、嵌套的表格簿） */
  unsupported: string[];
  /** 顺序文件读取出错的说明，表仍按名称排序 */
  warning: string | null;
}

export interface ScanResult {
  nodes: TreeNode[];
  /** 文件时间记录（`.ttnote/config/times.json`）读写失败：文件树照常显示，时间可能不准 */
  warning: string | null;
}

export interface NoteFile {
  content: string;
  createdMs: number | null;
}

export interface SyncStats {
  indexed: number;
  removed: number;
  total: number;
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: { text: string; hit: boolean }[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface NoteRef {
  path: string;
  title: string;
}

export interface Backlink {
  path: string;
  title: string;
  line: string;
}

export interface GitChange {
  path: string;
  letter: string;
  name: string;
  dir: string;
}

export interface GitStatus {
  installed: boolean;
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  merging: boolean;
  rebasing: boolean;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  remote: string | null;
  userName: string;
  userEmail: string;
  /** 已保存在系统凭据库里的远程账号 */
  credentialUser: string | null;
  lockedReason: string | null;
  changes: GitChange[];
}

export interface GitLogEntry {
  id: string;
  subject: string;
  time: number;
  unpushed: boolean;
}

export interface GitAction {
  needIdentity: boolean;
  /** 远程要求登录；此时 notice 为空表示还没保存账号，否则是被拒绝的原因 */
  needCredentials: boolean;
  /** 拉取前本地有未提交的改动，或未推送的提交删了远程还有的文件，要用户选择保留还是以仓库为准 */
  needChoice: boolean;
  /** 未推送的提交里删掉的文件 */
  choiceFiles: string[];
  notice: string;
}

/** 拉取前本地有未提交的改动时：ask 询问；keep 先提交再合并；discard 以仓库为准（放弃的内容进历史版本或回收站） */
export type GitLocalChanges = "ask" | "keep" | "discard";

export interface GitConnectResult {
  /** 远程要求登录；rejected 表示已保存的账号被拒绝 */
  needLogin: boolean;
  rejected: boolean;
  remoteEmpty: boolean;
  localCommits: boolean;
}

export interface HistoryVersion {
  id: string;
  timeMs: number;
}

export interface TrashItem {
  id: string;
  originalPath: string;
  name: string;
  deletedAt: number;
  isDir: boolean;
}

export const api = {
  watch: (root: string) => invoke<void>("vault_watch", { root }),
  indexSync: (root: string) => invoke<SyncStats>("index_sync", { root }),
  search: (root: string, query: string, limit = 50) => invoke<SearchHit[]>("index_search", { root, query, limit }),
  tags: (root: string) => invoke<TagCount[]>("index_tags", { root }),
  tagNotes: (root: string, tag: string) => invoke<NoteRef[]>("index_tag_notes", { root, tag }),
  backlinks: (root: string, path: string) => invoke<Backlink[]>("link_backlinks", { root, path }),
  /** 改名 / 移动之后、刷新索引之前调用 */
  rewriteLinks: (root: string, from: string, to: string) => invoke<string[]>("link_rewrite", { root, from, to }),
  scanVault: (root: string) => invoke<ScanResult>("vault_scan", { root }),
  allowAssets: (root: string) => invoke<void>("vault_allow_assets", { root }),
  readNote: (root: string, path: string) => invoke<NoteFile>("note_read", { root, path }),
  writeNote: (root: string, path: string, content: string) =>
    invoke<void>("note_write", { root, path, content }),
  /** kind 为 mind / flow 时新建空的思维导图或流程图 */
  createNote: (root: string, dir: string, name?: string, kind?: "note" | "mind" | "flow") =>
    invoke<string>("note_create", { root, dir, name, kind }),
  createFolder: (root: string, dir: string, name?: string) => invoke<string>("folder_create", { root, dir, name }),
  /** 新建表格簿（`名称.book/`，里面有一张空笔记“表 1”），返回表格簿的相对路径 */
  createBook: (root: string, dir: string, name?: string) => invoke<string>("book_create", { root, dir, name }),
  /** 在表格簿末尾新建一张表；不给名称时叫“表 N” */
  createSheet: (root: string, book: string, kind: "note" | "mind" | "flow", name?: string) =>
    invoke<string>("sheet_create", { root, book, kind, name }),
  duplicateSheet: (root: string, path: string) => invoke<string>("sheet_duplicate", { root, path }),
  /** order 是表的文件名（含扩展名） */
  setBookOrder: (root: string, book: string, order: string[]) => invoke<void>("book_set_order", { root, book, order }),
  rename: (root: string, path: string, name: string) => invoke<string>("entry_rename", { root, path, name }),
  move: (root: string, path: string, targetDir: string) => invoke<string>("entry_move", { root, path, targetDir }),
  trash: (root: string, path: string) => invoke<void>("entry_trash", { root, path }),
  openExternal: (root: string, path: string) => invoke<void>("entry_open_external", { root, path }),
  /** 返回相对笔记所在目录的引用路径 */
  saveAttachment: (root: string, note: string, name: string, bytes: Uint8Array) =>
    invoke<string>("attachment_save", bytes, {
      headers: {
        "x-root": encodeURIComponent(root),
        "x-note": encodeURIComponent(note),
        "x-name": encodeURIComponent(name),
      },
    }),
  importAttachment: (root: string, note: string, source: string) =>
    invoke<string>("attachment_import", { root, note, source }),
  readTextFile: (path: string) => invoke<string>("text_file_read", { path }),
  writeTextFile: (path: string, content: string) => invoke<void>("text_file_write", { path, content }),
  writeBinaryFile: (path: string, bytes: Uint8Array) =>
    invoke<void>("binary_file_write", bytes, { headers: { "x-path": encodeURIComponent(path) } }),
  readConfig: (root: string, name: string) => invoke<string | null>("vault_config_read", { root, name }),
  writeConfig: (root: string, name: string, content: string) =>
    invoke<void>("vault_config_write", { root, name, content }),
  gitStatus: (root: string) => invoke<GitStatus>("git_status", { root }),
  gitLog: (root: string) => invoke<GitLogEntry[]>("git_log", { root }),
  gitInit: (root: string) => invoke<void>("git_init", { root }),
  gitCommit: (root: string, message: string) => invoke<GitAction>("git_commit", { root, message }),
  gitAutoCommit: (root: string, prefix: string) => invoke<GitAction>("git_auto_commit", { root, prefix }),
  gitPull: (root: string, local: GitLocalChanges) => invoke<GitAction>("git_pull", { root, local }),
  gitPush: (root: string) => invoke<GitAction>("git_push", { root }),
  gitSync: (root: string, local: GitLocalChanges) => invoke<GitAction>("git_sync", { root, local }),
  gitSetIdentity: (root: string, name: string, email: string) =>
    invoke<void>("git_set_identity", { root, name, email }),
  gitSetRemote: (root: string, url: string) => invoke<void>("git_set_remote", { root, url }),
  /** 需要时初始化仓库并设置 origin，实际访问一次远程；账号为空时沿用已保存的 */
  gitConnect: (root: string, url: string, username: string, password: string) =>
    invoke<GitConnectResult>("git_connect", { root, url, username, password }),
  /** 用户名为空时删除已保存的账号；密码为空时沿用已保存的密码 */
  gitSetCredentials: (root: string, username: string, password: string) =>
    invoke<void>("git_set_credentials", { root, username, password }),
  historyList: (root: string, path: string) => invoke<HistoryVersion[]>("history_list", { root, path }),
  historyRead: (root: string, path: string, id: string) => invoke<string>("history_read", { root, path, id }),
  historyRestore: (root: string, path: string, id: string) => invoke<void>("history_restore", { root, path, id }),
  historySnapshot: (root: string, path: string) => invoke<void>("history_snapshot", { root, path }),
  trashList: (root: string) => invoke<TrashItem[]>("trash_list", { root }),
  trashRestore: (root: string, id: string) => invoke<void>("trash_restore", { root, id }),
  trashDelete: (root: string, id: string) => invoke<void>("trash_delete", { root, id }),
  trashEmpty: (root: string) => invoke<void>("trash_empty", { root }),
  retainPrune: (root: string) => invoke<void>("retain_prune", { root }),
  webdavTest: (root: string, url: string, remoteDir: string, username: string, password: string) =>
    invoke<RemoteInfo>("webdav_test", { root, url, remoteDir, username, password }),
  webdavPreview: (root: string, url: string, remoteDir: string, username: string) =>
    invoke<SyncPreview>("webdav_preview", { root, url, remoteDir, username }),
  /** 需要确认的步骤只处理 accept 里的文件；force 表示用户已确认云端异常也继续 */
  webdavRun: (root: string, url: string, remoteDir: string, username: string, direction: SyncDirection, accept: string[], force: boolean) =>
    invoke<SyncReport>("webdav_run", { root, url, remoteDir, username, direction, accept, force }),
  webdavSavePassword: (root: string, password: string) => invoke<void>("webdav_save_password", { root, password }),
  webdavHasPassword: (root: string) => invoke<boolean>("webdav_has_password", { root }),
  exportZip: (root: string, dest: string) => invoke<number>("vault_export_zip", { root, dest }),
  importZip: (zipPath: string, dest: string) => invoke<number>("vault_import_zip", { zipPath, dest }),
  createVault: (parent: string, name: string) => invoke<string>("vault_create", { parent, name }),
  gitChangeDiff: (root: string, maxChars: number) => invoke<ChangeDiff>("git_change_diff", { root, maxChars }),
  /** API Key 按接口地址保存，同一地址的模型共用 */
  aiSaveKey: (baseUrl: string, key: string) => invoke<void>("ai_save_key", { baseUrl, key }),
  aiHasKey: (baseUrl: string) => invoke<boolean>("ai_has_key", { baseUrl }),
  aiClearKey: (baseUrl: string) => invoke<void>("ai_clear_key", { baseUrl }),
  /** 把旧版本唯一的 Key 搬到原来的接口地址名下 */
  aiMigrateKey: (baseUrl: string) => invoke<boolean>("ai_migrate_key", { baseUrl }),
  /** key：添加模型时输入、还没保存的 Key；不传时用这个地址保存的 */
  aiTest: (baseUrl: string, model: string, key?: string) => invoke<number>("ai_test", { baseUrl, model, key: key || null }),
  aiChat: (id: string, baseUrl: string, model: string, messages: ChatMessage[], onEvent: Channel<AiEvent>) =>
    invoke<void>("ai_chat", { id, baseUrl, model, messages, onEvent }),
  aiCancel: (id: string) => invoke<void>("ai_cancel", { id }),
  aiListModels: (baseUrl: string, key?: string) => invoke<ProviderModel[]>("ai_list_models", { baseUrl, key: key || null }),
  chatList: () => invoke<ChatSummary[]>("chat_list"),
  chatRead: (id: string) => invoke<string>("chat_read", { id }),
  chatWrite: (id: string, json: string) => invoke<void>("chat_write", { id, json }),
  chatDelete: (id: string) => invoke<void>("chat_delete", { id }),
  chatDeleteImage: (id: string, file: string) => invoke<void>("chat_delete_image", { id, file }),
  chatSaveImage: (id: string, name: string, bytes: Uint8Array) =>
    invoke<string>("chat_save_image", bytes, { headers: { "x-chat": encodeURIComponent(id), "x-name": encodeURIComponent(name) } }),
  chatImportImage: (id: string, source: string) => invoke<string>("chat_import_image", { id, source }),
  chatImageData: (id: string, file: string) => invoke<string>("chat_image_data", { id, file }),
};

export interface ProviderModel {
  id: string;
  context: number | null;
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export interface ChangeDiff {
  files: string[];
  diff: string;
  truncated: boolean;
}

export type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

export type AiEvent = { kind: "delta"; text: string };

/** 上传：本地 → 云端；同步：云端 → 本地，云端为准 */
export type SyncDirection = "upload" | "download";

/**
 * add 对方没有，新增；update 对方自上次同步后没变，直接更新；
 * overwrite 对方也改过，覆盖（旧版本可找回）；remove 移到回收处；keep 只提示不处理
 */
export type SyncStep = "add" | "update" | "overwrite" | "remove" | "keep";

export interface PlanItem {
  rel: string;
  step: SyncStep;
}

export interface SyncPreview {
  upload: PlanItem[];
  download: PlanItem[];
  /** 云端文件比上次同步时少很多，执行前需要用户明确确认 */
  guard: string | null;
  localFiles: number;
  remoteFiles: number;
  /** 0 表示从未同步 */
  lastSyncMs: number;
}

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  remoteTrashed: number;
  localTrashed: number;
  skipped: number;
  errors: string[];
}

export interface RemoteInfo {
  notes: number;
  files: number;
  missing: boolean;
}

/** 相对路径工具：路径统一用 `/`，根目录为空字符串 */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** path 是否等于 prefix 或位于 prefix 目录之下 */
export function isWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

export function remapPath(path: string, from: string, to: string): string {
  return isWithin(path, from) ? to + path.slice(from.length) : path;
}
