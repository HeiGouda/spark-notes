import { describe, expect, it } from "vitest";
import type { TreeNode } from "../lib/api";
import { favoriteNotes, folderItems, recentNotes } from "./browse";

function note(path: string, modifiedMs = 0): TreeNode {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return { name: file.replace(/\.md$/, ""), path, isDir: false, children: [], modifiedMs, createdMs: null };
}

function folder(path: string, children: TreeNode[]): TreeNode {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, isDir: true, children, modifiedMs: null, createdMs: null };
}

const tree: TreeNode[] = [
  folder("工作", [note("工作/周报.md", 30), note("工作/会议记录.md", 50), folder("工作/设计", [note("工作/设计/同步设计.md", 40)])]),
  folder("读书", [note("读书/原子习惯.md", 10)]),
  note("随手记.md", 20),
  note("产品规划.md", 60),
];

const names = (nodes: TreeNode[]) => nodes.map((n) => n.name);

describe("folderItems", () => {
  it("文件夹在前，按 order.json 的顺序排，没列出的按名称排在后面", () => {
    const order = { "": ["随手记.md", "读书", "产品规划.md"], 工作: ["会议记录.md"] };
    expect(names(folderItems(tree, "", order))).toEqual(["读书", "工作", "随手记", "产品规划"]);
    expect(names(folderItems(tree, "工作", order))).toEqual(["设计", "会议记录", "周报"]);
    expect(names(folderItems(tree, "工作/设计", order))).toEqual(["同步设计"]);
  });

  it("文件夹不存在时返回空列表", () => {
    expect(folderItems(tree, "不存在", {})).toEqual([]);
  });
});

describe("favoriteNotes", () => {
  it("按收藏顺序列出，已经不存在的收藏不显示", () => {
    const favs = ["产品规划.md", "已删除.md", "工作/设计/同步设计.md"];
    expect(favoriteNotes(tree, favs).map((n) => n.path)).toEqual(["产品规划.md", "工作/设计/同步设计.md"]);
  });
});

describe("recentNotes", () => {
  it("所有笔记按修改时间倒序，不含文件夹", () => {
    expect(names(recentNotes(tree))).toEqual(["产品规划", "会议记录", "同步设计", "周报", "随手记", "原子习惯"]);
  });
});
