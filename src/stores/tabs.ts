import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, baseName, isWithin, remapPath } from "../lib/api";
import { formatDate, joinFrontMatter, parseMeta, setFrontMatterTags, splitFrontMatter } from "../lib/frontmatter";
import { applyEol, detectEol, toLf, type Eol } from "../lib/eol";
import { useVaultStore } from "./vault";
import { useNoticeStore } from "./notice";
import { useEditorStore } from "./editor";
import { useSearchStore } from "./search";

export type SaveStatus = "saved" | "dirty" | "saving" | "error";

export interface Tab {
  path: string;
  /** 文件名即标题（不含 .md） */
  name: string;
  /** 预览标签页：标题斜体，单击其他笔记时被替换；编辑或双击后固定 */
  preview: boolean;
  frontMatter: string;
  savedFrontMatter: string;
  /** 原文件的换行符，保存时还原 */
  eol: Eol;
  body: string;
  savedBody: string;
  tags: string[];
  created: string | null;
  status: SaveStatus;
  error: string | null;
  savedAt: number | null;
}

const AUTOSAVE_DELAY = 1000;
const HISTORY_LIMIT = 100;

export function nameOf(path: string): string {
  return baseName(path).replace(/\.md$/i, "");
}

export const useTabsStore = defineStore("tabs", () => {
  const tabs = ref<Tab[]>([]);
  const activePath = ref<string | null>(null);
  /** 正文每次变化加一，供自动提交判断“停止编辑” */
  const editedTick = ref(0);
  /** 成功保存到磁盘后加一，供同步在保存后延迟触发 */
  const savedTick = ref(0);
  /** 笔记跳转历史，用于后退 / 前进 */
  const history = ref<string[]>([]);
  const historyIndex = ref(-1);
  const timers = new Map<string, number>();
  const inflight = new Map<string, Promise<boolean>>();

  const active = computed(() => tabs.value.find((t) => t.path === activePath.value) ?? null);
  const canBack = computed(() => historyIndex.value > 0);
  const canForward = computed(() => historyIndex.value < history.value.length - 1);

  function find(path: string) {
    return tabs.value.find((t) => t.path === path);
  }

  function setActive(path: string | null, record = true) {
    activePath.value = path;
    if (!path) return;
    useVaultStore().reveal(path);
    if (!record || history.value[historyIndex.value] === path) return;
    const next = history.value.slice(0, historyIndex.value + 1);
    next.push(path);
    if (next.length > HISTORY_LIMIT) next.shift();
    history.value = next;
    historyIndex.value = next.length - 1;
  }

  async function load(path: string, preview: boolean): Promise<Tab | null> {
    const vault = useVaultStore();
    if (!vault.root) return null;
    const file = await api.readNote(vault.root, path);
    const eol = detectEol(file.content);
    const { frontMatter, body } = splitFrontMatter(toLf(file.content));
    const meta = parseMeta(frontMatter);
    return {
      path,
      name: nameOf(path),
      preview,
      frontMatter,
      savedFrontMatter: frontMatter,
      eol,
      body,
      savedBody: body,
      tags: meta.tags,
      created: meta.created ?? (file.createdMs != null ? formatDate(file.createdMs) : null),
      status: "saved",
      error: null,
      savedAt: null,
    };
  }

  /**
   * 打开笔记。`preview` 为 true 时（文件树单击）复用现有的预览标签页；
   * 已打开的笔记只激活，若以固定方式打开则同时固定。
   */
  async function open(path: string, opts: { preview?: boolean; record?: boolean } = {}): Promise<boolean> {
    const preview = opts.preview ?? false;
    const existing = find(path);
    if (existing) {
      if (!preview) existing.preview = false;
      setActive(path, opts.record ?? true);
      return true;
    }
    let tab: Tab | null;
    try {
      tab = await load(path, preview);
    } catch (e) {
      useNoticeStore().report(`打开笔记失败 ${path}`, e);
      return false;
    }
    if (!tab) return false;
    // 读取期间同一笔记的另一次打开可能已经先完成
    const raced = find(path);
    if (raced) {
      if (!preview) raced.preview = false;
      setActive(path, opts.record ?? true);
      return true;
    }
    // 先把编辑器里尚未经防抖同步的修改收进来，已编辑的预览标签页会因此被固定，不会被替换
    if (preview) useEditorStore().pull();
    const reusable = preview ? tabs.value.findIndex((t) => t.preview && t.status === "saved") : -1;
    if (reusable >= 0) {
      tabs.value.splice(reusable, 1, tab);
    } else {
      const at = tabs.value.findIndex((t) => t.path === activePath.value);
      tabs.value.splice(at >= 0 ? at + 1 : tabs.value.length, 0, tab);
    }
    setActive(path, opts.record ?? true);
    return true;
  }

  function pin(path: string) {
    const tab = find(path);
    if (tab) tab.preview = false;
  }

  function update(path: string, body: string) {
    const tab = find(path);
    if (!tab || tab.body === body) return;
    tab.body = body;
    touch(tab);
  }

  /** 改写 Front Matter 里的标签，随正文一起自动保存 */
  function setTags(path: string, tags: string[]) {
    const tab = find(path);
    if (!tab) return;
    const fm = setFrontMatterTags(tab.frontMatter, tags);
    if (fm === tab.frontMatter) return;
    tab.frontMatter = fm;
    tab.tags = parseMeta(fm).tags;
    touch(tab);
  }

  function touch(tab: Tab) {
    tab.preview = false;
    if (tab.status !== "saving") tab.status = unchanged(tab) ? "saved" : "dirty";
    editedTick.value++;
    schedule(tab.path);
  }

  function unchanged(tab: Tab) {
    return tab.body === tab.savedBody && tab.frontMatter === tab.savedFrontMatter;
  }

  function schedule(path: string) {
    const prev = timers.get(path);
    if (prev) clearTimeout(prev);
    timers.set(path, window.setTimeout(() => {
      timers.delete(path);
      void save(path);
    }, AUTOSAVE_DELAY));
  }

  function cancelTimer(path: string) {
    const timer = timers.get(path);
    if (timer) {
      clearTimeout(timer);
      timers.delete(path);
    }
  }

  /** 立即保存；返回是否成功（没有改动也算成功） */
  async function save(path: string): Promise<boolean> {
    useEditorStore().pull(path);
    cancelTimer(path);
    const running = inflight.get(path);
    if (running) {
      await running;
    }
    const tab = find(path);
    const vault = useVaultStore();
    if (!tab || !vault.root) return true;
    if (unchanged(tab) && tab.status !== "error") return true;

    const snapshot = tab.body;
    const fmSnapshot = tab.frontMatter;
    tab.status = "saving";
    const job = api
      .writeNote(vault.root, tab.path, applyEol(joinFrontMatter(fmSnapshot, snapshot), tab.eol))
      .then(() => {
        tab.savedBody = snapshot;
        tab.savedFrontMatter = fmSnapshot;
        tab.savedAt = Date.now();
        tab.error = null;
        tab.status = unchanged(tab) ? "saved" : "dirty";
        if (tab.status === "dirty") schedule(tab.path);
        useSearchStore().schedule();
        savedTick.value++;
        return true;
      })
      .catch((e) => {
        tab.status = "error";
        tab.error = String(e);
        useNoticeStore().report(`保存失败 ${tab.name}`, e);
        return false;
      })
      .finally(() => inflight.delete(path));
    inflight.set(path, job);
    return job;
  }

  async function saveActive(): Promise<boolean> {
    return activePath.value ? save(activePath.value) : true;
  }

  async function flushAll(): Promise<boolean> {
    const results = await Promise.all(tabs.value.map((t) => save(t.path)));
    return results.every(Boolean);
  }

  /** 保存某路径（文件或文件夹）下所有已打开的笔记，文件操作前调用 */
  async function flushUnder(prefix: string): Promise<boolean> {
    const results = await Promise.all(tabs.value.filter((t) => isWithin(t.path, prefix)).map((t) => save(t.path)));
    return results.every(Boolean);
  }

  function removeTab(path: string) {
    const idx = tabs.value.findIndex((t) => t.path === path);
    if (idx < 0) return;
    cancelTimer(path);
    tabs.value.splice(idx, 1);
    if (activePath.value === path) {
      const next = tabs.value[idx] ?? tabs.value[idx - 1] ?? null;
      setActive(next?.path ?? null, false);
    }
  }

  /** 关闭前先保存；保存失败时让用户决定是否放弃修改，避免静默丢数据 */
  async function close(path: string): Promise<boolean> {
    const tab = find(path);
    if (!tab) return true;
    if (!(await save(path))) {
      const discard = await ask(`“${tab.name}”保存失败：${tab.error}\n\n仍要关闭并放弃未保存的修改吗？`, {
        title: "Spark",
        kind: "warning",
        okLabel: "放弃修改并关闭",
        cancelLabel: "取消",
      });
      if (!discard) return false;
    }
    removeTab(path);
    return true;
  }

  async function closeMany(paths: string[]): Promise<boolean> {
    for (const p of paths) {
      if (!(await close(p))) return false;
    }
    return true;
  }

  const closeAll = () => closeMany(tabs.value.map((t) => t.path));
  const closeOthers = (path: string) => closeMany(tabs.value.filter((t) => t.path !== path).map((t) => t.path));
  function closeRight(path: string) {
    const idx = tabs.value.findIndex((t) => t.path === path);
    return closeMany(tabs.value.slice(idx + 1).map((t) => t.path));
  }

  function activate(path: string) {
    if (find(path)) setActive(path);
  }

  function cycle(delta: number) {
    const n = tabs.value.length;
    if (n < 2) return;
    const idx = tabs.value.findIndex((t) => t.path === activePath.value);
    setActive(tabs.value[(idx + delta + n) % n].path);
  }

  function reorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= tabs.value.length || to >= tabs.value.length) return;
    const [tab] = tabs.value.splice(from, 1);
    tabs.value.splice(to, 0, tab);
  }

  async function go(delta: number) {
    const target = historyIndex.value + delta;
    const path = history.value[target];
    if (path === undefined) return;
    if (await open(path, { record: false })) {
      historyIndex.value = target;
    } else {
      history.value = history.value.filter((p) => p !== path);
      historyIndex.value = Math.min(historyIndex.value, history.value.length - 1);
    }
  }
  const back = () => go(-1);
  const forward = () => go(1);

  /** 文件或文件夹改名 / 移动后，把已打开的标签页和历史指向新路径 */
  function remap(from: string, to: string) {
    for (const tab of tabs.value) {
      if (!isWithin(tab.path, from)) continue;
      const old = tab.path;
      const dirty = timers.has(old);
      cancelTimer(old);
      tab.path = remapPath(old, from, to);
      tab.name = nameOf(tab.path);
      if (dirty) schedule(tab.path);
    }
    if (activePath.value) activePath.value = remapPath(activePath.value, from, to);
    history.value = history.value.map((p) => remapPath(p, from, to));
  }

  /** 从磁盘重新读取（例如改名后附件引用已被更新），调用前应已保存 */
  async function reload(path: string) {
    const idx = tabs.value.findIndex((t) => t.path === path);
    if (idx < 0) return;
    try {
      const fresh = await load(path, tabs.value[idx].preview);
      if (fresh) tabs.value.splice(idx, 1, fresh);
    } catch (e) {
      useNoticeStore().report(`重新读取笔记失败 ${path}`, e);
    }
  }

  /** 路径已被删除（移入回收站）：关闭其下的标签页并清理历史，不再保存 */
  function dropUnder(prefix: string) {
    for (const t of tabs.value.filter((t) => isWithin(t.path, prefix))) removeTab(t.path);
    const kept = history.value.filter((p) => !isWithin(p, prefix));
    const removedBefore = history.value.slice(0, historyIndex.value + 1).filter((p) => isWithin(p, prefix)).length;
    history.value = kept;
    historyIndex.value = Math.min(Math.max(historyIndex.value - removedBefore, kept.length ? 0 : -1), kept.length - 1);
  }

  /** 恢复上次会话；返回打不开的笔记数量 */
  async function restore(paths: string[], activeTab: string | null): Promise<number> {
    let missing = 0;
    for (const p of paths) {
      const ok = await open(p, { record: false }).catch(() => false);
      if (!ok) missing++;
    }
    if (activeTab && find(activeTab)) setActive(activeTab);
    return missing;
  }

  function resetHistory() {
    history.value = [];
    historyIndex.value = -1;
  }

  /** 打开后需要定位的位置：搜索命中的文字，或 [[笔记#标题]] 的标题 */
  const pendingReveal = ref<{ path: string; heading?: string; text?: string } | null>(null);

  async function openAt(path: string, target: { heading?: string; text?: string }, preview = false) {
    pendingReveal.value = { path, ...target };
    if (!(await open(path, { preview }))) pendingReveal.value = null;
  }

  /** 文件被外部程序修改：未编辑的标签页直接重新载入；有未保存修改时询问 */
  async function onExternalChange(paths: string[]) {
    const vault = useVaultStore();
    if (!vault.root) return;
    const changed = new Set(paths);
    for (const tab of [...tabs.value]) {
      if (!changed.has(tab.path) || inflight.has(tab.path)) continue;
      let content: string;
      try {
        content = (await api.readNote(vault.root, tab.path)).content;
      } catch {
        // 文件被删除或移走：保留标签页里的内容，由用户决定是否另存
        if (vault.node(tab.path)) continue;
        useNoticeStore().report(`“${tab.name}”已在外部被删除或移动`, "标签页中的内容尚未丢失，编辑后会重新保存到原位置");
        continue;
      }
      const { frontMatter, body } = splitFrontMatter(toLf(content));
      if (body === tab.savedBody && frontMatter === tab.savedFrontMatter) continue;
      // 编辑器防抖期间敲下的内容还没进标签页，先收进来，否则会被当成未编辑而直接重载
      useEditorStore().pull(tab.path);
      if (tab.status === "saved") {
        await reload(tab.path);
        continue;
      }
      const useExternal = await ask(`“${tab.name}”已在外部被修改，而这里还有未保存的修改。\n\n载入外部版本（放弃这里的修改），还是保留这里的内容（稍后覆盖外部版本）？`, {
        title: "Spark",
        kind: "warning",
        okLabel: "载入外部版本",
        cancelLabel: "保留这里的内容",
      });
      if (useExternal) {
        cancelTimer(tab.path);
        await reload(tab.path);
      }
    }
  }

  return {
    tabs, activePath, active, canBack, canForward, history, editedTick, savedTick,
    open, pin, update, setTags, save, saveActive, flushAll, flushUnder, close, closeAll, closeOthers, closeRight,
    activate, cycle, reorder, back, forward, remap, reload, dropUnder, restore, resetHistory,
    pendingReveal, openAt, onExternalChange,
  };
});
