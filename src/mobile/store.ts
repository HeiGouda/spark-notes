import { defineStore } from "pinia";
import { computed, reactive, ref } from "vue";
import { api, type TreeNode } from "../lib/api";
import type { CustomOrder } from "../lib/treeSort";
import { mobileApi, type VaultConfig, type VaultInput } from "./api";
import { countNotes } from "./browse";
import { loadPrefs, savePrefs, type VaultMeta } from "./prefs";

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
  const favorites = ref<string[]>([]);
  const meta = ref<Record<string, VaultMeta>>({});
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
    return savePrefs({ current: currentId.value, meta: meta.value });
  }

  async function loadTree() {
    const dir = root.value;
    if (!dir) return;
    const [nodes, ord, favs] = await Promise.all([
      api.scanVault(dir),
      readJson<CustomOrder>(dir, "order.json", {}),
      readJson<string[]>(dir, "favorites.json", []),
    ]);
    if (dir !== root.value) return;
    tree.value = nodes;
    order.value = ord;
    favorites.value = Array.isArray(favs) ? favs : [];
  }

  function resetSync(state: SyncState) {
    Object.assign(sync, { state, done: 0, total: 0, rel: "", message: "", removals: [] });
  }

  /** 打开当前笔记库；下载过的库顺带检查一次云端更新（不等它结束） */
  async function openCurrent() {
    const id = currentId.value;
    tree.value = [];
    order.value = {};
    favorites.value = [];
    root.value = id ? await mobileApi.vaultRoot(id) : null;
    if (!id) return;
    const synced = (meta.value[id]?.lastSyncMs ?? 0) > 0;
    resetSync(synced ? "ok" : "never");
    await loadTree();
    if (synced) void runSync();
  }

  async function init() {
    const prefs = await loadPrefs();
    meta.value = prefs.meta;
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
      if (outcome.kind === "done" || outcome.report) {
        const files = currentId.value === id ? (await loadTree(), countNotes(tree.value)) : (meta.value[id]?.files ?? 0);
        meta.value[id] = { lastSyncMs: Date.now(), files };
        await persist();
      }
      if (currentId.value !== id) return;
      if (outcome.kind === "done") {
        resetSync("ok");
      } else {
        resetSync("held");
        sync.removals = outcome.check.removals;
        sync.message = outcome.check.guard ?? "";
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
    vaults, currentId, root, tree, order, favorites, meta, sync, current, homePage,
    init, loadTree, runSync, confirmHeld, selectVault, addVault, updateVault, removeVault,
  };
});
