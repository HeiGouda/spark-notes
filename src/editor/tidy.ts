import pangu, { CJK } from "pangu/shared";
import type { Mark, Node } from "@milkdown/kit/prose/model";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { closeHistory } from "@milkdown/kit/prose/history";

/** 一键整理的规则，对应需求文档 5.15；label 用于状态栏里的计数说明 */
export const TIDY_RULES = [
  { id: "cjkSpacing", title: "中文与英文、数字之间加空格", hint: "", label: "中英文空格", default: true },
  { id: "cjkPunct", title: "中文句子里的半角标点改为全角", hint: ", → ，", label: "标点", default: true },
  { id: "fullwidthAlnum", title: "全角英文和数字改为半角", hint: "ＡＢＣ１２３ → ABC123", label: "全角字母数字", default: true },
  { id: "blankLines", title: "合并连续的空行", hint: "", label: "空行", default: true },
  { id: "trailingSpace", title: "去掉行尾空格", hint: "", label: "行尾空格", default: true },
  { id: "headingLevels", title: "修正标题跳级", hint: "H1 下面直接是 H3 时改为 H2，会改变结构", label: "标题层级", default: false },
] as const;

export type TidyRuleId = (typeof TIDY_RULES)[number]["id"];
export type TidyRules = Record<TidyRuleId, boolean>;
export type TidyCounts = Record<TidyRuleId, number>;

export const DEFAULT_TIDY_RULES = Object.fromEntries(TIDY_RULES.map((r) => [r.id, r.default])) as TidyRules;

const emptyCounts = (): TidyCounts => Object.fromEntries(TIDY_RULES.map((r) => [r.id, 0])) as TidyCounts;

export function normalizeTidyRules(raw: unknown): TidyRules {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_TIDY_RULES };
  for (const r of TIDY_RULES) if (typeof src[r.id] === "boolean") out[r.id] = src[r.id] as boolean;
  return out;
}

const CJK_RE = new RegExp(`[${CJK}]`);
const isCjk = (ch: string | undefined) => !!ch && CJK_RE.test(ch);

const PUNCT: Record<string, string> = { ",": "，", ";": "；", ":": "：", "?": "？", "!": "！", ".": "。" };

/** 双向链接、图片等非文字的行内节点在文字里的占位符 */
export const OBJECT_CHAR = "\uFFFC";
/** 硬换行的占位符 */
export const BREAK_CHAR = "\n";

function halfwidthOf(ch: string): string | null {
  const c = ch.charCodeAt(0);
  const alnum = (c >= 0xff10 && c <= 0xff19) || (c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a);
  return alnum ? String.fromCharCode(c - 0xfee0) : null;
}

/**
 * 基于原文位置的一处改动：从 at 起删掉 del 个字符，再插入 insert。
 * counted 为 true 的改动在状态栏里计为一处（连续的全角字符、连续的行尾空格只算一处）。
 */
export interface TextEdit {
  at: number;
  del: number;
  insert: string;
  rule: TidyRuleId;
  counted: boolean;
}

interface Cell {
  ch: string;
  prot: boolean;
  orig: number;
  rule?: TidyRuleId;
}

const isSpace = (c: Cell) => !c.prot && (c.ch === " " || c.ch === "\t");

/**
 * 计算一段文字的整理结果（空行与标题层级在文档结构上处理，不在这里）。
 * prot[i] 为 true 的字符（行内代码、占位符）保持原样，也不会在其内部插入空格。
 */
