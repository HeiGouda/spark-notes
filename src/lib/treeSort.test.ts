import { describe, expect, it } from "vitest";
import type { TreeNode } from "./api";
import { cnNumber, filterHidden, parseSortConfig, sortTree } from "./treeSort";

const f = (path: string, m: number, c = m): TreeNode => ({
  name: path.split("/").pop()!.replace(/\.md$/, ""),
  path,
  isDir: false,
  children: [],
  modifiedMs: m,
  createdMs: c,
});
const d = (path: string, children: TreeNode[] = []): TreeNode => ({
  name: path.split("/").pop()!,
  path,
  isDir: true,
  children,
  modifiedMs: 0,
  createdMs: 0,
});

const names = (nodes: TreeNode[]) => nodes.map((n) => n.name);

describe("sortTree", () => {
  const nodes = [f("笔记10.md", 3, 1), f("笔记2.md", 1, 3), d("b"), f("a.md", 2, 2), d("a", [f("a/z.md", 1), f("a/y.md", 2)])];

  it("按名称：文件夹在前，数字按大小", () => {
    expect(names(sortTree(nodes, "name", false, {}))).toEqual(["a", "b", "a", "笔记2", "笔记10"]);
  });

  it("按修改时间降序", () => {
    expect(names(sortTree(nodes, "modified", true, {}))).toEqual(["a", "b", "笔记10", "a", "笔记2"]);
  });

  it("按创建时间升序并递归子文件夹", () => {
    const out = sortTree(nodes, "created", false, {});
    expect(names(out)).toEqual(["a", "b", "笔记10", "a", "笔记2"]);
    expect(names(out[0].children)).toEqual(["z", "y"]);
  });

  it("自定义排序：列表外的项按名称排在后面，子文件夹用自己的列表", () => {
    const out = sortTree(nodes, "custom", true, { "": ["笔记2.md", "b"], a: ["z.md"] });
    expect(names(out)).toEqual(["b", "a", "笔记2", "a", "笔记10"]);
    expect(names(out[1].children)).toEqual(["z", "y"]);
  });
});

describe("表格簿", () => {
  const book = (path: string, sheets: TreeNode[]): TreeNode => ({ ...d(path, sheets), name: path.replace(/\.book$/, ""), book: { unsupported: [], warning: null } });
  const sheets = [f("周报.book/z.md", 1), f("周报.book/a.md", 2)];
  const nodes = [f("读书.md", 1), book("周报.book", sheets), d("文件夹", [f("文件夹/x.md", 1)]), f("a.md", 2)];

  it("和文件排在一起，文件夹仍在最前面", () => {
    expect(names(sortTree(nodes, "name", false, {}))).toEqual(["文件夹", "a", "读书", "周报"]);
  });

  it("里面的表保持簿内顺序，不跟着文件树排序", () => {
    const out = sortTree(nodes, "name", false, {});
    const b = out.find((n) => n.book)!;
    expect(names(b.children)).toEqual(["z", "a"]);
  });

  it("隐藏表格簿连同里面的表一起去掉，隐藏其他项时不展开表格簿", () => {
    expect(names(filterHidden(nodes, new Set(["周报.book"])))).toEqual(["读书", "文件夹", "a"]);
    const kept = filterHidden(nodes, new Set(["周报.book/z.md"])).find((n) => n.book)!;
    expect(kept.children).toHaveLength(2);
  });
});

describe("中文数字", () => {
  it("cnNumber 支持纯数字写法和带单位写法", () => {
    expect(cnNumber("十二")).toBe("12");
    expect(cnNumber("二十")).toBe("20");
    expect(cnNumber("一百零五")).toBe("105");
    expect(cnNumber("二〇二六")).toBe("2026");
    expect(cnNumber("两千")).toBe("2000");
    expect(cnNumber("一万二千")).toBe("12000");
    expect(cnNumber("十万")).toBe("100000");
  });

  it("“第几讲”按数值排序，而不是按拼音", () => {
    const lectures = ["第二讲：哲学基本问题", "第三讲：辩证法", "第四讲：认识论", "第五讲：历史观", "第一讲：马克思主义哲学", "第十讲", "第十一讲"]
      .map((n) => f(`${n}.md`, 0));
    expect(names(sortTree(lectures, "name", false, {}))).toEqual([
      "第一讲：马克思主义哲学", "第二讲：哲学基本问题", "第三讲：辩证法", "第四讲：认识论", "第五讲：历史观", "第十讲", "第十一讲",
    ]);
  });

  it("全角数字与阿拉伯数字一样按数值比较；汉字开头的里，中文数字开头的排在前面并按数值", () => {
    const nodes = [f("笔记１０.md", 0), f("笔记2.md", 0), f("十、结语.md", 0), f("二、分论.md", 0), f("b.md", 0)];
    expect(names(sortTree(nodes, "name", false, {}))).toEqual(["b", "二、分论", "十、结语", "笔记2", "笔记１０"]);
  });
});

describe("parseSortConfig", () => {
  it("解析合法内容，其余返回 null", () => {
    expect(parseSortConfig('{"key":"modified","desc":true}')).toEqual({ key: "modified", desc: true });
    expect(parseSortConfig('{"key":"custom"}')).toEqual({ key: "custom", desc: false });
    expect(parseSortConfig('{"key":"size"}')).toBeNull();
    expect(parseSortConfig("not json")).toBeNull();
    expect(parseSortConfig(null)).toBeNull();
  });
});

describe("filterHidden", () => {
  const nodes = [d("a", [f("a/z.md", 1), d("a/sub", [f("a/sub/y.md", 2)])]), d("b", [f("b/x.md", 1)]), f("c.md", 1)];

  it("隐藏文件夹时连同内容一起去掉，隐藏文件只去掉它自己", () => {
    const out = filterHidden(nodes, new Set(["b", "a/sub/y.md", "c.md"]));
    expect(names(out)).toEqual(["a"]);
    expect(names(out[0].children)).toEqual(["z", "sub"]);
    expect(out[0].children[1].children).toEqual([]);
  });

  it("没有隐藏项时原样返回", () => {
    expect(filterHidden(nodes, new Set())).toBe(nodes);
  });
});
