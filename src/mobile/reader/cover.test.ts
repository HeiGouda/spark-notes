import { describe, expect, it } from "vitest";
import { coverColor, hasEmbeddedCover } from "./cover";

describe("书架封面", () => {
  it("同一个书名总是同一种颜色，不同书名大多不同", () => {
    expect(coverColor("三体")).toEqual(coverColor("三体"));
    const colors = new Set(["三体", "人类简史", "平凡的世界", "原则", "斗破苍穹", "社会性动物"].map((n) => coverColor(n).bg));
    expect(colors.size).toBeGreaterThan(2);
  });

  it("TXT 没有封面，其余格式去书里找", () => {
    expect(["a.epub", "b.MOBI", "c.azw3", "d.pdf", "e.txt"].map(hasEmbeddedCover)).toEqual([true, true, true, true, false]);
  });
});
