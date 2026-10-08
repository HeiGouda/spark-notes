import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { api, baseName, dirOf, isWithin, remapPath, type TreeNode } from "../lib/api";
import { filterHidden, parseSortConfig, sortTree, type CustomOrder, type SortConfig } from "../lib/treeSort";
import { DOC_LABEL, docKind, type DocKind } from "../lib/doctype";
import { bookOf, isBookPath, outsideBook } from "../lib/book";
import { useSettingsStore, type SortKey } from "./settings";
import { useBookStore } from "./book";
import { useNoticeStore } from "./notice";
import { useTabsStore } from "./tabs";
import { useSearchStore } from "./search";
import { useUiStore } from "./ui";

const ORDER_FILE = "order.json";
const FAVORITES_FILE = "favorites.json";
const SORT_FILE = "sort.json";

/** 同步的对象是笔记库：没有打开笔记库时点同步给出的提示 */
export const NEED_VAULT_FOR_SYNC = "需要先新建或打开一个笔记库才能同步";

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
  /** 排序方式（`.ttnote/config/sort.json`，随笔记库同步，手机和笔记柜也按它排） */
  const sortKey = ref<SortKey>("name");
  const sortDesc = ref(false);
  /** 自定义排序（`.ttnote/config/order.json`，随笔记库同步）：文件夹相对路径 → 子项名称顺序 */
  const customOrder = ref<CustomOrder>({});
  /** 收藏（`.ttnote/config/favorites.json`，随笔记库同步），保持用户排列的顺序 */
  const favoriteList = ref<string[]>([]);
  const favorites = computed(() => new Set(favoriteList.value));
  /** 文件树中隐藏的项（本机设置，不随笔记库同步），按隐藏的先后排列 */
  const hidden = ref<string[]>([]);
  const loadError = ref<string | null>(null);
  /** 正在打开 / 切换笔记库，期间不记录会话，避免把旧库的标签页清空 */
  const switching = ref(false);

  const name = computed(() => {
    if (!root.value) return "";
    const parts = root.value.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? root.value;
  });

  /** 文件树显示的内容：排序并去掉隐藏的项 */
  const sortedTree = computed(() => sortTree(filterHidden(tree.value, new Set(hidden.value)), sortKey.value, sortDesc.value, customOrder.value));

  /** 笔记和图的相对路径，用于快速打开 */
  const docPaths = computed(() => {
    const out: string[] = [];
    const walk = (nodes: TreeNode[]) => nodes.forEach((n) => (n.isDir ? walk(n.children) : out.push(n.path)));
    walk(tree.value);
    return out;
  });

  /** 所有表格簿的相对路径 */
  const bookPaths = computed(() => {
    const out: string[] = [];
    const walk = (nodes: TreeNode[]) => nodes.forEach((n) => (n.book ? out.push(n.path) : n.isDir && walk(n.children)));
    walk(tree.value);
    return out;
  });

  /** 双向链接能指向的所有路径：笔记、图和表格簿 */
  const linkPaths = computed(() => [...docPaths.value, ...bookPaths.value]);

  /** 所有笔记的相对路径，用于双向链接补全 */
  const notePaths = computed(() => docPaths.value.filter((p) => docKind(p) === "note"));

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

  /** 读取排序方式。还没有 sort.json 时（旧版本建的笔记库）把本机的设置写进去，手机和笔记柜随之一致 */
  async function loadSort(path: string, local: SortConfig): Promise<SortConfig> {
    let raw: string | null;
    try {
      raw = await api.readConfig(path, SORT_FILE);
    } catch (e) {
      notice().report("读取排序方式失败，已按本机设置排序", e);
      return local;
    }
    const parsed = parseSortConfig(raw);
    if (parsed) return parsed;
    if (raw) {
      notice().report("排序方式无法识别，已按本机设置排序", SORT_FILE);
      return local;
    }
    await writeSort(path, local);
    return local;
  }

  async function writeSort(path: string, sort: SortConfig) {
    try {
      await api.writeConfig(path, SORT_FILE, JSON.stringify(sort, null, 2) + "\n");
    } catch (e) {
      notice().report("保存排序方式失败", e);
    }
  }

  let lastScanWarning: string | null = null;

  /** 扫描文件树；文件时间记录出错时提示一次（同样的错误不重复提示） */
  async function scan(path: string): Promise<TreeNode[]> {
    const { nodes, warning } = await api.scanVault(path);
    if (warning && warning !== lastScanWarning) notice().report("文件时间可能不准", warning);
    lastScanWarning = warning;
    return nodes;
  }

  /**
   * 同步下来的排序、自定义顺序和收藏：`.ttnote/` 不在文件监听范围内，Git 拉取或 WebDAV 下载后要重新读取。
   */
  async function reloadConfig(): Promise<void> {
    const path = root.value;
    if (!path) return;
    const [order, favs, sortRaw] = await Promise.all([
      loadOrder(path),
      loadFavorites(path),
      api.readConfig(path, SORT_FILE).catch((e) => {
        notice().report("读取排序方式失败", e);
        return null;
      }),
    ]);
    if (root.value !== path) return;
    customOrder.value = order;
    favoriteList.value = favs;
    const sort = parseSortConfig(sortRaw);
    if (sort) {
      sortKey.value = sort.key;
      sortDesc.value = sort.desc;
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
      lastScanWarning = null;
      nodes = await scan(path);
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
    const sort = await loadSort(path, { key: ui.sortKey, desc: ui.sortDesc });
    sortKey.value = sort.key;
    sortDesc.value = sort.desc;
    hidden.value = Array.isArray(ui.hidden) ? ui.hidden.filter((p) => typeof p === "string") : [];
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
    const path = root.value;
    try {
      const nodes = await scan(path);
      if (root.value === path) tree.value = nodes;
    } catch (e) {
      notice().report("刷新目录失败", e);
    }
  }

  /**
   * 新建或移入的项排在所在文件夹自定义顺序的末尾。在 refresh 之后调用，才能拿到同一文件夹里的其他项；
   * 这个文件夹还没有顺序列表时，先按当前显示的顺序（未排过的按名称）建一份。
   */
  async function appendToOrder(path: string): Promise<void> {
    // 表格簿里的表由簿内的 .book.json 记顺序，由 Rust 端维护
    if (bookOf(path)) return;
    const dir = dirOf(path);
    const me = baseName(path);
    const parent = dir ? node(dir)?.children : tree.value;
    if (!parent) return;
    const list = customOrder.value[dir] ?? sortTree(parent, "custom", false, customOrder.value, dir, false).map((c) => baseName(c.path));
    customOrder.value = { ...customOrder.value, [dir]: [...list.filter((x) => x !== me), me] };
    await saveOrder();
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

  /** 新建的目标文件夹：选中的文件夹 → 选中项或当前笔记所在文件夹 → 根目录；不会落在表格簿里面 */
  function targetDir(): string {
    if (selected.value) {
      const n = node(selected.value);
      if (n) return outsideBook(n.isDir && !n.book ? n.path : dirOf(n.path));
    }
    const activePath = useTabsStore().activePath;
    return outsideBook(activePath ? dirOf(activePath) : "");
  }

  /** 在 dir 下新建笔记 / 图。dir 是表格簿时作为新的一张表加到最后，名称重复时加序号 */
  async function createDocIn(dir: string, kind: DocKind, name?: string): Promise<string> {
    if (!root.value) throw new Error("没有打开笔记库");
    return isBookPath(dir) ? api.createSheet(root.value, dir, kind, name) : api.createNote(root.value, dir, name, kind);
  }

  async function newBook(dir = targetDir()): Promise<void> {
    if (!root.value) return;
    try {
      const rel = await api.createBook(root.value, outsideBook(dir));
      await refresh();
      await appendToOrder(rel);
      reveal(rel);
      selected.value = rel;
      await useBookStore().openBook(rel);
      renaming.value = rel;
    } catch (e) {
      notice().report("新建表格簿失败", e);
    }
  }

  async function newDoc(kind: DocKind, dir = targetDir()): Promise<void> {
    if (!root.value) return;
    try {
      const rel = await api.createNote(root.value, outsideBook(dir), undefined, kind);
      await refresh();
      await appendToOrder(rel);
      reveal(rel);
      selected.value = rel;
      await useTabsStore().open(rel);
      renaming.value = rel;
    } catch (e) {
      notice().report(`新建${DOC_LABEL[kind]}失败`, e);
    }
  }

  const newNote = (dir?: string) => newDoc("note", dir);

  async function newFolder(dir = targetDir()): Promise<void> {
    if (!root.value) return;
    try {
      const rel = await api.createFolder(root.value, dir);
      await refresh();
      await appendToOrder(rel);
      reveal(rel);
      selected.value = rel;
      renaming.value = rel;
    } catch (e) {
      notice().report("新建文件夹失败", e);
    }
  }

  function remapState(from: string, to: string) {
    expanded.value = new Set([...expanded.value].map((p) => remapPath(p, from, to)));
    // 表格簿上次停在哪张表：表格簿或表改名、移动后跟着走
    if (root.value) {
      const settings = useSettingsStore();
      const sheets = settings.vaultUi(root.value).bookSheets ?? {};
      if (Object.entries(sheets).some(([b, s]) => isWithin(b, from) || isWithin(s, from))) {
        const next: Record<string, string> = {};
        for (const [b, s] of Object.entries(sheets)) next[remapPath(b, from, to)] = remapPath(s, from, to);
        settings.patchVaultUi(root.value, { bookSheets: next });
      }
    }
    if (selected.value) selected.value = remapPath(selected.value, from, to);
    if (hidden.value.some((p) => isWithin(p, from))) hidden.value = hidden.value.map((p) => remapPath(p, from, to));
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
    if (isBookPath(targetDir)) {
      notice().report("无法移动", "不能把文件移进表格簿，请在表格簿里用“+”新建表");
      return null;
    }
    const rel = await relocate(path, "移动", (r) => api.move(r, path, targetDir));
    if (rel) {
      expand(targetDir);
      if (rel !== path) await appendToOrder(rel);
    }
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

  /** 删除（移入回收站）；返回是否真的删除了 */
  async function trash(path: string): Promise<boolean> {
    if (!root.value) return false;
    const n = node(path);
    if (!n) return false;
    const kind = docKind(path);
    const what = n.book
      ? `表格簿“${n.name}”及其中的所有表`
      : n.isDir
      ? `文件夹“${n.name}”及其中的所有内容`
      : kind === "note" || !kind ? `笔记“${n.name}”及其附件` : `${DOC_LABEL[kind]}“${n.name}”`;
    const ok = await ask(`确定删除${what}吗？\n\n将移入笔记库的回收站（.ttnote/trash），之后可以恢复。`, {
      title: "删除",
      kind: "warning",
      okLabel: "删除",
      cancelLabel: "取消",
    });
    if (!ok) return false;
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
      if (!discard) return false;
    }
    try {
      await api.trash(root.value, path);
    } catch (e) {
      notice().report("删除失败", e);
      return false;
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
    hidden.value = hidden.value.filter((p) => !isWithin(p, path));
    await refresh();
    useSearchStore().schedule();
    return true;
  }

  /** 从文件树中隐藏（不影响搜索、快速打开和链接） */
  function hide(path: string) {
    if (!path || hidden.value.includes(path)) return;
    hidden.value = [...hidden.value, path];
    if (selected.value && isWithin(selected.value, path)) selected.value = null;
    if (renaming.value && isWithin(renaming.value, path)) renaming.value = null;
  }

  function unhide(path: string) {
    hidden.value = hidden.value.filter((p) => p !== path);
  }

  function unhideAll() {
    hidden.value = [];
  }

  function setSort(key: SortKey, desc = sortDesc.value) {
    sortKey.value = key;
    sortDesc.value = desc;
    if (root.value) void writeSort(root.value, { key, desc });
  }

  /** 同步前调用：没有打开笔记库时提示，并打开“笔记库”对话框以便新建或打开 */
  function requireForSync(): boolean {
    if (root.value) return true;
    notice().inform(NEED_VAULT_FOR_SYNC);
    useUiStore().vaultOpen = true;
    return false;
  }

  function absolutePath(path: string): string {
    if (!root.value) return path;
    const sep = root.value.includes("\\") ? "\\" : "/";
    const base = root.value.replace(/[\\/]+$/, "");
    return path ? `${base}${sep}${path.split("/").join(sep)}` : base;
  }

  return {
    root, tree, sortedTree, expanded, selected, renaming, sortKey, sortDesc, customOrder, favorites, loadError, switching, name,
    openVault, pickAndOpen, refresh, reloadConfig, appendToOrder, node, toggle, expand, collapseAll, reveal, targetDir,
    newNote, newDoc, newBook, createDocIn, newFolder, rename, move, place, trash, setSort, absolutePath, requireForSync,
    favoriteList, toggleFavorite, reorderFavorite, notePaths, docPaths, bookPaths, linkPaths, hidden, hide, unhide, unhideAll,
  };
});
