import { decodeText, isComment, linesOf, quoteText, type DiagramIssue, type ParseResult } from "./issues";
import { formatCanvas, formatNode, isSparkLine, parseSpark, type CanvasStyle, type NodeStyle } from "./spark";

/**
 * Mermaid `mindmap` 的子集：按缩进表示层级的纯文字节点，第一个节点为根节点，`%%` 注释。
 * 含特殊字符的文字写成 `["文字"]`，读回仍是纯文字。其他节点形状、图标、样式类都不支持（见需求文档 5.18）。
 */
export interface MindNode {
  /** 只在内存中使用，用于选中和撤销，不写进文件 */
  id: string;
  text: string;
  children: MindNode[];
  /** 紧挨在这个节点前面的注释行（含 `%%`），保存时原样写回 */
  comments: string[];
  style?: NodeStyle;
  /** 概要：概括 children 中从 from 到 to 的一段 */
  summaries?: MindSummary[];
}

export interface MindSummary {
  from: string;
  to: string;
  node: MindNode;
}

export interface MindDoc {
  /** `mindmap` 之前的注释 */
  head: string[];
  canvas: CanvasStyle;
  root: MindNode;
  /** 最后一个节点之后的注释 */
  tail: string[];
}

let seq = 0;
export function newMindId(): string {
  return `m${++seq}`;
}

export function mindNode(text: string, children: MindNode[] = []): MindNode {
  return { id: newMindId(), text, children, comments: [] };
}

/** 空文件（刚新建）按只有根节点的图显示，根节点文字为文件名 */
export function emptyMind(rootText: string): MindDoc {
  return { head: [], canvas: {}, root: mindNode(rootText), tail: [] };
}

const QUOTED = /^\["(.*)"\]$/;

function unsupported(t: string): string | null {
  if (t.startsWith("::icon(")) return "用到了暂不支持的图标（::icon）";
  if (t.includes(":::")) return "用到了暂不支持的样式类（:::）";
  if (/[()[\]{}]/.test(t)) return "用到了暂不支持的节点形状（括号写法）";
  return null;
}

export function parseMind(text: string, fallbackRoot: string): ParseResult<MindDoc> {
  const lines = linesOf(text);
  if (lines.every((l) => !l.trim())) return { ok: true, doc: emptyMind(fallbackRoot) };
  const issues: DiagramIssue[] = [];
  const head: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (isComment(t)) head.push(t);
    else break;
  }
  if (i >= lines.length || lines[i].trim().toLowerCase() !== "mindmap") {
    return { ok: false, issues: [{ line: Math.min(i, lines.length - 1) + 1, message: "无法识别：思维导图应以 mindmap 开头" }] };
  }
  const canvas: CanvasStyle = {};
  let root: MindNode | null = null;
  let rootIndent = 0;
  /** 每层的节点，以及这个节点在父节点下是第几个普通子节点之后（用于核对概要范围） */
  const stack: { indent: number; node: MindNode }[] = [];
  let pending: string[] = [];
  let spark = null as { style: NodeStyle; summary?: number } | null;
  let first = true;
  for (i++; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) continue;
    if (isSparkLine(t)) {
      const info = parseSpark(t);
      if (first) Object.assign(canvas, info.canvas);
      spark = { style: { ...spark?.style, ...info.style }, summary: info.summary ?? spark?.summary };
      first = false;
      continue;
    }
    first = false;
    if (isComment(t)) {
      pending.push(t);
      continue;
    }
    let body = t;
    const quoted = QUOTED.exec(t);
    if (quoted) body = decodeText(quoted[1]);
    else {
      const bad = unsupported(t);
      if (bad) {
        issues.push({ line: i + 1, message: bad });
        continue;
      }
    }
    const indent = line.length - line.trimStart().length;
    const node: MindNode = { id: newMindId(), text: body, children: [], comments: pending };
    if (spark && Object.keys(spark.style).length) node.style = spark.style;
    const summary = spark?.summary;
    pending = [];
    spark = null;
    if (!root) {
      root = node;
      rootIndent = indent;
      stack.push({ indent, node });
      continue;
    }
    if (indent <= rootIndent) {
      issues.push({ line: i + 1, message: "无法识别：思维导图只能有一个根节点" });
      continue;
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    // 概要范围对不上（前面没有这么多同级节点）时当作普通子节点
    if (summary && summary <= parent.children.length) {
      const kids = parent.children;
      (parent.summaries ??= []).push({ from: kids[kids.length - summary].id, to: kids[kids.length - 1].id, node });
    } else {
      parent.children.push(node);
    }
    stack.push({ indent, node });
  }
  if (issues.length) return { ok: false, issues };
  if (!root) return { ok: true, doc: { head, canvas, root: mindNode(fallbackRoot), tail: pending } };
  return { ok: true, doc: { head, canvas, root, tail: pending } };
}

