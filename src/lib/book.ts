import { baseName, dirOf } from "./api";
import { docName } from "./doctype";

/** 表格簿：以 `.book` 结尾的文件夹，规则与 Rust 侧 book.rs 一致 */
export const BOOK_EXT = ".book";
export const BOOK_ICON = "book";
/** 列表里“簿名 › 表名”的分隔 */
export const SHEET_SEP = " › ";

export function isBookName(name: string): boolean {
  return !name.startsWith(".") && name.length > BOOK_EXT.length && name.toLowerCase().endsWith(BOOK_EXT);
}

/** 路径的最后一段是否是表格簿 */
export function isBookPath(path: string): boolean {
  return isBookName(baseName(path.replace(/\/+$/, "")));
}

/** 去掉 `.book` 后缀的名称 */
export function bookStem(name: string): string {
  return isBookName(name) ? name.slice(0, -BOOK_EXT.length) : name;
}

/** 表格簿的显示名，如 `工作/周报.book` → `周报` */
export function bookName(bookPath: string): string {
  return bookStem(baseName(bookPath));
}

/** 表所在的表格簿路径；不是表格簿里的文件时返回 null */
export function bookOf(path: string): string | null {
  const dir = dirOf(path);
  return dir && isBookPath(dir) ? dir : null;
}

/** 新建位置不能落在表格簿里面：位于表格簿内时，改成表格簿所在的文件夹 */
export function outsideBook(dir: string): string {
  let cur = dir;
  while (cur) {
    if (isBookPath(cur)) return dirOf(cur);
    cur = dirOf(cur);
  }
  return dir;
}

const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * 表改名 / 新名称的校验，有问题时返回提示。和 Rust 端 validate_name 以及簿内重名（不分类型）的规则一致。
 * existing 是簿内所有表的名称（不含扩展名），current 是正在改名的这张表的名称。
 */
export function sheetNameProblem(name: string, existing: string[], current: string): string | null {
  const n = name.trim();
  if (!n) return "名称不能为空";
  const bad = BAD_NAME_CHARS.exec(n);
  if (bad) return `名称不能包含字符 ${bad[0]}`;
  if (n.startsWith(".")) return "名称不能以 . 开头";
  if (n.endsWith(".")) return "名称不能以 . 结尾";
  if (existing.some((e) => e !== current && e.toLowerCase() === n.toLowerCase())) return `这个表格簿里已经有名为“${n}”的表`;
  return null;
}

/** 列表里显示的名称：表显示成“簿名 › 表名”，其余照常 */
export function sheetLabel(path: string): string {
  const book = bookOf(path);
  if (book) return `${bookName(book)}${SHEET_SEP}${docName(path)}`;
  return isBookPath(path) ? bookName(path) : docName(path);
}
