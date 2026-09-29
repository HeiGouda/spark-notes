import { describe, expect, it } from "vitest";
import { findInItems, groupMatches, replaceMatches } from "./find";
import { buildPattern } from "../editor/find";

describe("图里的查找替换", () => {
  const items = [
    { id: "a", text: "借用与生命周期" },
    { id: "b", text: "生命周期标注，生命周期" },
    { id: "edge:e1", text: "无关" },
  ];

  it("逐处列出命中，按节点分组", () => {
    const p = buildPattern("生命周期", { caseSensitive: false, regex: false })!;
    const ms = findInItems(items, p);
    expect(ms.map((m) => [m.item, m.index])).toEqual([["a", 3], ["b", 0], ["b", 7]]);
    expect([...groupMatches(ms).keys()]).toEqual(["a", "b"]);
  });

  it("同一段文字替换多处；正则模式展开 $1", () => {
    const p = buildPattern("生命周期", { caseSensitive: false, regex: false })!;
    const ms = findInItems(items, p).filter((m) => m.item === "b");
    expect(replaceMatches(items[1].text, ms, p, "lifetime", false)).toBe("lifetime标注，lifetime");
    const r = buildPattern("(生命)周期", { caseSensitive: false, regex: true })!;
    const rs = findInItems([items[0]], r);
    expect(replaceMatches(items[0].text, rs, r, "[$1]", true)).toBe("借用与[生命]");
  });

  it("区分大小写", () => {
    const p = buildPattern("rust", { caseSensitive: true, regex: false })!;
    expect(findInItems([{ id: "x", text: "Rust rust" }], p).map((m) => m.index)).toEqual([5]);
  });
});