export function planText(text: string, prot: boolean[], rules: TidyRules): TextEdit[] {
  let cells: Cell[] = [];
  for (let i = 0; i < text.length; i++) cells.push({ ch: text[i], prot: !!prot[i], orig: i });
  const removed = new Map<number, TidyRuleId>();

  if (rules.fullwidthAlnum) {
    for (const c of cells) {
      const half = c.prot ? null : halfwidthOf(c.ch);
      if (half) {
        c.ch = half;
        c.rule = "fullwidthAlnum";
      }
    }
  }

  if (rules.cjkPunct) {
    const out: Cell[] = [];
    let skipSpaces = false;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (skipSpaces && isSpace(c)) {
        removed.set(c.orig, "cjkPunct");
        continue;
      }
      skipSpaces = false;
      const full = c.prot ? undefined : PUNCT[c.ch];
      if (full) {
        let j = out.length - 1;
        while (j >= 0 && isSpace(out[j])) j--;
        const prev = out[j];
        const next = cells[i + 1]?.ch;
        // 双向链接等对象看不到文字，后面紧跟中文时按中文语境处理
        const afterCjk = !!prev && (isCjk(prev.ch) || prev.rule === "cjkPunct" || (prev.ch === OBJECT_CHAR && isCjk(next)));
        const okNext = c.ch === "." ? next === undefined || /\s/.test(next) || isCjk(next) : next !== c.ch;
        if (afterCjk && okNext) {
          for (const s of out.splice(j + 1)) removed.set(s.orig, "cjkPunct");
          out.push({ ...c, ch: full, rule: "cjkPunct" });
          skipSpaces = true;
          continue;
        }
      }
      out.push(c);
    }
    cells = out;
  }

  if (rules.trailingSpace) {
    const out: Cell[] = [];
    for (let i = 0; i < cells.length; i++) {
      if (isSpace(cells[i])) {
        let k = i;
        while (k < cells.length && isSpace(cells[k])) k++;
        if (k === cells.length || cells[k].ch === BREAK_CHAR) {
          for (let d = i; d < k; d++) removed.set(cells[d].orig, "trailingSpace");
          i = k - 1;
          continue;
        }
      }
      out.push(cells[i]);
    }
    cells = out;
  }

  /** 在 cells[i] 之前插入空格 */
  const inserts: number[] = [];
  if (rules.cjkSpacing) {
    // 行内代码整体按英文处理，这样它和中文之间也会加空格
    const joined = cells.map((c) => (c.prot && c.ch !== BREAK_CHAR && c.ch !== OBJECT_CHAR ? "x" : c.ch)).join("");
    const spaced = pangu.spaceText(joined);
    const found: number[] = [];
    let i = 0;
    let j = 0;
    let ok = true;
    while (j < spaced.length) {
      if (i < joined.length && joined[i] === spaced[j]) {
        i++;
        j++;
      } else if (spaced[j] === " ") {
        found.push(i);
        j++;
      } else {
        ok = false;
        break;
      }
    }
    // pangu 只插入空格；结果对不上时宁可不改
    if (ok && i === joined.length) {
      for (const at of found) if (!(cells[at - 1]?.prot && cells[at]?.prot)) inserts.push(at);
    }
  }

  const edits: TextEdit[] = [];
  let k = 0;
  for (let i = 0; i < text.length; i++) {
    const cell = cells[k];
    if (cell && cell.orig === i) {
      if (cell.ch !== text[i]) {
        const last = edits[edits.length - 1];
        const continues = cell.rule === "fullwidthAlnum" && last?.rule === "fullwidthAlnum" && last.at + last.del === i;
        edits.push({ at: i, del: 1, insert: cell.ch, rule: cell.rule!, counted: !continues });
      }
      k++;
      continue;
    }
    const rule = removed.get(i)!;
    const last = edits[edits.length - 1];
    if (last && last.insert === "" && last.rule === rule && last.at + last.del === i) last.del++;
    else edits.push({ at: i, del: 1, insert: "", rule, counted: rule === "trailingSpace" });
  }
  for (const idx of inserts) {
    edits.push({ at: idx < cells.length ? cells[idx].orig : text.length, del: 0, insert: " ", rule: "cjkSpacing", counted: true });
  }
  return edits;
}

/** 从后往前应用；同一位置先替换再插入，互不干扰 */
export function sortEdits<T extends { at: number; del: number }>(edits: T[]): T[] {
  return [...edits].sort((a, b) => b.at - a.at || b.del - a.del);
}

export function applyEdits(text: string, edits: { at: number; del: number; insert: string }[]): string {
  let out = text;
  for (const e of sortEdits(edits)) out = out.slice(0, e.at) + e.insert + out.slice(e.at + e.del);
  return out;
}

/** 整理一段纯文字（测试用） */
export function tidyString(text: string, rules: TidyRules = DEFAULT_TIDY_RULES): string {
  return applyEdits(text, planText(text, [], rules));
}

/** 按标题顺序修正跳级：每个标题最多比上级深一级，没有上级的标题保持原级别 */
export function fixHeadingLevels(levels: number[]): number[] {
  const stack: { orig: number; next: number }[] = [];
  return levels.map((level) => {
    while (stack.length && stack[stack.length - 1].orig >= level) stack.pop();
    const parent = stack[stack.length - 1];
    const next = parent ? Math.min(level, parent.next + 1) : level;
    stack.push({ orig: level, next });
    return next;
  });
}

