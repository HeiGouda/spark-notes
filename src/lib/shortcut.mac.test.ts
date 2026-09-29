import { describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ isMac: true, fileManagerName: "访达", credentialStoreName: "钥匙串" }));

const { displayShortcut, eventToShortcut, MAC_DEFAULT_SHORTCUTS, matchShortcut, shortcutProblem } = await import("./shortcut");
const { registerCommands, shortcutOf } = await import("./commands");

function key(init: Partial<KeyboardEvent> & { code: string; key: string }): KeyboardEvent {
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init } as KeyboardEvent;
}

describe("macOS 快捷键", () => {
  it("Ctrl 对应 Cmd 键，显示为 Cmd / Option", () => {
    expect(matchShortcut(key({ code: "KeyB", key: "b", metaKey: true }), "Ctrl+B")).toBe(true);
    expect(matchShortcut(key({ code: "KeyB", key: "b", ctrlKey: true }), "Ctrl+B")).toBe(false);
    expect(eventToShortcut(key({ code: "KeyF", key: "ƒ", metaKey: true, altKey: true }))).toBe("Ctrl+Alt+F");
    expect(displayShortcut("Ctrl+Alt+F")).toBe("Cmd+Option+F");
  });

  it("系统占用的组合键不能设置", () => {
    for (const s of ["Ctrl+Q", "Ctrl+H", "Ctrl+M", "Ctrl+Tab"]) expect(shortcutProblem(s)).toMatch(/保留/);
    expect(shortcutProblem("Shift+A")).toMatch(/Cmd 或 Option/);
  });

  it("macOS 默认快捷键可用且互不重复", () => {
    const values = Object.values(MAC_DEFAULT_SHORTCUTS);
    for (const s of values) expect(shortcutProblem(s)).toBeNull();
    expect(new Set(values).size).toBe(values.length);
  });

  it("注册命令时换成 macOS 默认值", () => {
    registerCommands([
      { id: "edit.replace", title: "替换", category: "编辑", defaultShortcut: "Ctrl+H", run: () => {} },
      { id: "edit.find", title: "查找", category: "编辑", defaultShortcut: "Ctrl+F", run: () => {} },
    ]);
    expect(shortcutOf("edit.replace")).toBe("Ctrl+Alt+F");
    expect(shortcutOf("edit.find")).toBe("Ctrl+F");
  });
});
