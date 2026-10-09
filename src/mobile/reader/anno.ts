/** 读书笔记 md：只记自己写的感悟和读完后的总结。位置写在不显示的注释里，不摘录原文 */

export interface Anno {
  id: string;
  /** 在书里的位置 */
  cfi: string;
  time: string;
  quote: string;
  note: string;
  chapter: string;
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

const COMMENT = /^<!--\s*spark-anno\s+(\S+)\s+(\S+)\s+(\S+)\s*-->$/;

function field(front: string, key: string): string {
  const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(front);
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
  return { note: note.join("\n").trim(), i };
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
      doc.annos.push({
        id: ahead[1],
        cfi: ahead[2],
        time: ahead[3],
        quote: "",
        note: taken.note,
        chapter: chapter || "正文",
      });
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) quote.push(lines[i++]);
      const comment = COMMENT.exec(lines[i]?.trim() ?? "");
      if (!comment) {
        preamble.push(...quote);
        continue;
      }
      i++;
      const taken = takeNote(lines, i);
      i = taken.i;
      doc.annos.push({
        id: comment[1],
        cfi: comment[2],
        time: comment[3],
        quote: quoteText(quote),
        note: taken.note,
        chapter: chapter || "正文",
      });
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
    parts.push(`<!-- spark-anno ${anno.id} ${anno.cfi} ${anno.time} -->`);
    if (anno.note.trim()) parts.push(anno.note.trim(), "");
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
