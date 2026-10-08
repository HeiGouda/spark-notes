import { describe, expect, it } from "vitest";
import { bookName, bookOf, bookStem, isBookName, isBookPath, outsideBook, sheetLabel, sheetNameProblem } from "./book";

describe("表格簿路径（与 Rust 端 book.rs 用例相同）", () => {
  it("认出以 .book 结尾的文件夹，不区分大小写，.book 本身不算", () => {
    expect(isBookName("周报.book")).toBe(true);
    expect(isBookName("周报.BOOK")).toBe(true);
    expect(isBookName(".book")).toBe(false);
    expect(isBookName("周报.books")).toBe(false);
    expect(isBookPath("工作/周报.book")).toBe(true);
    expect(isBookPath("工作/周报.book/")).toBe(true);
    expect(isBookPath("工作/周报.md")).toBe(false);
    expect(bookStem("周报.book")).toBe("周报");
    expect(bookName("工作/周报.book")).toBe("周报");
  });

  it("表所在的表格簿只看直接上一级", () => {
    expect(bookOf("工作/周报.book/本周.md")).toBe("工作/周报.book");
    expect(bookOf("周报.book/路线.mind.mmd")).toBe("周报.book");
    expect(bookOf("工作/本周.md")).toBeNull();
    expect(bookOf("周报.book")).toBeNull();
    expect(bookOf("周报.book/子夹/x.md")).toBeNull();
  });

  it("新建位置不能落在表格簿里面", () => {
    expect(outsideBook("工作/周报.book")).toBe("工作");
    expect(outsideBook("周报.book")).toBe("");
    expect(outsideBook("工作/周报.book/子夹")).toBe("工作");
    expect(outsideBook("工作")).toBe("工作");
    expect(outsideBook("")).toBe("");
  });

  it("列表里的名称：表显示成“簿名 › 表名”", () => {
    expect(sheetLabel("工作/周报.book/本周.md")).toBe("周报 › 本周");
    expect(sheetLabel("周报.book/路线.mind.mmd")).toBe("周报 › 路线");
    expect(sheetLabel("工作/周报.book")).toBe("周报");
    expect(sheetLabel("工作/读书.md")).toBe("读书");
  });
});

describe("sheetNameProblem", () => {
  const names = ["本周", "目标拆解", "上周"];

  it("空名称、非法字符、首尾的点", () => {
    expect(sheetNameProblem("  ", names, "本周")).toBe("名称不能为空");
    expect(sheetNameProblem("a/b", names, "本周")).toContain("不能包含字符");
    expect(sheetNameProblem(".隐藏", names, "本周")).toContain("不能以 . 开头");
    expect(sheetNameProblem("末尾.", names, "本周")).toContain("不能以 . 结尾");
  });

  it("簿内重名（不分大小写、不分类型）不行，自己的名字和只改大小写可以", () => {
    expect(sheetNameProblem("上周", names, "目标拆解")).toContain("已经有名为“上周”的表");
    expect(sheetNameProblem("ABC", ["abc", "x"], "x")).toContain("已经有名为");
    expect(sheetNameProblem("本周", names, "本周")).toBeNull();
    expect(sheetNameProblem("ABC", ["abc"], "abc")).toBeNull();
    expect(sheetNameProblem("新名字", names, "本周")).toBeNull();
  });
});
