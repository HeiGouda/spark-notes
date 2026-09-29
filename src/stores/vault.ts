import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { api, baseName, dirOf, isWithin, remapPath, type TreeNode } from "../lib/api";
import { sortTree, type CustomOrder } from "../lib/treeSort";
import { useSettingsStore, type SortKey } from "./settings";
import { useNoticeStore } from "./notice";
import { useTabsStore } from "./tabs";
import { useSearchStore } from "./search";

const ORDER_FILE = "order.json";
const FAVORITES_FILE = "favorites.json";

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.isDir && isWithin(path, n.path)) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

export const useVaultStore = defineStore("vault", () => {
  const root = ref<string | null>(null);
  const tree = ref<TreeNode[]>([]);
  const expanded = ref(new Set<string>());
  /** 文件树中选中的项（文件或文件夹），决定新建的位置 */
  const selected = ref<string | null>(null);
  /** 正在就地改名的项 */
  const renaming = ref<string | null>(null);
  const sortKey = ref<SortKey>("name");
  const sortDesc = ref(false);
  /** 自定义排序（`.ttnote/config/order.json`，随笔记库同步）：文件夹相对路径 → 子项名称顺序 */
  const customOrder = ref<CustomOrder>({});
  /** 收藏（`.ttnote/config/favorites.json`，随笔记库同步），保持用户排列的顺序 */
  const favoriteList = ref<string[]>([]);
  const favorites = computed(() => new Set(favoriteList.value));
  const loadError = ref<string | null>(null);
  /** 正在打开 / 切换笔记库，期间不记录会话，避免把旧库的标签页清空 */
  const switching = ref(false);

  const name = computed(() => {
    if (!root.value) return "";
    const parts = root.value.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? root.value;
  });

  const sortedTree = computed(() => sortTree(tree.value, sortKey.value, sortDesc.value, customOrder.value));

  /** 所有笔记的相对路径，用于双向链接补全 */
  const notePaths = computed(() => {
    const out: string[] = [];
    const walk = (nodes: TreeNode[]) => nodes.forEach((n) => (n.isDir ? walk(n.children) : out.push(n.path)));
    walk(tree.value);
    return out;
  });

  const notice = () => useNoticeStore();

  async function loadOrder(path: string): Promise<CustomOrder> {
    try {
      const raw = await api.readConfig(path, ORDER_FILE);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      notice().report("读取自定义排序失败，已按名称排序", e);
      return {};
    }
  }

  async function saveOrder() {
    if (!root.value) return;
    try {
      await api.writeConfig(root.value, ORDER_FILE, JSON.stringify(customOrder.value, null, 2) + "\n");
    } catch (e) {
      notice().report("保存自定义排序失败", e);
    }
  }

  async function loadFavorites(path: string): Promise<string[]> {
    try {
      const raw = await api.readConfig(path, FAVORITES_FILE);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch (e) {
      notice().report("读取收藏失败", e);
      return [];
    }
  }

  async function setFavorites(list: string[]) {
    favoriteList.value = list;
    if (!root.value) return;
    try {
      await api.writeConfig(root.value, FAVORITES_FILE, JSON.stringify(list, null, 2) + "\n");
    } catch (e) {
      notice().report("保存收藏失败", e);
    }
  }

  function toggleFavorite(path: string) {
    const list = favoriteList.value;
    void setFavorites(list.includes(path) ? list.filter((p) => p !== path) : [...list, path]);
  }

  function reorderFavorite(from: number, to: number) {
    const list = [...favoriteList.value];
    const [item] = list.splice(from, 1);
    if (item === undefined) return;
    list.splice(to, 0, item);
    void setFavorites(list);
  }

  async function openVault(path: string): Promise<boolean> {
    switching.value = true;
    try {
      return await doOpenVault(path);
    } finally {
      switching.value = false;
    }
  }

  async function doOpenVault(path: string): Promise<boolean> {
    const tabs = useTabsStore();
    if (!(await tabs.closeAll())) return false;
    tabs.resetHistory();
    let nodes: TreeNode[];
    try {
      nodes = await api.scanVault(path);
    } catch (e) {
      loadError.value = `无法打开笔记库 ${path}：${e}`;
      notice().report("打开笔记库失败", e);
      return false;
    }
    try {
      await api.allowAssets(path);
    } catch (e) {
      notice().report("笔记中的图片可能无法显示", e);
    }
    const settings = useSettingsStore();
    const ui = settings.vaultUi(path);
    root.value = path;
    tree.value = nodes;
    expanded.value = new Set(ui.expanded);
    sortKey.value = ui.sortKey;
    sortDesc.value = ui.sortDesc;
    customOrder.value = await loadOrder(path);
    favoriteList.value = await loadFavorites(path);
    selected.value = null;
    renaming.value = null;
    loadError.value = null;
    settings.setLastVault(path);
    const search = useSearchStore();
    search.reset();
    try {
      await api.watch(path);
    } catch (e) {
      notice().report("外部修改将无法自动刷新", e);
    }
    void search.syncNow();
    void api.retainPrune(path).catch((e) => notice().report("清理过期的历史版本或回收站失败", e));
    await tabs.restore(settings.restoreTabs ? ui.tabs : [], settings.restoreTabs ? ui.active : null);
    return true;
  }

  async function pickAndOpen(): Promise<void> {
    let picked: string | string[] | null;
    try {
      picked = await open({ directory: true, multiple: false, title: "选择笔记库文件夹" });
    } catch (e) {
      notice().report("打开文件夹选择器失败", e);
      return;
    }
    if (typeof picked === "string") await openVault(picked);
  }

  async function refresh(): Promise<void> {
    if (!root.value) return;
    try {
      tree.value = await api.scanVault(root.value);
    } catch (e) {
      notice().report("刷新目录失败", e);
    }
  }

  function node(path: string) {
    return findNode(tree.value, path);
  }

  function toggle(path: string) {
    const next = new Set(expanded.value);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expanded.value = next;
  }

  function expand(path: string) {
    if (!path || expanded.value.has(path)) return;
    expanded.value = new Set([...expanded.value, path]);
  }

  function collapseAll() {
    expanded.value = new Set();
  }

  /** 展开某个笔记的所有上级文件夹，让它在树中可见 */
  function reveal(path: string) {
    const parts = path.split("/");
    const next = new Set(expanded.value);
    for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
    expanded.value = next;
  }

  /** 新建的目标文件夹：选中的文件夹 → 选中项或当前笔记所在文件夹 → 根目录 */
  function targetDir(): string {
    if (selected.value) {
      const n = node(selected.value);
      if (n) return n.isDir ? n.path : dirOf(n.path);
    }
    const activePath = useTabsStore().activePath;
    return activePath ? dirOf(activePath) : "";
  }

  async function newNote(dir = targetDir()): Promise<void> {
    if (!root.value) return;
    try {
      const rel = await api.createNote(root.value, dir);
      await refresh();
      reveal(rel);
      selected.value = rel;
      await useTabsStore().open(rel);
      renaming.value = rel;
    } catch (e) {
      notice().report("新建笔记失败", e);
    }
  }

  async function newFolder(dir = targetDir()): Promise<void> {
    if (!root.value) return;
    try {
      const rel = await api.createFolder(root.value, dir);
      await refresh();
      reveal(rel);
      selected.value = rel;
      renaming.value = rel;
    } catch (e) {
      notice().report("新建文件夹失败", e);
    }
  }

  function remapState(from: string, to: string) {
    expanded.value = new Set([...expanded.value].map((p) => remapPath(p, from, to)));
    if (selected.value) selected.value = remapPath(selected.value, from, to);
    if (favoriteList.value.some((p) => isWithin(p, from))) {
      void setFavorites(favoriteList.value.map((p) => remapPath(p, from, to)));
    }
    const order: CustomOrder = {};
    let changed = false;
    for (const [dir, names] of Object.entries(customOrder.value)) {
      const newDir = remapPath(dir, from, to);
      if (newDir !== dir) changed = true;
      order[newDir] = names;
    }
    const fromDir = dirOf(from);
    const toDir = dirOf(to);
    const list = order[fromDir];
    if (list?.includes(baseName(from))) {
      changed = true;
      if (fromDir === toDir) {
        order[fromDir] = list.map((n) => (n === baseName(from) ? baseName(to) : n));
      } else {
        order[fromDir] = list.filter((n) => n !== baseName(from));
      }
    }
    customOrder.value = order;
    if (changed) void saveOrder();
  }

  /**
   * 改名 / 移动的公共流程：先保存所有打开的笔记（其他笔记里的链接可能被改写），
   * 执行操作后按改名前的索引改写指向它的链接，再重新载入磁盘内容已变化的标签页。
   */
  async function relocate(path: string, label: string, op: (root: string) => Promise<string>): Promise<string | null> {
    const vaultRoot = root.value;
    if (!vaultRoot) return null;
    const n = node(path);
    const tabs = useTabsStore();
    if (!(await tabs.flushAll())) {
      notice().report(`${label}已取消`, "有笔记保存失败，请先处理");
      return null;
    }
    const search = useSearchStore();
    const rel = await search.paused(async () => {
      let rel: string;
      try {
        rel = await op(vaultRoot);
      } catch (e) {
        notice().report(`${label}失败`, e);
        return null;
      }
      if (rel === path) return rel;
      remapState(path, rel);
      tabs.remap(path, rel);
      let rewritten: string[] = [];
      try {
        rewritten = await api.rewriteLinks(vaultRoot, path, rel);
      } catch (e) {
        notice().report("更新指向它的链接失败", e);
      }
      // 笔记改名时附件引用可能已在磁盘上被改写，一并重新读取
      const reload = new Set(rewritten);
      if (n && !n.isDir) reload.add(rel);
      for (const t of [...tabs.tabs]) if (reload.has(t.path)) await tabs.reload(t.path);
      await refresh();
      return rel;
    });
    void search.syncNow();
    return rel;
  }

  /** 重命名，返回新路径；失败时返回 null */
  async function rename(path: string, newName: string): Promise<string | null> {
    const n = node(path);
    if (!n) return null;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === n.name) return path;
    return relocate(path, "重命名", (r) => api.rename(r, path, trimmed));
  }

  async function move(path: string, targetDir: string): Promise<string | null> {
    if (dirOf(path) === targetDir) return path;
    const rel = await relocate(path, "移动", (r) => api.move(r, path, targetDir));
    if (rel) expand(targetDir);
    return rel;
  }

  /** 自定义排序下把 path 放到 target 之前或之后；不在同一文件夹时先移动过去 */
  async function place(path: string, target: string, where: "before" | "after"): Promise<void> {
    if (path === target) return;
    const dir = dirOf(target);
    const moved = dirOf(path) === dir ? path : await move(path, dir);
    if (!moved) return;
    const parent = dir ? node(dir)?.children : tree.value;
    if (!parent) return;
    const current = sortTree(parent, "custom", false, customOrder.value, dir, false).map((c) => baseName(c.path));
    const me = baseName(moved);
    const list = current.filter((x) => x !== me);
    const at = list.indexOf(baseName(target));
    list.splice(where === "before" ? at : at + 1, 0, me);
    customOrder.value = { ...customOrder.value, [dir]: list };
    await saveOrder();
  }

  async function trash(path: string): Promise<void> {
    if (!root.value) return;
    const n = node(path);
    if (!n) return;
    const what = n.isDir ? `文件夹“${n.name}”及其中的所有内容` : `笔记“${n.name}”及其附件`;
    const ok = await ask(`确定删除${what}吗？\n\n将移入笔记库的回收站（.ttnote/trash），之后可以恢复。`, {
      title: "删除",
      kind: "warning",
      okLabel: "删除",
      cancelLabel: "取消",
    });
    if (!ok) return;
    const tabs = useTabsStore();
    // 先保存，保证回收站里是最新内容；保存失败时先问，避免未保存的修改被丢掉
    if (!(await tabs.flushUnder(path))) {
      const failed = tabs.tabs.filter((t) => isWithin(t.path, path) && t.status === "error");
      const detail = failed.map((t) => (t.error ? `“${t.name}”：${t.error}` : `“${t.name}”`)).join("\n");
      const discard = await ask(`有笔记保存失败，删除后将丢失这些未保存的修改。\n\n${detail}\n\n仍要删除并放弃修改吗？`, {
        title: "删除",
        kind: "warning",
        okLabel: "放弃修改并删除",
        cancelLabel: "取消",
      });
      if (!discard) return;
    }
    try {
      await api.trash(root.value, path);
    } catch (e) {
      notice().report("删除失败", e);
      return;
    }
    tabs.dropUnder(path);
    expanded.value = new Set([...expanded.value].filter((p) => !isWithin(p, path)));
    if (selected.value && isWithin(selected.value, path)) selected.value = null;
    const dir = dirOf(path);
    const list = customOrder.value[dir];
    if (list?.includes(baseName(path))) {
      customOrder.value = { ...customOrder.value, [dir]: list.filter((x) => x !== baseName(path)) };
      void saveOrder();
    }
    if (favoriteList.value.some((p) => isWithin(p, path))) {
      void setFavorites(favoriteList.value.filter((p) => !isWithin(p, path)));
    }
    await refresh();
    useSearchStore().schedule();
  }

  function setSort(key: SortKey, desc = sortDesc.value) {
    sortKey.value = key;
    sortDesc.value = desc;
  }

  function absolutePath(path: string): string {
    if (!root.value) return path;
    const sep = root.value.includes("\\") ? "\\" : "/";
    const base = root.value.replace(/[\\/]+$/, "");
    return path ? `${base}${sep}${path.split("/").join(sep)}` : base;
  }

  return {
    root, tree, sortedTree, expanded, selected, renaming, sortKey, sortDesc, customOrder, favorites, loadError, switching, name,
    openVault, pickAndOpen, refresh, node, toggle, expand, collapseAll, reveal, targetDir,
    newNote, newFolder, rename, move, place, trash, setSort, absolutePath,
    favoriteList, toggleFavorite, reorderFavorite, notePaths,
  };
});
