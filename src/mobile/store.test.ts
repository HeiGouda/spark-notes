// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { TreeNode } from "../lib/api";
import type { SyncOutcome, VaultConfig } from "./api";
import type { MobilePrefs } from "./prefs";

const m = vi.hoisted(() => ({
  vaults: [] as VaultConfig[],
  prefs: { current: null, meta: {} } as MobilePrefs,
  saved: [] as MobilePrefs[],
  tree: [] as TreeNode[],
  sync: vi.fn(),
  remove: vi.fn(async () => {}),
}));

vi.mock("./api", () => ({
  mobileApi: {
    listVaults: async () => m.vaults,
    vaultRoot: async (id: string) => `/data/${id}`,
    sync: m.sync,
    removeVault: m.remove,
  },
}));
vi.mock("../lib/api", () => ({
  api: { scanVault: async () => ({ nodes: m.tree, warning: null }), readConfig: async () => null, allowAssets: async () => {} },
}));
vi.mock("./prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prefs")>()),
  loadPrefs: async () => structuredClone(m.prefs),
  savePrefs: async (p: MobilePrefs) => void m.saved.push(JSON.parse(JSON.stringify(p))),
}));

import { useMobile } from "./store";

const vault = (id: string): VaultConfig => ({ id, name: id, url: "https://dav.example.com", remoteDir: "/", username: "me" });
const note = (path: string): TreeNode => ({ name: path, path, isDir: false, children: [], modifiedMs: 1, createdMs: null });
const lastSaved = () => m.saved[m.saved.length - 1];
const done: SyncOutcome = { kind: "done", report: { downloaded: 1, localTrashed: 0, skipped: 0, errors: [] } };

beforeEach(() => {
  setActivePinia(createPinia());
  m.vaults = [vault("a"), vault("b")];
  m.prefs = { current: "a", meta: { a: { lastSyncMs: 1, files: 1 }, b: { lastSyncMs: 1, files: 1 } }, reader: { theme: "light", size: "medium" }, recent: {} };
  document.documentElement.className = "";
  m.saved = [];
  m.tree = [note("周报.md"), note("日记.md")];
  m.sync.mockReset();
  m.sync.mockResolvedValue(done);
  m.remove.mockClear();
});

describe("同步状态", () => {
  it("成功后是 ok，记下时间和文件数", async () => {
    const s = useMobile();
    await s.init();
    await s.runSync();
    expect(s.sync.state).toBe("ok");
    expect(s.meta.a.lastSyncMs).toBeGreaterThan(1);
    expect(s.meta.a.files).toBe(2);
    expect(lastSaved()?.meta.a.lastSyncMs).toBe(s.meta.a.lastSyncMs);
  });

  it("有文件没下完时是 fail，并列出文件名，同时记下已同步时间", async () => {
    m.sync.mockResolvedValue({
      kind: "done",
      report: { downloaded: 1, localTrashed: 0, skipped: 0, errors: ["图片.png：连接中断"] },
    } satisfies SyncOutcome);
    const s = useMobile();
    await s.init();
    await s.runSync();
    expect(s.sync.state).toBe("fail");
    expect(s.sync.message).toContain("图片.png");
    expect(s.meta.a.lastSyncMs).toBeGreaterThan(1);
  });

  it("失败后是 fail，并带上原因", async () => {
    m.sync.mockRejectedValue("读取远端目录失败：账号或密码不正确（HTTP 401）");
    const s = useMobile();
    await s.init();
    await s.runSync();
    expect(s.sync.state).toBe("fail");
    expect(s.sync.message).toContain("HTTP 401");
  });

  it("删除要确认时是 held；确认后带上文件列表再同步，变成 ok", async () => {
    const removals = Array.from({ length: 21 }, (_, i) => `旧${i}.md`);
    m.sync.mockResolvedValueOnce({
      kind: "needsConfirm",
      check: { firstSync: false, downloads: 0, downloadBytes: 0, missingSizes: 0, removals, guard: null, needsConfirm: true },
      report: { downloaded: 0, localTrashed: 0, skipped: 21, errors: [] },
    } satisfies SyncOutcome);
    const s = useMobile();
    await s.init();
    await s.runSync();
    expect(s.sync.state).toBe("held");
    expect(s.sync.removals).toEqual(removals);

    await s.confirmHeld();
    expect(m.sync).toHaveBeenLastCalledWith("a", removals, expect.any(Function));
    expect(s.sync.state).toBe("ok");
  });

  it("没同步过的笔记库是 never，打开时不自动同步", async () => {
    m.prefs.meta = {};
    const s = useMobile();
    await s.init();
    expect(s.sync.state).toBe("never");
    expect(m.sync).not.toHaveBeenCalled();
  });
});

describe("切换笔记库", () => {
  it("记住当前库，并自动同步一次", async () => {
    const s = useMobile();
    await s.init();
    m.sync.mockClear();
    await s.selectVault("b");
    expect(s.current?.id).toBe("b");
    expect(s.root).toBe("/data/b");
    expect(lastSaved()?.current).toBe("b");
    expect(m.sync).toHaveBeenCalledWith("b", [], expect.any(Function));
  });
});

describe("阅读设置", () => {
  it("打开时套用上次的主题和字号", async () => {
    m.prefs.reader = { theme: "paper", size: "large" };
    const s = useMobile();
    await s.init();
    expect(document.documentElement.classList.contains("paper")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--read-size")).toBe("18px");
    expect(s.reader).toEqual({ theme: "paper", size: "large" });
  });

  it("换主题时去掉旧主题，浅色不加类名，并记住选择", async () => {
    const s = useMobile();
    await s.init();
    await s.setReader({ theme: "night" });
    expect(document.documentElement.classList.contains("night")).toBe(true);
    await s.setReader({ theme: "light", size: "xlarge" });
    expect([...document.documentElement.classList].filter((c) => ["paper", "green", "night", "black"].includes(c))).toEqual([]);
    expect(document.documentElement.style.getPropertyValue("--read-size")).toBe("20px");
    expect(lastSaved()?.reader).toEqual({ theme: "light", size: "xlarge" });
  });
});

describe("最近打开", () => {
  it("记在当前笔记库最前面，再次打开排到最前，别的库不受影响", async () => {
    const s = useMobile();
    await s.init();
    await s.rememberOpen("工作/周报.md");
    await s.rememberOpen("日记.md");
    await s.rememberOpen("工作/周报.md");
    expect(s.recent.a.map((e) => e.path)).toEqual(["工作/周报.md", "日记.md"]);
    await s.selectVault("b");
    await s.rememberOpen("读书.md");
    expect(s.recent.b.map((e) => e.path)).toEqual(["读书.md"]);
    expect(s.recent.a.map((e) => e.path)).toEqual(["工作/周报.md", "日记.md"]);
    expect(lastSaved()?.recent.a.map((e) => e.path)).toEqual(["工作/周报.md", "日记.md"]);
  });
});

describe("欢迎页", () => {
  it("没有笔记库时首页是欢迎页", async () => {
    m.vaults = [];
    const s = useMobile();
    await s.init();
    expect(s.homePage).toBe("welcome");
  });

  it("删除最后一个笔记库后回到欢迎页", async () => {
    m.vaults = [vault("a")];
    const s = useMobile();
    await s.init();
    expect(s.homePage).toBe("files");
    await s.removeVault("a");
    expect(m.remove).toHaveBeenCalledWith("a");
    expect(s.current).toBeNull();
    expect(s.homePage).toBe("welcome");
  });
});
