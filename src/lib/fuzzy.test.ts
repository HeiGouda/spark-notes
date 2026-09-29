import { describe, expect, it } from "vitest";
import { fuzzyMatch, highlightSegments } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("连续命中优先于分散命中", () => {
    const a = fuzzyMatch("同步", "WebDAV 同步设计")!;
    const b = fuzzyMatch("同步", "同意步骤")!;
    expect(a.indices).toEqual([7, 8]);
    expect(a.score).toBeGreaterThan(b.score);
  });
  it("按顺序出现即命中，否则不命中", () => {
    expect(fuzzyMatch("xjbj", "新建笔记")).toBeNull();
    expect(fuzzyMatch("新笔", "新建笔记")?.indices).toEqual([0, 2]);
    expect(fuzzyMatch("笔新", "新建笔记")).toBeNull();
  });
  it("空查询全部命中", () => {
    expect(fuzzyMatch("", "任意")).toEqual({ score: 0, indices: [] });
  });
  it("highlightSegments", () => {
    expect(highlightSegments("新建笔记", [0, 2])).toEqual([
      { text: "新", hit: true },
      { text: "建", hit: false },
      { text: "笔", hit: true },
      { text: "记", hit: false },
    ]);
  });
});
