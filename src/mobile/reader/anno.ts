/**
 * 读书笔记 md。划线写在注释上面，一行原文一行 `> `；只写想法、没有划线时不摘录。
 * 位置仍在不显示的注释里。旧文件没有 `> ` 时原文留空，打开时不改写。
 */

export interface Anno {
  id: string;
  /** 在书里的位置 */
  cfi: string;
  time: string;
  quote: string;
  note: string;
  chapter: string;
  /** 原生正文所在章节。旧笔记没有，打开时从 cfi 补上 */
  section?: number;
  /** 这一章正文里的起止，不含末尾 */
  start?: number;
  end?: number;
}

export interface ReadingDoc {
  book: string;
  title: string;
  author: string;
  /** 第一条感悟之前、自己写的正文，原样保留 */
  preamble: string;
  /** 读完后的总结 */
  summary: string;
  annos: Anno[];
}

const COMMENT = /^<!--\s*spark-anno\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\d+)\s+(\d+)\s+(\d+))?\s*-->$/;

function annoFrom(id: string, cfi: string, time: string, quote: string, note: string, chapter: string, section?: string, start?: string, end?: string): Anno {
  const anno: Anno = { id, cfi, time, quote, note, chapter };
  if (section != null && start != null && end != null) {
    const s = Number(section);
    const a = Number(start);
    const b = Number(end);
    if (Number.isInteger(s) && Number.isInteger(a) && Number.isInteger(b) && b > a) {
      anno.section = s;
      anno.start = a;
      anno.end = b;
    }
  }
  return anno;
}

function field(front: string, key: string): string {
  // 不能用 \s：空字段时它会把下一行吃进去，再保存就把书名和作者对错位
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(front);
  return (m?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
}

function quoteText(lines: string[]): string {
  return lines.map((l) => l.replace(/^>\s?/, "")).join("\n").trim();
}

function isAnnoBoundary(line: string): boolean {
  return line.startsWith("## ") || line.startsWith("> ") || COMMENT.test(line.trim());
}

function takeNote(lines: string[], i: number): { note: string; i: number } {
  while (i < lines.length && lines[i].trim() === "") i++;
  const note: string[] = [];
  while (i < lines.length && !isAnnoBoundary(lines[i])) note.push(lines[i++]);
  return { note: unwrapThought(note.join("\n")), i };
}

/** 显示时加的「心得：」标题，读回来不要留在正文里 */
function unwrapThought(note: string): string {
  const text = note.trim();
  const matched = /^心得[:：][ \t]*([\s\S]*)$/.exec(text);
  if (!matched) return text;
  return matched[1].trim();
}

export function parseReadingNote(md: string): ReadingDoc {
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  const front = fm?.[1] ?? "";
  const body = fm ? md.slice(fm[0].length) : md;
  const doc: ReadingDoc = {
    book: field(front, "book"),
    title: field(front, "title"),
    author: field(front, "author"),
    preamble: "",
    summary: "",
    annos: [],
  };
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let chapter = "";
  const preamble: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "## 总结") {
      doc.summary = lines.slice(i + 1).join("\n").trim();
      break;
    }
    if (line.startsWith("# ") && !line.startsWith("## ")) {
      const heading = line.slice(2).trim();
      // 旧笔记把书名再写了一遍，阅读页标题已经有了，不再当成正文
      if (heading === doc.title || heading === "读书笔记") {
        i++;
        continue;
      }
    }
    if (line.startsWith("## ")) {
      chapter = line.slice(3).trim();
      i++;
      continue;
    }
    const ahead = COMMENT.exec(line.trim());
    if (ahead) {
      i++;
      const taken = takeNote(lines, i);
      i = taken.i;
      doc.annos.push(annoFrom(ahead[1], ahead[2], ahead[3], "", taken.note, chapter || "正文", ahead[4], ahead[5], ahead[6]));
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) quote.push(lines[i++]);
      // 引文和注释之间可以空一行。空行本身不是新的一条
      let j = i;
      while (j < lines.length && lines[j].trim() === "") j++;
      const comment = COMMENT.exec(lines[j]?.trim() ?? "");
      if (!comment) {
        preamble.push(...quote);
        continue;
      }
      i = j + 1;
      const taken = takeNote(lines, i);
      i = taken.i;
      doc.annos.push(annoFrom(comment[1], comment[2], comment[3], quoteText(quote), taken.note, chapter || "正文", comment[4], comment[5], comment[6]));
      continue;
    }
    preamble.push(line);
    i++;
  }
  if (!doc.annos.length) doc.preamble = preamble.join("\n").trim();
  return doc;
}

export function renderReadingNote(doc: ReadingDoc): string {
  const parts = [
    "---",
    `book: ${doc.book}`,
    `title: ${doc.title}`,
    `author: ${doc.author}`,
    "---",
    "",
  ];
  if (doc.preamble.trim()) parts.push(doc.preamble.trim(), "");
  for (const anno of doc.annos) {
    const quote = anno.quote.trim();
    // 只划线、没写想法时也要留下原文。只写想法（没有引文）不补空的 >
    if (quote) {
      for (const line of quote.split("\n")) parts.push(`> ${line}`);
      // 空一行，不然下一行会被当成引用的延续，定位注释就显示在原文里
      parts.push("");
    }
    const span = anno.section != null && anno.start != null && anno.end != null ? ` ${anno.section} ${anno.start} ${anno.end}` : "";
    parts.push(`<!-- spark-anno ${anno.id} ${anno.cfi} ${anno.time}${span} -->`);
    const thought = anno.note.trim();
    if (thought) parts.push("", "心得：", thought);
    parts.push("");
  }
  if (doc.summary.trim()) parts.push("## 总结", "", doc.summary.trim(), "");
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
}

export function withAnno(md: string, meta: { book: string; title: string; author: string }, change: (doc: ReadingDoc) => void): string {
  const doc = md.trim() ? parseReadingNote(md) : { book: "", title: "", author: "", preamble: "", summary: "", annos: [] };
  if (!doc.book) doc.book = meta.book;
  if (!doc.title) doc.title = meta.title;
  if (!doc.author) doc.author = meta.author;
  change(doc);
  return renderReadingNote(doc);
}

export function safeBookName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
  return cleaned || "未命名";
}

/** 同一本书沿用原来的文件夹；书名被别的书占用时加“ (2)” */
export function readingNoteRel(title: string, bookFile: string, existing: { folder: string; book: string }[]): string {
  const base = safeBookName(title);
  const mine = existing.find((e) => e.book === bookFile);
  if (mine) return `读书笔记/${mine.folder}/${mine.folder}.md`;
  let name = base;
  let n = 2;
  const used = new Set(existing.map((e) => e.folder));
  while (used.has(name)) name = `${base} (${n++})`;
  return `读书笔记/${name}/${name}.md`;
}

export interface Bookmark {
  id: string;
  cfi: string;
  label: string;
  excerpt: string;
  fraction: number;
  createdMs: number;
}

/** 当前位置已经有书签就去掉，否则加上 */
export function toggleBookmark(list: Bookmark[], point: Omit<Bookmark, "id"> & { id?: string }): Bookmark[] {
  const hit = list.find((b) => b.cfi === point.cfi);
  if (hit) return list.filter((b) => b !== hit);
  return [...list, { ...point, id: point.id ?? `b${Date.now().toString(36)}` }];
}
