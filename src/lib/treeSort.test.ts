import { describe, expect, it } from "vitest";
import type { TreeNode } from "./api";
import { sortTree } from "./treeSort";

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
