import { defineStore } from "pinia";
import { computed, reactive, ref } from "vue";
import { api, type TreeNode } from "../lib/api";
import { parseSortConfig, type CustomOrder, type SortConfig } from "../lib/treeSort";
import { mobileApi, type VaultConfig, type VaultInput } from "./api";
import { countNotes } from "./browse";
import { DEFAULT_READER, loadPrefs, savePrefs, type FontSize, type ReaderPrefs, type RecentOpen, type VaultMeta } from "./prefs";
import { THEMES } from "../lib/themes";

export const FONT_PX: Record<FontSize, number> = { small: 14, medium: 16, large: 18, xlarge: 20 };

/** tokens.css 里浅色是默认值，其余主题是 :root 上的类名 */
function applyReader(r: ReaderPrefs) {
  const root = document.documentElement;
  for (const t of THEMES) if (t.id !== "light") root.classList.toggle(t.id, t.id === r.theme);
  root.style.setProperty("--read-size", `${FONT_PX[r.size]}px`);
}

/** 电脑上还没保存过排序方式（旧版本）时按自定义顺序，与以前一致 */
const DEFAULT_SORT: SortConfig = { key: "custom", desc: false };

/** never：还没下载过；held：有删除等待确认 */
export type SyncState = "never" | "running" | "ok" | "fail" | "held";

