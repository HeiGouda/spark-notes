import { describe, expect, it, vi } from "vitest";
import { parseKeymap, serializeKeymap } from "./keymapFile";

vi.mock("./platform", () => ({ isMac: false }));

const ids = new Set(["a", "b", "c"]);

describe("keymap 导入导出", () => {
  it("往返", () => {
    const text = serializeKeymap({ a: "Ctrl+Alt+N", b: null });
    expect(parseKeymap(text, ids)).toEqual({ keybindings: { a: "Ctrl+Alt+N", b: null }, skipped: [] });
  });

  it("跳过未知命令和无效快捷键，并统一写法", () => {
    const text = JSON.stringify({ keybindings: { a: "shift+ctrl+x", x: "Ctrl+Q", b: "Ctrl+C", c: "Q" } });
    const r = parseKeymap(text, ids);
    expect(r.keybindings).toEqual({ a: "Ctrl+Shift+X" });
    expect(r.skipped).toHaveLength(3);
  });

  it("文件内部冲突时拒绝导入", () => {
    const text = JSON.stringify({ keybindings: { a: "Ctrl+Alt+K", b: "Alt+Ctrl+K" } });
    expect(() => parseKeymap(text, ids)).toThrow(/同时分配/);
  });

  it("编辑器和图的快捷键可以相同，图里允许单个按键", () => {
    const scopeOf = (id: string) => (id === "a" ? "editor" : id === "b" ? "diagram" : "global") as "editor" | "diagram" | "global";
    const same = JSON.stringify({ keybindings: { a: "Ctrl+Alt+K", b: "Ctrl+Alt+K" } });
    expect(parseKeymap(same, ids, scopeOf).keybindings).toEqual({ a: "Ctrl+Alt+K", b: "Ctrl+Alt+K" });
    const withGlobal = JSON.stringify({ keybindings: { b: "Ctrl+Alt+K", c: "Ctrl+Alt+K" } });
    expect(() => parseKeymap(withGlobal, ids, scopeOf)).toThrow(/同时分配/);
    expect(parseKeymap(JSON.stringify({ keybindings: { b: "Enter" } }), ids, scopeOf).keybindings).toEqual({ b: "Enter" });
  });

  it("格式错误", () => {
    expect(() => parseKeymap("不是 json", ids)).toThrow();
    expect(() => parseKeymap("{}", ids)).toThrow(/keybindings/);
  });
});
