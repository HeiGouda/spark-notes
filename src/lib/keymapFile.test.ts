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

  it("格式错误", () => {
    expect(() => parseKeymap("不是 json", ids)).toThrow();
    expect(() => parseKeymap("{}", ids)).toThrow(/keybindings/);
  });
});
