import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const files = new Map<string, string>();
const writeNote = vi.fn(async (_root: string, path: string, content: string) => {
  files.set(path, content);
});

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: {
    scanVault: vi.fn(async () => []),
    readNote: vi.fn(async (_root: string, path: string) => {
      if (!files.has(path)) throw new Error(`not found: ${path}`);
      return { content: files.get(path)!, createdMs: 0 };
    }),
    writeNote: (...args: [string, string, string]) => writeNote(...args),
    indexSync: vi.fn(async () => ({ indexed: 0, removed: 0, total: 0 })),
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => false), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

const { useTabsStore } = await import("./tabs");
const { useVaultStore } = await import("./vault");
const { useEditorStore } = await import("./editor");
type Editor = import("@milkdown/kit/core").Editor;

describe("tabs store 自动保存", () => {
  beforeEach(() => {
    vi.stubGlobal("window", globalThis);
    vi.useFakeTimers();
    setActivePinia(createPinia());
    files.clear();
    writeNote.mockClear();
    useVaultStore().root = "C:/vault";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("打开不写盘；编辑 1 秒后保存，保留 Front Matter 和 CRLF", async () => {
    files.set("n.md", "---\r\ntags: [a]\r\n---\r\n\r\n旧正文\r\n");
    const tabs = useTabsStore();
    await tabs.open("n.md");
    expect(tabs.active?.body).toBe("旧正文\n");
    expect(tabs.active?.tags).toEqual(["a"]);

    tabs.update("n.md", "新正文\n\n第二段\n");
    expect(tabs.active?.status).toBe("dirty");
    await vi.advanceTimersByTimeAsync(999);
    expect(writeNote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(files.get("n.md")).toBe("---\r\ntags: [a]\r\n---\r\n\r\n新正文\r\n\r\n第二段\r\n");
    expect(tabs.active?.status).toBe("saved");
  });

  it("连续输入只在停止后保存一次", async () => {
    files.set("n.md", "a\n");
    const tabs = useTabsStore();
    await tabs.open("n.md");
    for (const s of ["ab\n", "abc\n", "abcd\n"]) {
      tabs.update("n.md", s);
      await vi.advanceTimersByTimeAsync(500);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(writeNote).toHaveBeenCalledTimes(1);
    expect(files.get("n.md")).toBe("abcd\n");
  });

  it("保存失败时标记错误，关闭标签页需要用户确认", async () => {
    files.set("n.md", "a\n");
    const tabs = useTabsStore();
    await tabs.open("n.md");
    writeNote.mockRejectedValueOnce("磁盘已满");
    tabs.update("n.md", "b\n");
    expect(await tabs.save("n.md")).toBe(false);
    expect(tabs.active?.status).toBe("error");
    // ask() 被模拟为用户点了“取消”，标签页不能被关闭
    writeNote.mockRejectedValueOnce("磁盘已满");
    expect(await tabs.close("n.md")).toBe(false);
    expect(tabs.tabs).toHaveLength(1);
  });

  it("预览标签页：单击其他笔记时被替换，编辑后固定", async () => {
    files.set("a.md", "a\n");
    files.set("b.md", "b\n");
    files.set("c.md", "c\n");
    const tabs = useTabsStore();
    await tabs.open("a.md", { preview: true });
    await tabs.open("b.md", { preview: true });
    expect(tabs.tabs.map((t) => t.path)).toEqual(["b.md"]);
    tabs.update("b.md", "b2\n");
    expect(tabs.active?.preview).toBe(false);
    await tabs.open("c.md", { preview: true });
    expect(tabs.tabs.map((t) => t.path)).toEqual(["b.md", "c.md"]);
    await tabs.open("c.md");
    expect(tabs.active?.preview).toBe(false);
  });

  it("后退 / 前进，关闭的笔记会重新打开", async () => {
    files.set("a.md", "a\n");
    files.set("b.md", "b\n");
    const tabs = useTabsStore();
    await tabs.open("a.md");
    await tabs.open("b.md");
    expect(tabs.canBack).toBe(true);
    await tabs.back();
    expect(tabs.activePath).toBe("a.md");
    expect(tabs.canForward).toBe(true);
    await tabs.close("b.md");
    await tabs.forward();
    expect(tabs.activePath).toBe("b.md");
    expect(tabs.tabs.map((t) => t.path)).toEqual(["a.md", "b.md"]);
  });

  it("改名后重映射路径，待保存的修改写到新路径", async () => {
    files.set("d/a.md", "a\n");
    const tabs = useTabsStore();
    await tabs.open("d/a.md");
    tabs.update("d/a.md", "改\n");
    tabs.remap("d", "e");
    expect(tabs.activePath).toBe("e/a.md");
    expect(tabs.active?.name).toBe("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writeNote).toHaveBeenCalledWith("C:/vault", "e/a.md", "改\n");
  });

  it("删除后关闭其下的标签页且不再保存", async () => {
    files.set("d/a.md", "a\n");
    files.set("x.md", "x\n");
    const tabs = useTabsStore();
    await tabs.open("x.md");
    await tabs.open("d/a.md");
    tabs.update("d/a.md", "改\n");
    tabs.dropUnder("d");
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeNote).not.toHaveBeenCalled();
    expect(tabs.tabs.map((t) => t.path)).toEqual(["x.md"]);
    expect(tabs.activePath).toBe("x.md");
    expect(tabs.canForward).toBe(false);
  });

  it("外部修改：自己保存的忽略，未编辑的重新载入，有修改时询问", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(ask).mockClear();
    files.set("a.md", "a\n");
    files.set("b.md", "b\n");
    const tabs = useTabsStore();
    await tabs.open("a.md");
    await tabs.open("b.md");
    tabs.update("a.md", "我的修改\n");
    await tabs.save("a.md");
    await tabs.onExternalChange(["a.md"]);
    expect(ask).not.toHaveBeenCalled();

    files.set("b.md", "外部改了\n");
    await tabs.onExternalChange(["b.md"]);
    expect(tabs.tabs.find((t) => t.path === "b.md")?.body).toBe("外部改了\n");

    tabs.update("a.md", "未保存\n");
    files.set("a.md", "外部又改了\n");
    await tabs.onExternalChange(["a.md"]);
    expect(ask).toHaveBeenCalledTimes(1);
    // 模拟为“保留这里的内容”
    expect(tabs.tabs.find((t) => t.path === "a.md")?.body).toBe("未保存\n");
  });

  it("外部修改：编辑器里还没同步进来的输入不会被重载掉", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(ask).mockClear();
    files.set("a.md", "a\n");
    const tabs = useTabsStore();
    await tabs.open("a.md");
    const pull = vi.fn(() => tabs.update("a.md", "刚输入\n"));
    useEditorStore().attach({} as Editor, "a.md", pull);
    expect(tabs.active?.status).toBe("saved");

    files.set("a.md", "外部改了\n");
    await tabs.onExternalChange(["a.md"]);
    expect(pull).toHaveBeenCalled();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(tabs.active?.body).toBe("刚输入\n");
  });

  it("同时两次打开同一篇笔记只产生一个标签页", async () => {
    files.set("a.md", "a\n");
    const tabs = useTabsStore();
    const results = await Promise.all([tabs.open("a.md"), tabs.open("a.md", { preview: true })]);
    expect(results).toEqual([true, true]);
    expect(tabs.tabs.map((t) => t.path)).toEqual(["a.md"]);
    expect(tabs.active?.preview).toBe(false);
  });

  it("未改动时关闭不写盘", async () => {
    files.set("n.md", "a\n");
    const tabs = useTabsStore();
    await tabs.open("n.md");
    expect(await tabs.close("n.md")).toBe(true);
    expect(writeNote).not.toHaveBeenCalled();
    expect(tabs.activePath).toBeNull();
  });
});
