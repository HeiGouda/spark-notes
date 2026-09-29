import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { TreeNode } from "../lib/api";

const calls: string[] = [];
const configs = new Map<string, string>();
const writeNote = vi.fn(async (..._args: unknown[]) => {});
let tree: TreeNode[] = [];
let rewritten: string[] = [];
const askMock = vi.fn(async () => true);

const file = (path: string): TreeNode => ({ name: path.split("/").pop()!.replace(/\.md$/, ""), path, isDir: false, children: [], modifiedMs: 0, createdMs: 0 });
const dir = (path: string, children: TreeNode[]): TreeNode => ({ name: path.split("/").pop()!, path, isDir: true, children, modifiedMs: 0, createdMs: 0 });

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: {
    scanVault: vi.fn(async () => tree),
    readNote: vi.fn(async () => ({ content: "x\n", createdMs: 0 })),
    writeNote,
    rename: vi.fn(async (_r: string, path: string, name: string) => {
      calls.push(`rename ${path} ${name}`);
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      return parent + name + (path.endsWith(".md") ? ".md" : "");
    }),
    move: vi.fn(async (_r: string, path: string, target: string) => {
      calls.push(`move ${path} ${target}`);
      return (target ? target + "/" : "") + path.split("/").pop();
    }),
    trash: vi.fn(async (_r: string, path: string) => {
      calls.push(`trash ${path}`);
    }),
    indexSync: vi.fn(async () => {
      calls.push("indexSync");
      return { indexed: 0, removed: 0, total: 0 };
    }),
    rewriteLinks: vi.fn(async (_r: string, from: string, to: string) => {
      calls.push(`rewriteLinks ${from} ${to}`);
      return rewritten;
    }),
    readConfig: vi.fn(async (_r: string, name: string) => configs.get(name) ?? null),
    writeConfig: vi.fn(async (_r: string, name: string, content: string) => {
      configs.set(name, content);
    }),
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: (...a: unknown[]) => askMock(...(a as [])), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

const { useVaultStore } = await import("./vault");
const { useTabsStore } = await import("./tabs");

describe("vault store 文件操作", () => {
  beforeEach(() => {
    vi.stubGlobal("window", globalThis);
    setActivePinia(createPinia());
    calls.length = 0;
    configs.clear();
    writeNote.mockReset();
    writeNote.mockResolvedValue(undefined);
    askMock.mockClear();
    askMock.mockResolvedValue(true);
    tree = [dir("d", [file("d/a.md"), file("d/b.md")]), file("c.md")];
    const vault = useVaultStore();
    vault.root = "C:/vault";
    vault.tree = tree;
  });

  it("重命名文件夹：展开状态、自定义排序、已打开的标签页跟着改", async () => {
    const vault = useVaultStore();
    const tabs = useTabsStore();
    vault.expanded = new Set(["d"]);
    vault.customOrder = { "": ["d", "c.md"], d: ["b.md", "a.md"] };
    await tabs.open("d/a.md");
    expect(await vault.rename("d", "e")).toBe("e");
    expect([...vault.expanded]).toEqual(["e"]);
    expect(vault.customOrder).toEqual({ "": ["e", "c.md"], e: ["b.md", "a.md"] });
    expect(JSON.parse(configs.get("order.json")!)).toEqual(vault.customOrder);
    expect(tabs.activePath).toBe("e/a.md");
  });

  it("名称不变或为空时不调用后端", async () => {
    const vault = useVaultStore();
    expect(await vault.rename("c.md", "c")).toBe("c.md");
    expect(await vault.rename("c.md", "  ")).toBe("c.md");
    expect(calls).toEqual([]);
  });

  it("改名后改写链接、重新载入被改写的已打开笔记，最后才更新索引", async () => {
    const vault = useVaultStore();
    const tabs = useTabsStore();
    await tabs.open("c.md");
    await tabs.open("d/b.md");
    rewritten = ["c.md"];
    await vault.rename("d/b.md", "新");
    rewritten = [];
    expect(calls.slice(0, 2)).toEqual(["rename d/b.md 新", "rewriteLinks d/b.md d/新.md"]);
    await vi.waitFor(() => expect(calls).toContain("indexSync"));
    expect(calls.indexOf("indexSync")).toBeGreaterThan(1);
    expect(tabs.tabs.map((t) => t.path)).toEqual(["c.md", "d/新.md"]);
  });

  it("收藏随改名更新、随删除移除，并写入 favorites.json", async () => {
    const vault = useVaultStore();
    vault.toggleFavorite("d");
    vault.toggleFavorite("c.md");
    await vault.rename("d", "e");
    expect(vault.favoriteList).toEqual(["e", "c.md"]);
    await vault.trash("c.md");
    expect(vault.favoriteList).toEqual(["e"]);
    await vi.waitFor(() => expect(JSON.parse(configs.get("favorites.json")!)).toEqual(["e"]));
  });

  it("自定义排序：拖到另一个文件夹的项前面时先移动再排序", async () => {
    const vault = useVaultStore();
    vault.sortKey = "custom";
    await vault.place("c.md", "d/b.md", "before");
    expect(calls.slice(0, 2)).toEqual(["move c.md d", "rewriteLinks c.md d/c.md"]);
    expect(vault.customOrder.d).toEqual(["a.md", "c.md", "b.md"]);
  });

  it("删除需要确认；取消时不删除", async () => {
    const vault = useVaultStore();
    askMock.mockResolvedValueOnce(false);
    await vault.trash("c.md");
    expect(calls).toEqual([]);
    await vault.trash("c.md");
    expect(calls).toEqual(["trash c.md"]);
  });

  it("保存失败时取消删除，未保存的内容还在", async () => {
    const vault = useVaultStore();
    const tabs = useTabsStore();
    await tabs.open("c.md");
    tabs.update("c.md", "未保存\n");
    writeNote.mockRejectedValueOnce(new Error("磁盘已满"));
    askMock.mockResolvedValueOnce(true);
    askMock.mockResolvedValueOnce(false);
    await vault.trash("c.md");
    expect(calls.filter((c) => c.startsWith("trash"))).toEqual([]);
    expect(tabs.active?.path).toBe("c.md");
    expect(tabs.active?.body).toBe("未保存\n");
  });

  it("保存失败后确认放弃修改，仍然删除", async () => {
    const vault = useVaultStore();
    const tabs = useTabsStore();
    await tabs.open("c.md");
    tabs.update("c.md", "未保存\n");
    writeNote.mockRejectedValueOnce(new Error("磁盘已满"));
    await vault.trash("c.md");
    expect(calls).toContain("trash c.md");
    expect(tabs.tabs.find((t) => t.path === "c.md")).toBeUndefined();
  });

  it("新建位置：选中的文件夹 > 选中项所在文件夹 > 当前笔记所在文件夹 > 根目录", async () => {
    const vault = useVaultStore();
    const tabs = useTabsStore();
    expect(vault.targetDir()).toBe("");
    await tabs.open("d/a.md");
    expect(vault.targetDir()).toBe("d");
    vault.selected = "c.md";
    expect(vault.targetDir()).toBe("");
    vault.selected = "d";
    expect(vault.targetDir()).toBe("d");
  });
});
