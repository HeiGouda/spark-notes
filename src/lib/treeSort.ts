import type { TreeNode } from "./api";
import type { SortKey } from "../stores/settings";

/** 文件夹相对路径（根目录为空字符串）→ 子项名称（含 .md 扩展名）的顺序 */
export type CustomOrder = Record<string, string[]>;

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

const HAN_START = /^\p{Script=Han}/u;

/** 与资源管理器一致：数字、字母开头的排在汉字开头的前面；汉字之间按拼音 */
function compareNames(a: string, b: string): number {
  return Number(HAN_START.test(a)) - Number(HAN_START.test(b)) || collator.compare(a, b);
}

function childName(n: TreeNode): string {
  return n.path.slice(n.path.lastIndexOf("/") + 1);
}

/**
 * 文件夹始终排在笔记前面。自定义排序时，列表中没有的新项排在列表项之后并按名称排序；
 * 自定义排序不受升降序影响。
 */
export function sortTree(
  nodes: TreeNode[],
  key: SortKey,
  desc: boolean,
  order: CustomOrder,
  dir = "",
  recursive = true,
): TreeNode[] {
  const byName = (a: TreeNode, b: TreeNode) => compareNames(a.name, b.name);
  let cmp: (a: TreeNode, b: TreeNode) => number;
  if (key === "custom") {
    const list = order[dir] ?? [];
    const rank = (n: TreeNode) => {
      const i = list.indexOf(childName(n));
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    cmp = (a, b) => rank(a) - rank(b) || byName(a, b);
  } else {
    const field = key === "modified" ? "modifiedMs" : key === "created" ? "createdMs" : null;
    const sign = desc ? -1 : 1;
    // 时间相同时按名称升序，保证顺序稳定
    cmp = field
      ? (a, b) => sign * ((a[field] ?? 0) - (b[field] ?? 0)) || byName(a, b)
      : (a, b) => sign * byName(a, b);
  }
  return [...nodes]
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || cmp(a, b))
    .map((n) =>
      n.isDir && recursive ? { ...n, children: sortTree(n.children, key, desc, order, n.path, true) } : n,
    );
}
