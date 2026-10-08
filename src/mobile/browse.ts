import type { TreeNode } from "../lib/api";
import { sortTree, type CustomOrder, type SortConfig } from "../lib/treeSort";
import type { RecentOpen } from "./prefs";

function findFolder(tree: TreeNode[], path: string): TreeNode[] | null {
  if (!path) return tree;
  let nodes = tree;
  let at = "";
  for (const seg of path.split("/")) {
    at = at ? `${at}/${seg}` : seg;
    const next = nodes.find((n) => n.isDir && n.path === at);
    if (!next) return null;
    nodes = next.children;
  }
  return nodes;
}

/** 某个文件夹（根目录为空字符串）的直接子项，按电脑上选的排序方式 */
export function folderItems(tree: TreeNode[], path: string, order: CustomOrder, sort: SortConfig): TreeNode[] {
  const nodes = findFolder(tree, path);
  return nodes ? sortTree(nodes, sort.key, sort.desc, order, path, false) : [];
}

/** 所有文件；表格簿算一个文件（它的各张表不单独列出） */
function allNotes(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    if (n.isDir && !n.book) allNotes(n.children, out);
    else out.push(n);
  }
  return out;
}

/** 路径对应的表格簿节点；不存在时返回 null */
export function findBook(tree: TreeNode[], bookPath: string): TreeNode | null {
  const parent = findFolder(tree, dirOfPath(bookPath));
  return parent?.find((n) => n.book && n.path === bookPath) ?? null;
}

function dirOfPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** 表格簿的第一张表；表格簿不存在或里面没有表时返回 null */
export function firstSheet(tree: TreeNode[], bookPath: string): TreeNode | null {
  return findBook(tree, bookPath)?.children[0] ?? null;
}

/** 收藏的笔记，保持收藏顺序；已不存在的跳过 */
export function favoriteNotes(tree: TreeNode[], favorites: string[]): TreeNode[] {
  const byPath = new Map(allNotes(tree).map((n) => [n.path, n]));
  return favorites.flatMap((p) => byPath.get(p) ?? []);
}

/** 按打开顺序（新的在前）列出还存在的文件，没打开过的不出现 */
export function recentOpened(tree: TreeNode[], opened: RecentOpen[]): { node: TreeNode; openedAt: number }[] {
  const byPath = new Map(allNotes(tree).map((n) => [n.path, n]));
  return opened.flatMap((e) => {
    const node = byPath.get(e.path);
    return node ? [{ node, openedAt: e.openedAt }] : [];
  });
}

export function countNotes(tree: TreeNode[]): number {
  return allNotes(tree).length;
}

/** 笔记所在文件夹，例如「工作 / 设计」；在根目录时为「根目录」 */
export function folderLabel(path: string): string {
  const parts = path.split("/").slice(0, -1);
  return parts.length ? parts.join(" / ") : "根目录";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 列表里显示的时间：刚刚、几分钟前、今天 15:20、昨天 21:15、9月25日、2025年9月25日 */
export function timeLabel(ms: number | null, now = Date.now()): string {
  if (!ms) return "";
  const diff = now - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(ms);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (ms >= startOfToday) return `今天 ${hm}`;
  if (ms >= startOfToday - 86_400_000) return `昨天 ${hm}`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
