import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import type { TreeNode } from "../lib/api";

const files = new Map<string, string>();
const setBookOrder = vi.fn(async () => {});
const scanVault = vi.fn(async () => ({ nodes: [] as TreeNode[], warning: null }));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: {
    scanVault: (...args: []) => scanVault(...args),
    readNote: vi.fn(async (_root: string, path: string) => {
      if (!files.has(path)) throw new Error(`not found: ${path}`);
      return { content: files.get(path)!, createdMs: 0 };
    }),
    writeNote: vi.fn(async () => {}),
    indexSync: vi.fn(async () => ({ indexed: 0, removed: 0, total: 0 })),
    setBookOrder: (...args: []) => setBookOrder(...args),
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

const { useTabsStore } = await import("./tabs");
const { useVaultStore } = await import("./vault");
const { useBookStore } = await import("./book");

const file = (path: string): TreeNode => ({
  name: path.split("/").pop()!.replace(/(\.mind\.mmd|\.flow\.mmd|\.md)$/, ""),
  path,
  isDir: false,
  children: [],
  modifiedMs: 1,
  createdMs: 1,
});
const book = (path: string, sheets: string[]): TreeNode => ({
  name: path.replace(/\.book$/, ""),
  path,
  isDir: true,
  children: sheets.map((s) => file(`${path}/${s}`)),
  modifiedMs: 1,
  createdMs: 1,
  book: { unsupported: [], warning: null },
});

describe("表格簿", () => {
  beforeEach(() => {
    vi.stubGlobal("window", globalThis);
    vi.useFakeTimers();
    setActivePinia(createPinia());
    files.clear();
    setBookOrder.mockClear();
    for (const p of ["a.md", "周报.book/本周.md", "周报.book/路线.mind.mmd", "周报.book/上周.md", "b.md"]) files.set(p, "");
    const vault = useVaultStore();
    vault.root = "C:/vault";
    vault.tree = [file("a.md"), book("周报.book", ["本周.md", "路线.mind.mmd", "上周.md"]), file("b.md")];
    scanVault.mockImplementation(async () => ({ nodes: vault.tree, warning: null }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("打开表格簿：第一次停在第一张表，之后停在上次看的那张", async () => {
    const tabs = useTabsStore();
    const books = useBookStore();
    await tabs.open("周报.book");
    expect(tabs.activePath).toBe("周报.book/本周.md");
    expect(books.activeBook).toBe("周报.book");
    expect(books.sheets.map((s) => s.name)).toEqual(["本周", "路线", "上周"]);

    await books.openSheet("周报.book/路线.mind.mmd");
    await nextTick();
    await tabs.open("a.md");
    await tabs.open("周报.book");
    expect(tabs.activePath).toBe("周报.book/路线.mind.mmd");
  });

  it("记住的那张表已经不存在时停在第一张", async () => {
    const tabs = useTabsStore();
    const books = useBookStore();
    await books.openSheet("周报.book/上周.md");
    await nextTick();
    useVaultStore().tree = [book("周报.book", ["本周.md", "路线.mind.mmd"])];
    await tabs.closeGroup("周报.book/上周.md");
    await tabs.open("周报.book");
    expect(tabs.activePath).toBe("周报.book/本周.md");
  });

  it("顶部标签页：同一个表格簿的表算一项，切换和关闭都按这一项", async () => {
    const tabs = useTabsStore();
    const books = useBookStore();
    await tabs.open("a.md");
    await tabs.open("周报.book");
    await books.openSheet("周报.book/上周.md");
    await tabs.open("b.md");
    // 新标签总是插在当前标签后面
    expect(tabs.tabs.map((t) => t.path)).toEqual(["a.md", "周报.book/本周.md", "周报.book/上周.md", "b.md"]);

    // 当前在 b.md：往前一项是表格簿（回到它上次看的上周），再往前是 a.md
    tabs.cycle(-1);
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(tabs.activePath).toBe("周报.book/上周.md");
    tabs.cycle(-1);
    expect(tabs.activePath).toBe("a.md");

    expect(await tabs.closeGroup("周报.book/本周.md")).toBe(true);
    expect(tabs.tabs.map((t) => t.path)).not.toContain("周报.book/上周.md");
    expect(tabs.tabs.map((t) => t.path).sort()).toEqual(["a.md", "b.md"]);
  });

  it("上一张 / 下一张表到头后绕回", async () => {
    const tabs = useTabsStore();
    const books = useBookStore();
    await tabs.open("周报.book");
    await books.go(1);
    expect(tabs.activePath).toBe("周报.book/路线.mind.mmd");
    await books.go(1);
    await books.go(1);
    expect(tabs.activePath).toBe("周报.book/本周.md");
    await books.go(-1);
    expect(tabs.activePath).toBe("周报.book/上周.md");
  });

  it("拖动排序只保存文件名顺序", async () => {
    const tabs = useTabsStore();
    const books = useBookStore();
    await tabs.open("周报.book");
    await books.reorder(2, 0);
    expect(setBookOrder).toHaveBeenCalledWith("C:/vault", "周报.book", ["上周.md", "本周.md", "路线.mind.mmd"]);
  });

  it("至少保留一张表：只剩一张时不删除", async () => {
    const tabs = useTabsStore();
    const books = useBookStore();
    useVaultStore().tree = [book("周报.book", ["本周.md"])];
    await tabs.open("周报.book");
    const trash = vi.spyOn(useVaultStore(), "trash");
    await books.deleteSheet("周报.book/本周.md");
    expect(trash).not.toHaveBeenCalled();
  });

  it("在表格簿里新建的内容不会落在簿里：新建位置跳到表格簿所在的文件夹", async () => {
    const tabs = useTabsStore();
    const vault = useVaultStore();
    await tabs.open("周报.book");
    expect(vault.targetDir()).toBe("");
    vault.selected = "周报.book";
    expect(vault.targetDir()).toBe("");
  });
});