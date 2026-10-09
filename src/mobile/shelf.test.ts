import { describe, expect, it } from "vitest";
import type { ShelfBook } from "./api";
import { bookStem, resolveShelfVault, sortBooks } from "./shelf";

const book = (name: string, addedMs: number): ShelfBook => ({ id: name, name, size: 1, addedMs, origin: "import" });

describe("书架排序", () => {
  const books = [book("三体.epub", 2), book("原则.mobi", 5), book("人类简史.epub", 1)];

  it("按导入时间，新的在前", () => {
    expect(sortBooks(books, "added").map((b) => b.name)).toEqual(["原则.mobi", "三体.epub", "人类简史.epub"]);
  });

  it("按书名排序，不改原来的数组", () => {
    const names = sortBooks(books, "name").map((b) => b.name);
    const expected = [...names].sort((a, b) => a.localeCompare(b, "zh"));
    expect(names).toEqual(expected);
    expect(books[0].name).toBe("三体.epub");
    expect(bookStem("三体.epub")).toBe("三体");
  });
});

describe("书架用哪个笔记库", () => {
  const ids = ["a", "b"];

  it("设置里选过的优先", () => {
    expect(resolveShelfVault("b", ids, "a")).toBe("b");
  });

  it("没选过就跟着当前笔记库，已经连上笔记库不用再去设置里选", () => {
    expect(resolveShelfVault(null, ids, "b")).toBe("b");
  });

  it("选过的库已经删掉时也跟着当前库", () => {
    expect(resolveShelfVault("gone", ids, "a")).toBe("a");
  });

  it("当前库不可用时用第一个，一个库都没有才是空", () => {
    expect(resolveShelfVault(null, ids, null)).toBe("a");
    expect(resolveShelfVault(null, [], null)).toBeNull();
  });
});
