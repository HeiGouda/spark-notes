import { describe, expect, it } from "vitest";
import { diffLines } from "./diff";

describe("按行对比", () => {
  it("标出新增和删除", () => {
    expect(diffLines("甲\n乙\n丙", "甲\n丁\n丙")).toEqual([
      { kind: "same", text: "甲" },
      { kind: "del", text: "乙" },
      { kind: "add", text: "丁" },
      { kind: "same", text: "丙" },
    ]);
  });

  it("忽略换行符差异", () => {
    expect(diffLines("甲\r\n乙", "甲\n乙").every((l) => l.kind === "same")).toBe(true);
  });
});
