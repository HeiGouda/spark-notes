// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeTab, addBackInterceptor, back, exitBump, go, handleSystemBack, open, page, reset, tab } from "./nav";

beforeEach(() => reset({ p: "files", path: "" }));

describe("tab", () => {
  it("底部标签是文件、书架、助手和我的", () => {
    tab("shelf");
    expect(page.value).toEqual({ p: "shelf" });
    expect(activeTab.value).toBe("shelf");
    tab("assistant");
    expect(activeTab.value).toBe("assistant");
    tab("me");
    expect(activeTab.value).toBe("me");
    tab("files");
    expect(page.value).toEqual({ p: "files", path: "" });
  });

  it("搜索时底部标签栏还在，停在文件", () => {
    go({ p: "search" });
    expect(activeTab.value).toBe("files");
  });

  it("在子文件夹里点文件标签回到根目录", () => {
    go({ p: "files", path: "工作" });
    tab("files");
    expect(page.value).toEqual({ p: "files", path: "" });
  });
});

describe("back", () => {
  it("从最近打开、搜索和二级设置页返回文件页或我的", () => {
    go({ p: "recent" });
    expect(back()).toBe(true);
    expect(page.value).toEqual({ p: "files", path: "" });

    go({ p: "search" });
    back();
    go({ p: "shelf-settings" });
    expect(back()).toBe(true);
    expect(page.value).toEqual({ p: "files", path: "" });
  });

  it("有浮层时先关掉浮层", () => {
    open({ t: "outline" });
    expect(back()).toBe(true);
    expect(page.value).toEqual({ p: "files", path: "" });
  });

  it("已经在文件页根目录时退无可退", () => {
    expect(back()).toBe(false);
  });
});

describe("handleSystemBack", () => {
  it("还有上一层时只返回，不震动", () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    const before = exitBump.value;
    go({ p: "recent" });
    expect(handleSystemBack(1_000)).toBe("handled");
    expect(page.value).toEqual({ p: "files", path: "" });
    expect(vibrate).not.toHaveBeenCalled();
    expect(exitBump.value).toBe(before);
  });

  it("一级一级退回首页：二级页面先回上一层，标签页回文件页", () => {
    tab("shelf");
    go({ p: "cloud" });
    expect(handleSystemBack(1_000)).toBe("handled");
    expect(page.value).toEqual({ p: "shelf" });
    expect(handleSystemBack(1_100)).toBe("handled");
    expect(page.value).toEqual({ p: "files", path: "" });
  });

  it("在首页先震一下，2 秒内再返回才回桌面", () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    const before = exitBump.value;
    expect(handleSystemBack(10_000)).toBe("hint");
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(exitBump.value).toBe(before + 1);
    expect(page.value).toEqual({ p: "files", path: "" });
    expect(handleSystemBack(11_000)).toBe("exit");
  });

  it("隔了 2 秒以上再返回，重新震一下而不是退出", () => {
    expect(handleSystemBack(20_000)).toBe("hint");
    expect(handleSystemBack(23_000)).toBe("hint");
  });

  it("页面自己的浮层先接返回键", () => {
    let open = true;
    const remove = addBackInterceptor(() => {
      if (!open) return false;
      open = false;
      return true;
    });
    go({ p: "recent" });
    expect(handleSystemBack(30_000)).toBe("handled");
    expect(page.value).toEqual({ p: "recent" });
    expect(handleSystemBack(30_100)).toBe("handled");
    expect(page.value).toEqual({ p: "files", path: "" });
    remove();
  });

  it("设备不支持震动时也不报错", () => {
    Object.defineProperty(navigator, "vibrate", { value: undefined, configurable: true });
    expect(() => handleSystemBack(40_000)).not.toThrow();
  });
});