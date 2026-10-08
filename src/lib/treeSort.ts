import type { TreeNode } from "./api";
import type { SortKey } from "../stores/settings";

/** 文件夹相对路径（根目录为空字符串）→ 子项名称（含 .md 扩展名）的顺序 */
export type CustomOrder = Record<string, string[]>;

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

const HAN_START = /^\p{Script=Han}/u;

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const CN_RUN = /[零〇一二两三四五六七八九十百千万]+/g;

/** 中文数字转成阿拉伯数字：十二 → 12、一百零五 → 105、二〇二六 → 2026 */
export function cnNumber(text: string): string {
  if (!/[十百千万]/.test(text)) return [...text].map((ch) => CN_DIGIT[ch]).join("");
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of text) {
    if (ch in CN_DIGIT) digit = CN_DIGIT[ch];
    else if (ch === "万") {
      total = (total + (section + digit || 1)) * 10000;
      section = 0;
      digit = 0;
    } else {
      section += (digit || 1) * CN_UNIT[ch];
      digit = 0;
    }
  }
  return String(total + section + digit);
}

/** 比较用的名称：中文数字和全角数字换成阿拉伯数字，交给 numeric 排序按数值比较 */
export function sortableName(name: string): string {
  return name.replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10)).replace(CN_RUN, cnNumber);
}

/** 与资源管理器一致：数字、字母开头的排在汉字开头的前面；汉字之间按拼音，名称里的数字（含中文数字）按数值 */
export function compareNames(a: string, b: string): number {
  return (
    Number(HAN_START.test(a)) - Number(HAN_START.test(b)) ||
    collator.compare(sortableName(a), sortableName(b)) ||
    collator.compare(a, b)
  );
}

/** 排序方式（`.ttnote/config/sort.json`，随笔记库同步，手机和笔记柜也按它排） */
export interface SortConfig {
  key: SortKey;
  desc: boolean;
}

const SORT_KEYS: readonly SortKey[] = ["name", "modified", "created", "custom"];

/** 解析 sort.json；内容不对时返回 null */
export function parseSortConfig(raw: string | null): SortConfig | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || !SORT_KEYS.includes(v.key)) return null;
    return { key: v.key, desc: v.desc === true };
  } catch {
    return null;
  }
}

function childName(n: TreeNode): string {
  return n.path.slice(n.path.lastIndexOf("/") + 1);
}

/** 去掉隐藏的项；隐藏的文件夹连同其中的内容一起去掉 */
export function filterHidden(nodes: TreeNode[], hidden: ReadonlySet<string>): TreeNode[] {
  if (!hidden.size) return nodes;
  return nodes
    .filter((n) => !hidden.has(n.path))
    .map((n) => (n.isDir && !n.book ? { ...n, children: filterHidden(n.children, hidden) } : n));
}

/** 文件夹始终排在前面；表格簿虽然在磁盘上是文件夹，但和文件排在一起 */
const isFolder = (n: TreeNode) => n.isDir && !n.book;

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
    .sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || cmp(a, b))
    // 表格簿里的表保持簿内的顺序（.book.json），不参与文件树的排序
    .map((n) =>
      isFolder(n) && recursive ? { ...n, children: sortTree(n.children, key, desc, order, n.path, true) } : n,
    );
}