/** 编辑框里输入的文字：每行去掉首尾空白、去掉空行，不能为空 */
export function cleanMindText(text: string): string {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).join("\n") || "未命名";
}

/** 写进文件的节点文字：会被 Mermaid 当成形状、图标、样式类或注释的文字，以及多行文字加引号 */
export function mindTextOut(text: string): string {
  const t = cleanMindText(text);
  if (/[()[\]{}"\n]/.test(t) || t.includes(":::") || t.startsWith("%%") || t.startsWith("::")) return `[${quoteText(t)}]`;
  return t;
}

export function summaryCount(parent: MindNode, s: MindSummary): number {
  const a = parent.children.findIndex((c) => c.id === s.from);
  const b = parent.children.findIndex((c) => c.id === s.to);
  return a < 0 || b < 0 ? 0 : Math.abs(b - a) + 1;
}

export function serializeMind(doc: MindDoc): string {
  const out = [...doc.head, "mindmap"];
  const canvas = formatCanvas(doc.canvas);
  if (canvas) out.push("  " + canvas);
  const walk = (node: MindNode, depth: number, summary?: number) => {
    const pad = "  ".repeat(depth + 1);
    for (const c of node.comments) out.push(pad + c);
    const spark = formatNode(node.style, { summary });
    if (spark) out.push(pad + spark);
    out.push(pad + mindTextOut(node.text));
    for (const child of node.children) {
      walk(child, depth + 1);
      for (const s of node.summaries ?? []) {
        if (s.to === child.id) walk(s.node, depth + 1, summaryCount(node, s));
      }
    }
  };
  walk(doc.root, 0);
  for (const c of doc.tail) out.push("  " + c);
  return out.join("\n") + "\n";
}

/**
 * 解析 AI 生成的思维导图（可能还在生成中、只收到一部分）。比解析文件宽松：
 * 去掉代码块标记和列表符号，`root((主题))` 这类形状只取文字；图标、样式类等无法采用的行跳过并计数。
 */
export function parseAiMind(text: string, fallbackRoot: string): { doc: MindDoc; skipped: number } {
  const fenced = /```[\w-]*[ \t]*\n([\s\S]*?)(?:\n```|$)/.exec(text);
  const lines = (fenced ? fenced[1] : text).split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === "mindmap");
  if (start < 0) return { doc: emptyMind(fallbackRoot), skipped: 0 };
  let skipped = 0;
  let root: MindNode | null = null;
  let rootIndent = 0;
  const stack: { indent: number; node: MindNode }[] = [];
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (!t || isComment(t)) continue;
    if (t.startsWith("```")) break;
    if (t.startsWith("::icon(") || t.includes(":::")) {
      skipped++;
      continue;
    }
    let body = t.replace(/^[-*+]\s+/, "");
    const shape = /^[^\s()[\]{}]*\s*(?:\(\(|\)\)|\(-|\(|\[|\{\{|\))(.*?)(?:\)\)|\(\(|-\)|\)|\]|\}\}|\()$/.exec(body);
    if (shape) body = shape[1];
    body = cleanMindText(body.replace(/^["'`]+|["'`]+$/g, ""));
    const indent = line.length - line.trimStart().length;
    const node = mindNode(body);
    if (!root) {
      root = node;
      rootIndent = indent;
      stack.push({ indent, node });
      continue;
    }
    if (indent <= rootIndent) {
      skipped++;
      continue;
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  return { doc: { head: [], canvas: {}, root: root ?? mindNode(fallbackRoot), tail: [] }, skipped };
}

/* ---------- 遍历 ---------- */

/** 先序遍历全部节点（含概要节点），概要节点紧跟在它概括的最后一个节点的子树之后 */
export function eachMind(root: MindNode, fn: (n: MindNode) => void) {
  const walk = (n: MindNode) => {
    fn(n);
    for (const c of n.children) {
      walk(c);
      for (const s of n.summaries ?? []) if (s.to === c.id) walk(s.node);
    }
  };
  walk(root);
}

export function findMind(doc: MindDoc, id: string): MindNode | null {
  let hit: MindNode | null = null;
  eachMind(doc.root, (n) => {
    if (!hit && n.id === id) hit = n;
  });
  return hit;
}

/** 节点所在的父节点；概要节点的父节点是它概括的那些节点的父节点 */
export function ownerOf(doc: MindDoc, id: string): { parent: MindNode; summary: MindSummary | null } | null {
  let out: { parent: MindNode; summary: MindSummary | null } | null = null;
  eachMind(doc.root, (n) => {
    if (out) return;
    if (n.children.some((c) => c.id === id)) out = { parent: n, summary: null };
    const s = n.summaries?.find((x) => x.node.id === id);
    if (s) out = { parent: n, summary: s };
  });
  return out;
}

export function parentOf(doc: MindDoc, id: string): MindNode | null {
  return ownerOf(doc, id)?.parent ?? null;
}

export function isSummaryNode(doc: MindDoc, id: string): boolean {
  return !!ownerOf(doc, id)?.summary;
}

function contains(node: MindNode, id: string): boolean {
  let hit = false;
  eachMind(node, (n) => {
    if (n.id === id) hit = true;
  });
  return hit;
}

export function countMind(node: MindNode): number {
  let n = 0;
  eachMind(node, () => n++);
  return n;
}

/* ---------- 编辑操作：直接修改 doc，调用方负责撤销快照 ---------- */

/**
 * 普通子节点 id 要离开 parent（删除或移走）：概要范围随之缩小；
 * 范围里一个都不剩时，概要节点连同子节点变成 parent 下的普通子节点，放在原来的位置。
 */
function releaseChild(parent: MindNode, id: string) {
  const kids = parent.children;
  const at = kids.findIndex((c) => c.id === id);
  if (at < 0 || !parent.summaries) return;
  const freed: MindNode[] = [];
  parent.summaries = parent.summaries.filter((s) => {
    if (s.from === id && s.to === id) {
      freed.push(s.node);
      return false;
    }
    const a = kids.findIndex((c) => c.id === s.from);
    const b = kids.findIndex((c) => c.id === s.to);
    if (s.from === id) s.from = kids[a < b ? at + 1 : at - 1].id;
    if (s.to === id) s.to = kids[b > a ? at - 1 : at + 1].id;
    return true;
  });
  if (!parent.summaries.length) delete parent.summaries;
  kids.splice(at + 1, 0, ...freed);
}

export function addChild(doc: MindDoc, parentId: string, text: string): string | null {
  const parent = findMind(doc, parentId);
  if (!parent) return null;
  const node = mindNode(text);
  parent.children.push(node);
  return node.id;
}

/** 在节点后面加同级节点；根节点没有同级，改为加子节点；概要节点加在它概括的最后一个节点后面 */
export function addSibling(doc: MindDoc, id: string, text: string): string | null {
  const own = ownerOf(doc, id);
  if (!own) return addChild(doc, id, text);
  const after = own.summary ? own.summary.to : id;
  const node = mindNode(text);
  own.parent.children.splice(own.parent.children.findIndex((c) => c.id === after) + 1, 0, node);
  return node.id;
}

/** 删除节点及其子节点，返回删除后应选中的节点（前一个同级，没有则后一个，再没有则父节点） */
export function removeMind(doc: MindDoc, id: string): string | null {
  const own = ownerOf(doc, id);
  if (!own) return null;
  const { parent, summary } = own;
  if (summary) {
    parent.summaries = parent.summaries!.filter((s) => s !== summary);
    if (!parent.summaries.length) delete parent.summaries;
    return summary.to;
  }
  const at = parent.children.findIndex((c) => c.id === id);
  releaseChild(parent, id);
  parent.children.splice(at, 1);
  return (parent.children[at - 1] ?? parent.children[at] ?? parent).id;
}

/** 移到 newParent 的第 index 个普通子节点位置；不能移到自己或自己的子孙下面。概要节点移走后变成普通节点 */
export function moveMind(doc: MindDoc, id: string, newParentId: string, index: number): boolean {
  const node = findMind(doc, id);
  const own = ownerOf(doc, id);
  const target = findMind(doc, newParentId);
  if (!node || !own || !target || contains(node, newParentId)) return false;
  const { parent, summary } = own;
  let from = -1;
  if (summary) {
    parent.summaries = parent.summaries!.filter((s) => s !== summary);
    if (!parent.summaries.length) delete parent.summaries;
  } else {
    from = parent.children.indexOf(node);
    // 在同一父节点下调整顺序且范围里只有它时，概要跟着它走
    const alone = parent === target && parent.summaries?.some((s) => s.from === id && s.to === id);
    if (!alone) releaseChild(parent, id);
    from = parent.children.indexOf(node);
    parent.children.splice(from, 1);
  }
  const at = parent === target && from >= 0 && from < index ? index - 1 : index;
  target.children.splice(Math.max(0, Math.min(at, target.children.length)), 0, node);
  return true;
}

/** 给同一父节点下的一段相邻普通子节点建概要，返回概要节点 id */
export function addSummary(doc: MindDoc, ids: string[], text: string): string | null {
  if (!ids.length) return null;
  const parent = parentOf(doc, ids[0]);
  if (!parent) return null;
  const idx = ids.map((id) => parent.children.findIndex((c) => c.id === id));
  if (idx.some((i) => i < 0)) return null;
  const node = mindNode(text);
  (parent.summaries ??= []).push({
    from: parent.children[Math.min(...idx)].id,
    to: parent.children[Math.max(...idx)].id,
    node,
  });
  return node.id;
}

/** 节点的全部子节点（普通子节点和概要节点），用于折叠、展开 */
export function hasKids(n: MindNode): boolean {
  return n.children.length > 0 || !!n.summaries?.length;
}

/** 在节点前面加同级节点；根节点改为加在第一个子节点位置；概要节点加在它概括的第一个节点前面 */
export function addSiblingBefore(doc: MindDoc, id: string, text: string): string | null {
  const own = ownerOf(doc, id);
  const node = mindNode(text);
  if (!own) {
    const root = findMind(doc, id);
    if (!root) return null;
    root.children.unshift(node);
    return node.id;
  }
  const before = own.summary ? own.summary.from : id;
  own.parent.children.splice(own.parent.children.findIndex((c) => c.id === before), 0, node);
  return node.id;
}

/**
 * 插入父主题：新节点放在选中节点中最靠前的位置，选中的节点按原来的先后变成它的子节点。
 * 选中的必须是同一父节点下的普通子节点，否则返回 null。
 */
export function addParent(doc: MindDoc, ids: string[], text: string): string | null {
  if (!ids.length) return null;
  const owners = ids.map((id) => ownerOf(doc, id));
  if (owners.some((o) => !o || o.summary || o.parent !== owners[0]!.parent)) return null;
  const parent = owners[0]!.parent;
  const moving = parent.children.filter((c) => ids.includes(c.id));
  const at = parent.children.indexOf(moving[0]);
  const node = mindNode(text);
  parent.children.splice(at, 0, node);
  for (const m of moving) {
    releaseChild(parent, m.id);
    parent.children.splice(parent.children.indexOf(m), 1);
    node.children.push(m);
  }
  return node.id;
}

/**
 * 一次移动多个节点（保持它们在图中的先后）：放到 target 下面，或放在 target 的前面 / 后面。
 * 任何一个节点是 target 或 target 的祖先时不移动，返回 false。
 */
export function moveMany(doc: MindDoc, ids: string[], target: string, where: "child" | "before" | "after"): boolean {
  const order: string[] = [];
  eachMind(doc.root, (n) => ids.includes(n.id) && order.push(n.id));
  const moving = order.filter((id) => !order.some((other) => other !== id && contains(findMind(doc, other)!, id)));
  if (!moving.length || moving.some((id) => contains(findMind(doc, id)!, target))) return false;
  if (where === "child") {
    for (const id of moving) moveMind(doc, id, target, findMind(doc, target)!.children.length);
    return true;
  }
  const parent = parentOf(doc, target);
  if (!parent || isSummaryNode(doc, target)) return false;
  // 放在前面：每个都插到 target 前面；放在后面：每个都插到上一个后面。先后顺序都不变
  let anchor = target;
  for (const id of moving) {
    const at = parent.children.findIndex((c) => c.id === anchor);
    moveMind(doc, id, parent.id, where === "before" ? at : at + 1);
    if (where === "after") anchor = id;
  }
  return true;
}

/** 深拷贝一棵子树并换上新的 id（复制、粘贴、克隆用） */
export function cloneTree(n: MindNode): MindNode {
  const ids = new Map<string, string>();
  const walk = (m: MindNode): MindNode => {
    const copy: MindNode = { id: newMindId(), text: m.text, children: [], comments: [] };
    ids.set(m.id, copy.id);
    if (m.style) copy.style = { ...m.style };
    copy.children = m.children.map(walk);
    if (m.summaries) {
      copy.summaries = m.summaries.map((s) => ({ from: "", to: "", node: walk(s.node), src: s }) as MindSummary & { src: MindSummary });
    }
    return copy;
  };
  const out = walk(n);
  eachMind(out, (m) => {
    for (const s of (m.summaries ?? []) as (MindSummary & { src?: MindSummary })[]) {
      if (!s.src) continue;
      s.from = ids.get(s.src.from) ?? "";
      s.to = ids.get(s.src.to) ?? "";
      delete s.src;
    }
  });
  return out;
}

/** 子树写成缩进文字（每层两个空格），用于系统剪贴板 */
export function treesToText(trees: MindNode[]): string {
  const out: string[] = [];
  const walk = (n: MindNode, depth: number) => {
    out.push("  ".repeat(depth) + n.text.replace(/\n/g, " "));
    n.children.forEach((c) => walk(c, depth + 1));
    n.summaries?.forEach((s) => walk(s.node, depth + 1));
  };
  trees.forEach((t) => walk(t, 0));
  return out.join("\n");
}

/** 从其他软件复制的多行文字：按缩进生成子树，去掉列表符号 */
export function textToTrees(text: string): MindNode[] {
  const roots: MindNode[] = [];
  const stack: { indent: number; node: MindNode }[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim()) continue;
    const expanded = raw.replace(/\t/g, "  ");
    const indent = expanded.length - expanded.trimStart().length;
    const body = expanded.trim().replace(/^([-*+•]|\d+[.)、])\s+/, "").trim();
    if (!body) continue;
    const node = mindNode(body);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }
  return roots;
}
