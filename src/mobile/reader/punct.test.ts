import { describe, expect, it } from "vitest";
import { horizontalPunct } from "./punct";

describe("竖排标点横着显示", () => {
  it("换成对应的横排标点，长度不变", () => {
    const raw = "︿前言﹀︽为什么︾﹁意志力﹂︱基本原理︱";
    const shown = horizontalPunct(raw);
    expect(shown).toBe("〈前言〉《为什么》「意志力」—基本原理—");
    expect(shown.length).toBe(raw.length);
  });

  it("普通文字不动", () => {
    expect(horizontalPunct("第一章 归来，“你好”。")).toBe("第一章 归来，“你好”。");
  });
});
