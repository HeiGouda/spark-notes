import { load, type Store } from "@tauri-apps/plugin-store";
import { isTheme, type Theme } from "../lib/themes";

export interface VaultMeta {
  /** 上次成功同步的时间（毫秒），0 表示还没下载过 */
  lastSyncMs: number;
  files: number;
}

export type FontSize = "small" | "medium" | "large" | "xlarge";

export interface ReaderPrefs {
  theme: Theme;
  size: FontSize;
}

export const DEFAULT_READER: ReaderPrefs = { theme: "light", size: "medium" };

export interface RecentOpen {
  path: string;
  openedAt: number;
}

export interface MobilePrefs {
  current: string | null;
  meta: Record<string, VaultMeta>;
  reader: ReaderPrefs;
  /** 每个笔记库最近打开的文件，新的在前 */
  recent: Record<string, RecentOpen[]>;
}

let store: Store | null = null;

async function open(): Promise<Store> {
  store ??= await load("mobile.json", { defaults: {}, autoSave: false });
  return store;
}

const SIZES: readonly FontSize[] = ["small", "medium", "large", "xlarge"];

function readerPrefs(raw: Partial<ReaderPrefs> | undefined): ReaderPrefs {
  return {
    theme: isTheme(raw?.theme) ? raw.theme : DEFAULT_READER.theme,
    size: raw?.size && SIZES.includes(raw.size) ? raw.size : DEFAULT_READER.size,
  };
}

export async function loadPrefs(): Promise<MobilePrefs> {
  const s = await open();
  return {
    current: (await s.get<string>("current")) ?? null,
    meta: (await s.get<Record<string, VaultMeta>>("meta")) ?? {},
    reader: readerPrefs(await s.get<Partial<ReaderPrefs>>("reader")),
    recent: (await s.get<Record<string, RecentOpen[]>>("recent")) ?? {},
  };
}

export async function savePrefs(prefs: MobilePrefs): Promise<void> {
  const s = await open();
  await s.set("current", prefs.current);
  await s.set("meta", prefs.meta);
  await s.set("reader", prefs.reader);
  await s.set("recent", prefs.recent);
  await s.save();
}