async function readJson<T>(root: string, name: string, fallback: T): Promise<T> {
  try {
    const raw = await api.readConfig(root, name);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const useMobile = defineStore("mobile", () => {
  const vaults = ref<VaultConfig[]>([]);
  const currentId = ref<string | null>(null);
  const root = ref<string | null>(null);
  const tree = ref<TreeNode[]>([]);
  const order = ref<CustomOrder>({});
  /** 跟随电脑上的排序方式（`.ttnote/config/sort.json`） */
  const sort = ref<SortConfig>(DEFAULT_SORT);
  const favorites = ref<string[]>([]);
  const meta = ref<Record<string, VaultMeta>>({});
  const reader = ref<ReaderPrefs>({ ...DEFAULT_READER });
  const recent = ref<Record<string, RecentOpen[]>>({});
  const RECENT_LIMIT = 50;
  const sync = reactive({
    state: "never" as SyncState,
    done: 0,
    total: 0,
    rel: "",
    message: "",
    removals: [] as string[],
  });

  const current = computed(() => vaults.value.find((v) => v.id === currentId.value) ?? null);
  const homePage = computed(() => (vaults.value.length ? "files" : "welcome"));

  let inflight: { id: string; promise: Promise<void> } | null = null;

  function persist() {
    return savePrefs({ current: currentId.value, meta: meta.value, reader: reader.value, recent: recent.value });
  }

  /** 记一次打开。同一个文件再次打开时排到最前 */
  async function rememberOpen(path: string) {
    const id = currentId.value;
    if (!id) return;
    const list = [{ path, openedAt: Date.now() }, ...(recent.value[id] ?? []).filter((e) => e.path !== path)];
    recent.value = { ...recent.value, [id]: list.slice(0, RECENT_LIMIT) };
    await persist();
  }

  async function setReader(change: Partial<ReaderPrefs>) {
    reader.value = { ...reader.value, ...change };
    applyReader(reader.value);
    await persist();
  }

  async function loadTree() {
    const dir = root.value;
    if (!dir) return;
    const [scan, ord, favs, sortRaw] = await Promise.all([
      api.scanVault(dir),
      readJson<CustomOrder>(dir, "order.json", {}),
      readJson<string[]>(dir, "favorites.json", []),
      api.readConfig(dir, "sort.json").catch(() => null),
    ]);
    if (dir !== root.value) return;
    if (scan.warning) console.warn("读取文件时间记录失败", scan.warning);
    tree.value = scan.nodes;
    order.value = ord;
    favorites.value = Array.isArray(favs) ? favs : [];
    sort.value = parseSortConfig(sortRaw) ?? DEFAULT_SORT;
  }

  function resetSync(state: SyncState) {
    Object.assign(sync, { state, done: 0, total: 0, rel: "", message: "", removals: [] });
  }

  /** 打开当前笔记库；下载过的库顺带检查一次云端更新（不等它结束） */
  async function openCurrent() {
    const id = currentId.value;
    tree.value = [];
    order.value = {};
    sort.value = DEFAULT_SORT;
    favorites.value = [];
    root.value = id ? await mobileApi.vaultRoot(id) : null;
    if (!id || !root.value) return;
    // 笔记里的图片走 asset 协议，要先放行这个笔记库的目录
    await api.allowAssets(root.value).catch((e) => console.warn("放行图片目录失败", e));
    const synced = (meta.value[id]?.lastSyncMs ?? 0) > 0;
    resetSync(synced ? "ok" : "never");
    await loadTree();
    if (synced) void runSync();
  }

  async function init() {
    const prefs = await loadPrefs();
    meta.value = prefs.meta;
    reader.value = prefs.reader;
    recent.value = prefs.recent;
    applyReader(reader.value);
    vaults.value = await mobileApi.listVaults();
    currentId.value = vaults.value.some((v) => v.id === prefs.current) ? prefs.current : (vaults.value[0]?.id ?? null);
    await openCurrent();
  }

  async function doSync(id: string, confirmed: string[]) {
    Object.assign(sync, { state: "running", done: 0, total: 0, rel: "", message: "" });
    try {
      const outcome = await mobileApi.sync(id, confirmed, (p) => {
        if (currentId.value === id) Object.assign(sync, { done: p.done, total: p.total, rel: p.rel });
      });
      const report = outcome.report;
      const errors = report?.errors ?? [];
      if (report) {
        const files = currentId.value === id ? (await loadTree(), countNotes(tree.value)) : (meta.value[id]?.files ?? 0);
        meta.value[id] = { lastSyncMs: Date.now(), files };
        await persist();
      }
      if (currentId.value !== id) return;
      if (outcome.kind === "needsConfirm") {
        resetSync("held");
        sync.removals = outcome.check.removals;
        sync.message = [outcome.check.guard ?? "", ...errors].filter(Boolean).join("\n");
      } else if (errors.length) {
        resetSync("fail");
        sync.message = errors.join("\n");
      } else {
        resetSync("ok");
      }
    } catch (e) {
      if (currentId.value === id) {
        resetSync("fail");
        sync.message = e instanceof Error ? e.message : String(e);
      }
    }
  }

  /** 同一个库正在同步时返回那一次；别的库正在同步时等它结束再开始 */
  async function runSync(confirmed: string[] = []): Promise<void> {
    const id = currentId.value;
    if (!id) return;
    if (inflight) {
      if (inflight.id === id && !confirmed.length) return inflight.promise;
      await inflight.promise;
    }
    const promise = doSync(id, confirmed).finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
    inflight = { id, promise };
    return promise;
  }

  function confirmHeld() {
    return runSync([...sync.removals]);
  }

  async function selectVault(id: string) {
    currentId.value = id;
    await persist();
    await openCurrent();
  }

  async function addVault(input: VaultInput, password: string) {
    const v = await mobileApi.addVault(input, password);
    vaults.value.push(v);
    await selectVault(v.id);
    return v;
  }

  async function updateVault(id: string, input: VaultInput, password: string) {
    const before = vaults.value.find((v) => v.id === id);
    const v = await mobileApi.updateVault(id, input, password);
    vaults.value = vaults.value.map((x) => (x.id === id ? v : x));
    // 地址或远端目录变了，后端已清空本地副本，要重新下载
    if (before && (before.url.trim() !== v.url || before.remoteDir.trim() !== v.remoteDir)) {
      delete meta.value[id];
      await persist();
      if (id === currentId.value) await openCurrent();
    }
    return v;
  }

  async function removeVault(id: string) {
    await mobileApi.removeVault(id);
    vaults.value = vaults.value.filter((v) => v.id !== id);
    delete meta.value[id];
    if (currentId.value === id) {
      currentId.value = vaults.value[0]?.id ?? null;
      await openCurrent();
    }
    await persist();
  }

  return {
    vaults, currentId, root, tree, order, sort, favorites, meta, reader, recent, sync, current, homePage,
    init, loadTree, runSync, confirmHeld, selectVault, addVault, updateVault, removeVault, setReader, rememberOpen,
  };
});
