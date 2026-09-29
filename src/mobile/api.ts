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
  syncCheck: (id: string) => invoke<SyncCheck>("mobile_sync_check", { id }),
  sync: (id: string, confirmed: string[], onProgress: (p: SyncProgress) => void) => {
    const channel = new Channel<SyncProgress>();
    channel.onmessage = onProgress;
    return invoke<SyncOutcome>("mobile_sync", { id, confirmed, onProgress: channel });
  },
  networkMetered: () => invoke<boolean>("mobile_network_metered"),
};
