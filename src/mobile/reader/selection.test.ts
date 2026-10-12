import { describe, expect, it } from "vitest";
import { selectionFits, type SelBox, type SelRect } from "./selection";

const page: SelBox = { left: 0, right: 400, top: 0, bottom: 700 };

function rect(top: number, bottom: number, left = 20, right = 380): SelRect {
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

describe("选区是否还在当前页", () => {
  it("这一页里的字算在页内", () => {
    expect(selectionFits([rect(40, 80), rect(100, 140)], page)).toBe(true);
  });

  it("贴着页底、还露在这一页上的一行算在页内", () => {
    expect(selectionFits([rect(680, 720)], page)).toBe(true);
  });

  it("整行落到页底下面，就是下一页", () => {
    expect(selectionFits([rect(40, 80), rect(720, 760)], page)).toBe(false);
  });

  it("整行落到页顶上面，就是上一页", () => {
    expect(selectionFits([rect(-40, -4)], page)).toBe(false);
  });

  it("整块落到右边，是左右翻页的下一页", () => {
    expect(selectionFits([rect(40, 80, 420, 780)], page)).toBe(false);
  });

  it("下一页只从页缝探进来一点，整行仍算下一页", () => {
    expect(selectionFits([rect(40, 80, 392, 760)], page)).toBe(false);
  });

  it("这一页的行只稍微探出页边，仍算这一页", () => {
    expect(selectionFits([rect(40, 80, 20, 408)], page)).toBe(true);
  });

  it("量不到矩形时不当成越界", () => {
    expect(selectionFits([], page)).toBe(true);
    expect(selectionFits([rect(0, 0)], page)).toBe(true);
  });
});
