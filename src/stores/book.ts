import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, baseName } from "../lib/api";
import { bookOf } from "../lib/book";
import { docKind, type DocKind } from "../lib/doctype";
import { useNoticeStore } from "./notice";
import { useSearchStore } from "./search";
import { useSettingsStore } from "./settings";
import { useTabsStore } from "./tabs";
import { useVaultStore } from "./vault";

/** 表格簿底部标签栏里的一项 */
export interface SheetItem {
  /** 表的相对路径；AI 生成中的草稿是还没有文件的预定路径 */
  path: string;
  name: string;
  kind: DocKind;
  draft: boolean;
}

/**
 * 表格簿：打开一个表格簿占一个顶部标签页，里面每张表仍是普通的笔记 / 图标签页（各自保存、各自保留编辑状态），
 * 顶部标签栏把同一表格簿的表合并成一项，底部标签栏切换表。
 */
export const useBookStore = defineStore("book", () => {
  const notice = () => useNoticeStore();
  /** 正在就地改名的表（底部标签变成输入框） */
  const renaming = ref<string | null>(null);

  /** 当前显示的表所在的表格簿 */
  const activeBook = computed(() => {
    const p = useTabsStore().activePath;
    return p ? bookOf(p) : null;
  });

  const activeNode = computed(() => (activeBook.value ? useVaultStore().node(activeBook.value) : null));

  /** 当前表格簿的各张表：磁盘上的表按簿内顺序，AI 生成中的草稿排在最后 */
  const sheets = computed<SheetItem[]>(() => {
    const book = activeBook.value;
    if (!book) return [];
    const tabs = useTabsStore();
    const real: SheetItem[] = (activeNode.value?.children ?? []).map((n) => ({
      path: n.path,
      name: n.name,
      kind: docKind(n.path) ?? "note",
      draft: false,
    }));
    const drafts: SheetItem[] = tabs.tabs
      .filter((t) => t.draft && bookOf(t.path) === book)
      .map((t) => ({ path: t.path, name: t.name, kind: t.kind, draft: true }));
    return [...real, ...drafts];
  });

  /** 表格簿里不能显示的项目、顺序文件的问题，显示在标签栏末尾 */
  const unsupported = computed(() => activeNode.value?.book?.unsupported ?? []);
  const warning = computed(() => activeNode.value?.book?.warning ?? null);

  function lastSheet(book: string): string | null {
    const root = useVaultStore().root;
    return root ? (useSettingsStore().vaultUi(root).bookSheets?.[book] ?? null) : null;
  }

  // 记住每个表格簿停在哪张表（只在本机）
  watch(
    () => {
      const tab = useTabsStore().active;
      return tab && !tab.draft ? tab.path : null;
    },
    (path) => {
      const root = useVaultStore().root;
      const book = path ? bookOf(path) : null;
      if (!root || !path || !book) return;
      const settings = useSettingsStore();
      const current = settings.vaultUi(root).bookSheets ?? {};
      if (current[book] !== path) settings.patchVaultUi(root, { bookSheets: { ...current, [book]: path } });
    },
  );

  /** 切换到某张表（已有标签页就激活，没有就打开） */
  function openSheet(path: string): Promise<boolean> {
    return useTabsStore().open(path);
  }

  /** 打开表格簿：停在上次看的那张表，没有记录或那张表已不存在时停在第一张 */
  async function openBook(book: string): Promise<boolean> {
    const vault = useVaultStore();
    const node = vault.node(book);
    if (!node?.book) {
      notice().report("打开表格簿失败", `找不到表格簿：${book}`);
      return false;
    }
    if (!node.children.length) {
      // 外部删光了里面的表：补一张空笔记，表格簿至少保留一张表
      return (await newSheet("note", book)) !== null;
    }
    const last = lastSheet(book);
    const target = node.children.find((c) => c.path === last) ?? node.children[0];
    return openSheet(target.path);
  }

  /** 在当前表格簿（或指定的表格簿）末尾新建一张表，并进入改名状态；返回新表的路径 */
  async function newSheet(kind: DocKind, book = activeBook.value): Promise<string | null> {
    const vault = useVaultStore();
    if (!vault.root || !book) return null;
    try {
      const rel = await vault.createDocIn(book, kind);
      await vault.refresh();
      if (!(await openSheet(rel))) return null;
      renaming.value = rel;
      useSearchStore().schedule();
      return rel;
    } catch (e) {
      notice().report("新建表失败", e);
      return null;
    }
  }

  /** 表改名：同一个簿内不能重名；其他笔记里指向它的双链会自动改写 */
  async function renameSheet(path: string, name: string): Promise<string | null> {
    return useVaultStore().rename(path, name);
  }

  async function duplicateSheet(path: string): Promise<void> {
    const vault = useVaultStore();
    if (!vault.root) return;
    try {
      if (!(await useTabsStore().flushUnder(path))) {
        notice().report("复制失败", "这张表保存失败，请先处理");
        return;
      }
      const rel = await api.duplicateSheet(vault.root, path);
      await vault.refresh();
      await openSheet(rel);
      useSearchStore().schedule();
    } catch (e) {
      notice().report("复制表失败", e);
    }
  }

  /** 删除表（移入回收站，先确认）。表格簿至少保留一张表；删除当前表后切到相邻的表 */
  async function deleteSheet(path: string): Promise<void> {
    const list = sheets.value.filter((s) => !s.draft);
    const idx = list.findIndex((s) => s.path === path);
    if (idx < 0) return;
    if (list.length <= 1) {
      notice().inform("表格簿至少保留一张表；要删除整个表格簿，请在侧边栏操作");
      return;
    }
    const neighbor = list[idx + 1] ?? list[idx - 1];
    const wasActive = useTabsStore().activePath === path;
    if (!(await useVaultStore().trash(path))) return;
    if (wasActive) await openSheet(neighbor.path);
  }

  /** 拖动排序：把第 from 张表放到第 to 张的位置，只改 .book.json */
  async function reorder(from: number, to: number): Promise<void> {
    const vault = useVaultStore();
    const book = activeBook.value;
    const list = sheets.value.filter((s) => !s.draft);
    if (!vault.root || !book || from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
    const names = list.map((s) => baseName(s.path));
    const [moved] = names.splice(from, 1);
    names.splice(to, 0, moved);
    try {
      await api.setBookOrder(vault.root, book, names);
      await vault.refresh();
    } catch (e) {
      notice().report("保存表的顺序失败", e);
    }
  }

  /** 切换到上一张 / 下一张表，到头后绕回 */
  async function go(delta: number): Promise<void> {
    const list = sheets.value;
    if (list.length < 2) return;
    const cur = list.findIndex((s) => s.path === useTabsStore().activePath);
    const next = list[(cur + delta + list.length) % list.length];
    if (next.draft) useTabsStore().activate(next.path);
    else await openSheet(next.path);
  }

  /** 在文件管理器里打开表格簿文件夹（查看无法显示的项目） */
  async function revealBook(): Promise<void> {
    const vault = useVaultStore();
    const book = activeBook.value;
    if (!book) return;
    try {
      await revealItemInDir(vault.absolutePath(book));
    } catch (e) {
      notice().report("打开表格簿文件夹失败", e);
    }
  }

  return {
    renaming, activeBook, sheets, unsupported, warning,
    openBook, openSheet, newSheet, renameSheet, duplicateSheet, deleteSheet, reorder, go, revealBook, lastSheet,
  };
});