interface DocEdit {
  at: number;
  del: number;
  insert: string;
  marks: readonly Mark[];
}

function flatten(block: Node): { text: string; prot: boolean[]; marks: (readonly Mark[])[] } {
  let text = "";
  const prot: boolean[] = [];
  const marks: (readonly Mark[])[] = [];
  block.forEach((child) => {
    if (child.isText) {
      const code = child.marks.some((m) => m.type.spec.code);
      for (let i = 0; i < child.text!.length; i++) {
        prot.push(code);
        marks.push(child.marks);
      }
      text += child.text;
    } else {
      text += child.type.name === "hardbreak" ? BREAK_CHAR : OBJECT_CHAR;
      prot.push(true);
      marks.push(child.marks);
    }
  });
  return { text, prot, marks };
}

const isEmptyParagraph = (n: Node) => n.type.name === "paragraph" && n.content.size === 0;

/**
 * 按规则整理文档，返回一个事务（整体一步撤销）。
 * 有选区时只改选区范围内的内容；代码块、行内代码、双向链接等不动。
 */
export function tidyTransaction(state: EditorState, rules: TidyRules): { tr: Transaction; counts: TidyCounts; total: number } {
  const { doc, selection, schema } = state;
  const from = selection.empty ? 0 : selection.from;
  const to = selection.empty ? doc.content.size : selection.to;
  const counts = emptyCounts();
  const edits: DocEdit[] = [];

  const scanChildren = (parent: Node, start: number) => {
    if (!rules.blankLines) return;
    let prevEmpty = false;
    parent.forEach((child, offset) => {
      const pos = start + offset;
      const empty = isEmptyParagraph(child);
      if (empty && prevEmpty && pos >= from && pos + child.nodeSize <= to) {
        edits.push({ at: pos, del: child.nodeSize, insert: "", marks: [] });
        counts.blankLines++;
      }
      prevEmpty = empty;
    });
  };

  scanChildren(doc, 0);
  doc.descendants((node, pos) => {
    if (pos > to || pos + node.nodeSize < from) return false;
    if (!node.isTextblock) {
      if (!node.isLeaf) scanChildren(node, pos + 1);
      return true;
    }
    if (node.type.spec.code) return false;
    const { text, prot, marks } = flatten(node);
    const base = pos + 1;
    for (const e of planText(text, prot, rules)) {
      const at = base + e.at;
      if (at < from || at + e.del > to) continue;
      // 替换沿用原字符的格式；插入的空格只带前后共有的格式（例如不进入行内代码）
      const before = marks[e.at - 1] ?? [];
      const after = marks[e.at] ?? before;
      const m = e.del > 0 ? marks[e.at] : before.filter((x) => x.isInSet(after));
      edits.push({ at, del: e.del, insert: e.insert, marks: m });
      if (e.counted) counts[e.rule]++;
    }
    return false;
  });

  const tr = closeHistory(state.tr);
  for (const e of sortEdits(edits)) {
    if (e.insert && e.del) tr.replaceWith(e.at, e.at + e.del, schema.text(e.insert, e.marks));
    else if (e.insert) tr.insert(e.at, schema.text(e.insert, e.marks));
    else tr.delete(e.at, e.at + e.del);
  }

  if (rules.headingLevels) {
    const heads: { pos: number; node: Node }[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === "heading") heads.push({ pos, node });
      return !node.isTextblock;
    });
    const next = fixHeadingLevels(heads.map((h) => h.node.attrs.level as number));
    heads.forEach((h, i) => {
      if (next[i] === h.node.attrs.level || h.pos < from || h.pos > to) return;
      tr.setNodeMarkup(tr.mapping.map(h.pos), undefined, { ...h.node.attrs, level: next[i] });
      counts.headingLevels++;
    });
  }

  const total = TIDY_RULES.reduce((n, r) => n + counts[r.id], 0);
  return { tr, counts, total };
}

/** 状态栏提示，例如“已整理 17 处：中英文空格 12 处、标点 5 处” */
export function describeTidy(counts: TidyCounts): string {
  const parts = TIDY_RULES.filter((r) => counts[r.id] > 0).map((r) => `${r.label} ${counts[r.id]} 处`);
  const total = TIDY_RULES.reduce((n, r) => n + counts[r.id], 0);
  return total ? `已整理 ${total} 处：${parts.join("、")}` : "没有需要整理的地方";
}
