import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchShortcut, findConflict, isCustomized, registerCommands, shortcutOf, shortcutOverrides } from "./commands";

vi.mock("./platform", () => ({ isMac: false }));

function key(init: Partial<KeyboardEvent> & { code: string; key: string }): KeyboardEvent {
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init } as KeyboardEvent;
}

registerCommands([
  { id: "t.bold", title: "加粗", category: "格式", scope: "editor", defaultShortcut: "Ctrl+B", run: () => {} },
  { id: "t.sidebar", title: "侧栏", category: "视图", defaultShortcut: "Ctrl+Shift+B", run: () => {} },
  { id: "t.night", title: "夜读", category: "视图", defaultShortcut: null, run: () => {} },
]);

describe("命令快捷键", () => {
  beforeEach(() => {
    shortcutOverrides.value = {};
  });

  it("按作用范围分发", () => {
    const ctrlB = key({ code: "KeyB", key: "b", ctrlKey: true });
    expect(dispatchShortcut(ctrlB, "global")?.id).not.toBe("t.bold");
    expect(dispatchShortcut(ctrlB, "editor")?.id).toBe("t.bold");
  });

  it("自定义优先于默认；设为无后不再触发", () => {
    shortcutOverrides.value = { "t.night": "Ctrl+Alt+N", "t.bold": null };
    expect(shortcutOf("t.night")).toBe("Ctrl+Alt+N");
    expect(isCustomized("t.night")).toBe(true);
    expect(dispatchShortcut(key({ code: "KeyN", key: "n", ctrlKey: true, altKey: true }))?.id).toBe("t.night");
    expect(dispatchShortcut(key({ code: "KeyB", key: "b", ctrlKey: true }), "editor")).toBeNull();
  });

  it("冲突检测忽略写法差异和自身", () => {
    expect(findConflict("shift+ctrl+b")?.id).toBe("t.sidebar");
    expect(findConflict("Ctrl+Shift+B", "t.sidebar")).toBeNull();
    expect(findConflict("Ctrl+Alt+Q")).toBeNull();
  });

  it("自定义值等于默认值时不算已自定义", () => {
    shortcutOverrides.value = { "t.bold": "ctrl+b" };
    expect(isCustomized("t.bold")).toBe(false);
  });
});
