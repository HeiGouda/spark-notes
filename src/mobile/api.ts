import { Channel, invoke } from "@tauri-apps/api/core";

export interface VaultConfig {
  id: string;
  name: string;
  url: string;
  remoteDir: string;
  username: string;
}

export type VaultInput = Omit<VaultConfig, "id">;

export interface RemoteInfo {
  notes: number;
  files: number;
  missing: boolean;
}

export interface SyncCheck {
  firstSync: boolean;
  downloads: number;
  downloadBytes: number;
  /** 要下载、但服务器没有给出大小的文件数 */
  missingSizes: number;
  removals: string[];
  guard: string | null;
  needsConfirm: boolean;
}

export interface SyncReport {
  downloaded: number;
  localTrashed: number;
  skipped: number;
  errors: string[];
}

export type SyncOutcome =
  | { kind: "done"; report: SyncReport }
  /** 删除要先确认；只是删除太多时 report 是已下载的新增和修改，云端异常时为 null */
  | { kind: "needsConfirm"; check: SyncCheck; report: SyncReport | null };

export interface SyncProgress {
  done: number;
  total: number;
  rel: string;
}

export const mobileApi = {
  listVaults: () => invoke<VaultConfig[]>("mobile_vault_list"),
  vaultRoot: (id: string) => invoke<string>("mobile_vault_root", { id }),
  addVault: (input: VaultInput, password: string) => invoke<VaultConfig>("mobile_vault_add", { input, password }),
  /** password 为空表示沿用已保存的密码 */
  updateVault: (id: string, input: VaultInput, password: string) =>
    invoke<VaultConfig>("mobile_vault_update", { id, input, password }),
  removeVault: (id: string) => invoke<void>("mobile_vault_remove", { id }),
  testVault: (id: string | null, input: VaultInput, password: string) =>
    invoke<RemoteInfo>("mobile_vault_test", { id, input, password }),
  /** 连上服务器，列出云端 spark/ 下已有的笔记库（文件夹名）；没有 spark/ 时是空数组 */
  vaultLibraries: (url: string, username: string, password: string) =>
    invoke<string[]>("mobile_vault_libraries", { url, username, password }),
  syncCheck: (id: string) => invoke<SyncCheck>("mobile_sync_check", { id }),
  sync: (id: string, confirmed: string[], onProgress: (p: SyncProgress) => void) => {
    const channel = new Channel<SyncProgress>();
    channel.onmessage = onProgress;
    return invoke<SyncOutcome>("mobile_sync", { id, confirmed, onProgress: channel });
  },
  networkMetered: () => invoke<boolean>("mobile_network_metered"),
  /** 把应用退到后台、回到桌面 */
  moveToBack: () => invoke<void>("mobile_move_to_back"),
  /** cloud 为 true 时云端的也移进回收站；否则只删本机，以后同步不再下载 */
  deleteNote: (id: string, rel: string, cloud: boolean) => invoke<void>("mobile_note_delete", { id, rel, cloud }),
  /** light：浅色背景，状态栏用深色图标 */
  systemBars: (light: boolean) => invoke<void>("mobile_system_bars", { light }),
  /** 阅读页打开时隐藏系统的选字工具条 */
  selectionMenu: (hidden: boolean) => invoke<void>("mobile_selection_menu", { hidden }),
  /** 阅读页翻页动画由安卓原生做：enabled 是能不能滑动翻页，anim 是 slide / cover / fade / none，footer 是页脚高度（翻页截图不盖住它） */
  pageTurnConfig: (o: { enabled: boolean; anim: PageTurnAnim; canPrev: boolean; canNext: boolean; footer?: number }) => invoke<void>("mobile_page_turn_config", o),
  /** 盖上当前书页的截图；false 表示这次不做动画，直接换页 */
  pageTurnStart: (dir: 1 | -1) => invoke<boolean>("mobile_page_turn_start", { dir }),
  /** 书页已经换好（moved 为 false 是没翻动），开始动画 */
  pageTurnReady: (moved: boolean) => invoke<void>("mobile_page_turn_ready", { moved }),
  /** 书页停稳了，让原生趁空闲先截好前后两页 */
  pageTurnPrefetch: () => invoke<void>("mobile_page_turn_prefetch"),
  pageTurnStop: () => invoke<void>("mobile_page_turn_stop"),
  shelfList: () => invoke<ShelfBook[]>("shelf_list"),
  shelfUsage: () => invoke<ShelfUsage>("shelf_usage"),
  shelfImport: (paths: string[]) => invoke<ShelfBook[]>("shelf_import", { paths }),
  shelfRemove: (id: string) => invoke<void>("shelf_remove", { id }),
  shelfRemoveDownloads: () => invoke<number>("shelf_remove_downloads"),
  shelfCloud: (vaultId: string, remoteDir: string) => invoke<CloudBook[]>("shelf_cloud", { vaultId, remoteDir }),
  /** mode：check 遇到同名就停下来；overwrite 覆盖；rename 另存 */
  shelfUpload: (vaultId: string, remoteDir: string, id: string, mode: "check" | "overwrite" | "rename") =>
    invoke<UploadOutcome>("shelf_upload", { vaultId, remoteDir, id, mode }),
  /** total 是服务器给的文件大小，没给时为 null */
  shelfDownload: (vaultId: string, remoteDir: string, rel: string, onProgress: (p: { done: number; total: number | null }) => void) => {
    const channel = new Channel<{ done: number; total: number | null }>();
    channel.onmessage = onProgress;
    return invoke<ShelfBook>("shelf_download", { vaultId, remoteDir, rel, onProgress: channel });
  },
  shelfDeleteCloud: (vaultId: string, remoteDir: string, rel: string) => invoke<void>("shelf_delete_cloud", { vaultId, remoteDir, rel }),
  shelfBookFile: (id: string) => invoke<OpenedBook>("shelf_book_file", { id }),
  /** 书 id → 读到的位置（0～1），没读过的书不在里面 */
  shelfProgress: () => invoke<Record<string, number>>("shelf_progress"),
  /** 书 id → 封面图片路径；书里没有封面时是空字符串；还没处理过的书不在里面 */
  /** 手机上记下的阅读位置（不访问网络） */
  shelfReadPoint: (id: string) => invoke<ReadPoint | null>("shelf_read_point", { id }),
  shelfCovers: () => invoke<Record<string, string>>("shelf_covers"),
  /** data 为空表示这本书没有封面 */
  shelfCoverSave: (id: string, data: Uint8Array) => invoke<void>("shelf_cover_save", { id, data: Array.from(data) }),
  shelfSavePoint: (id: string, point: ReadPoint) => invoke<void>("shelf_save_point", { id, point }),
  shelfSyncPoint: (vaultId: string, remoteDir: string, id: string) => invoke<SyncedPoint>("shelf_sync_point", { vaultId, remoteDir, id }),
  shelfPushPoint: (vaultId: string, remoteDir: string, id: string) => invoke<void>("shelf_push_point", { vaultId, remoteDir, id }),
  vaultTextRead: (vaultId: string, rel: string) => invoke<string>("vault_text_read", { vaultId, rel }),
  vaultTextWrite: (vaultId: string, rel: string, content: string) => invoke<void>("vault_text_write", { vaultId, rel, content }),
  shelfTextRead: (vaultId: string, remoteDir: string, rel: string) => invoke<string>("shelf_text_read", { vaultId, remoteDir, rel }),
  shelfTextWrite: (vaultId: string, remoteDir: string, rel: string, content: string) => invoke<void>("shelf_text_write", { vaultId, remoteDir, rel, content }),
};

export interface ShelfBook {
  id: string;
  name: string;
  size: number;
  addedMs: number;
  origin: "import" | "cloud";
}

export interface CloudBook {
  rel: string;
  name: string;
  ext: string;
  size: number;
  modified: string;
  localId: string | null;
  readable: boolean;
}

export interface ShelfUsage {
  books: number;
  bytes: number;
}

export interface OpenedBook {
  path: string;
  name: string;
}

export type PageTurnAnim = "slide" | "cover" | "fade" | "none";

export interface ReadPoint {
  cfi: string;
  fraction: number;
  updatedMs: number;
  /** 原生左右翻页的章节号。滚动、PDF 和桌面不写 */
  section?: number;
  /** 这一章正文里的字符偏移 */
  charOffset?: number;
}

export interface SyncedPoint {
  point: ReadPoint | null;
  fromCloud: boolean;
}

export interface UploadOutcome {
  done: boolean;
  name: string;
  size: number;
  modified: string;
}
