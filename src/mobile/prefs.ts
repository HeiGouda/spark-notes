import { load, type Store } from "@tauri-apps/plugin-store";

export interface VaultMeta {
  /** 上次成功同步的时间（毫秒），0 表示还没下载过 */
  lastSyncMs: number;
  files: number;
}

export interface MobilePrefs {
  current: string | null;
  meta: Record<string, VaultMeta>;
}

let store: Store | null = null;

async function open(): Promise<Store> {
  store ??= await load("mobile.json", { defaults: {}, autoSave: false });
  return store;
}

export async function loadPrefs(): Promise<MobilePrefs> {
  const s = await open();
  return { current: (await s.get<string>("current")) ?? null, meta: (await s.get<Record<string, VaultMeta>>("meta")) ?? {} };
}

export async function savePrefs(prefs: MobilePrefs): Promise<void> {
  const s = await open();
  await s.set("current", prefs.current);
  await s.set("meta", prefs.meta);
  await s.save();
}
