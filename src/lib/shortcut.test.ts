import { describe, expect, it, vi } from "vitest";
import { eventToShortcut, matchShortcut, normalizeShortcut, shortcutProblem } from "./shortcut";

vi.mock("./platform", () => ({ isMac: false }));

function key(init: Partial<KeyboardEvent> & { code: string; key: string }): KeyboardEvent {
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init } as KeyboardEvent;
}

describe("normalizeShortcut", () => {
  it.each([
    ["shift+ctrl+x", "Ctrl+Shift+X"],
    ["Alt+Ctrl+n", "Ctrl+Alt+N"],
    ["Ctrl+\\", "Ctrl+\\"],
    ["Alt+←", "Alt+←"],
  ])("%s → %s", (a, b) => expect(normalizeShortcut(a)).toBe(b));
});

describe("matchShortcut", () => {
  it("按物理键匹配带 Shift 的数字键和符号键", () => {
    expect(matchShortcut(key({ code: "Digit8", key: "*", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+8")).toBe(true);
    expect(matchShortcut(key({ code: "Comma", key: "<", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+,")).toBe(true);
  });
  it("修饰键必须完全一致", () => {
    expect(matchShortcut(key({ code: "KeyB", key: "B", ctrlKey: true, shiftKey: true }), "Ctrl+B")).toBe(false);
    expect(matchShortcut(key({ code: "KeyB", key: "B", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+B")).toBe(true);
  });
  it("方向键与 Tab", () => {
    expect(matchShortcut(key({ code: "ArrowLeft", key: "ArrowLeft", altKey: true }), "Alt+←")).toBe(true);
    expect(matchShortcut(key({ code: "Tab", key: "Tab", shiftKey: true }), "Shift+Tab")).toBe(true);
  });
});

describe("eventToShortcut", () => {
  it("生成统一写法；只按修饰键时为 null", () => {
    expect(eventToShortcut(key({ code: "KeyK", key: "k", ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+K");
    expect(eventToShortcut(key({ code: "Digit1", key: "!", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+1");
    expect(eventToShortcut(key({ code: "ShiftLeft", key: "Shift", shiftKey: true }))).toBeNull();
    expect(eventToShortcut(key({ code: "F5", key: "F5" }))).toBe("F5");
  });
});

describe("shortcutProblem", () => {
  it("保留组合键与缺少修饰键", () => {
    expect(shortcutProblem("Ctrl+C")).toMatch(/保留/);
    expect(shortcutProblem("Shift+A")).toMatch(/Ctrl 或 Alt/);
    expect(shortcutProblem("Q")).toMatch(/Ctrl 或 Alt/);
    expect(shortcutProblem("F2")).toBeNull();
    expect(shortcutProblem("Shift+Tab")).toBeNull();
    expect(shortcutProblem("Ctrl+Alt+N")).toBeNull();
  });
});
