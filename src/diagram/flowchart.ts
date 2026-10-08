import { decodeEntities, decodeText, isComment, linesOf, quoteText, type DiagramIssue, type ParseResult } from "./issues";
import {
  formatCanvas, formatEdge, formatNode, isSparkLine, parseSpark, type CanvasStyle, type EdgeRoute, type NodeStyle, type Side, type SparkInfo,
} from "./spark";

/**
 * Mermaid `flowchart` 的子集（需求文档 5.18）：四个方向；九种节点形状；
 * 实线、无箭头、虚线、粗线四种连线与连线文字；`%%` 注释。其余写法视为不支持。
 * 节点位置、文字节点、连线走线写在 `%% spark:` 注释里。
 */
export type FlowDir = "TD" | "BT" | "LR" | "RL";
export type FlowShape = "rect" | "round" | "stadium" | "circle" | "diamond" | "hexagon" | "parallelogram" | "trapezoid" | "cylinder";
export type FlowEdgeStyle = "arrow" | "line" | "dotted" | "thick";

export const FLOW_SHAPES: FlowShape[] = ["rect", "round", "stadium", "circle", "diamond", "hexagon", "parallelogram", "trapezoid", "cylinder"];

export interface FlowNode {
  id: string;
  text: string;
  shape: FlowShape;
  comments: string[];
  style?: NodeStyle;
  /** 中心位置；没有时由自动排版补上 */
  x?: number;
  y?: number;
  /** 没有边框和背景的文字 */
  isText?: boolean;
  /** 手动调整的大小；没有时按文字自动算 */
  w?: number;
  h?: number;
}

export interface FlowEdge {
  /** 只在内存中使用 */
  key: string;
  from: string;
  to: string;
  style: FlowEdgeStyle;
  label: string;
  comments: string[];
  route?: EdgeRoute;
  /** 两端固定接在哪一边；没有时按两个节点的相对位置自动选 */
  fromSide?: Side;
  toSide?: Side;
  /** 手动拖过的直角 / 圆角走线：中间各段的位置（横段记 y、竖段记 x），需要两端接边都已固定 */
  bends?: number[];
}

export interface FlowDoc {
  head: string[];
  /** 最近一次自动整理用的方向 */
  dir: FlowDir;
  /** 配色方案、主题间距（流程图没有结构） */
  canvas: CanvasStyle;
  /** 定义顺序：决定同一层里从左到右（或从上到下）的顺序 */
  nodes: FlowNode[];
  edges: FlowEdge[];
  tail: string[];
}

export const ARROW: Record<FlowEdgeStyle, string> = { arrow: "-->", line: "---", dotted: "-.->", thick: "==>" };

let edgeSeq = 0;
const newEdgeKey = () => `e${++edgeSeq}`;

export function emptyFlow(): FlowDoc {
  return { head: [], dir: "TD", canvas: {}, nodes: [], edges: [], tail: [] };
}

/**
 * 不支持的语句。这些词也可能是普通的节点编号（`end([结束])`、`end --> x`），
 * 所以只在真的是这种语句的写法时才算：`end` 单独占一条语句；其余的后面要跟参数，
 * 而不是节点形状或连线。
 */
const ARG = String.raw`\s+(?![-=.<~]|[(\[{>@:|])\S`;
const UNSUPPORTED_KEYWORDS: [RegExp, string][] = [
  [/^subgraph\b/i, "子图（subgraph）"],
  [/^end$/i, "子图（subgraph … end）"],
  [new RegExp(`^direction${ARG}`, "i"), "子图方向（direction）"],
  [new RegExp(`^style${ARG}`, "i"), "样式（style）"],
  [new RegExp(`^classDef${ARG}`, "i"), "样式（classDef）"],
  [new RegExp(`^class${ARG}`, "i"), "样式类（class）"],
  [new RegExp(`^click${ARG}`, "i"), "点击链接（click）"],
  [new RegExp(`^linkStyle${ARG}`, "i"), "连线样式（linkStyle）"],
];

class Unsupported extends Error {}

/** 按分号拆分同一行里的多条语句，引号和括号里的分号不算 */
function splitStatements(line: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && "([{".includes(c)) depth++;
    else if (!quoted && ")]}".includes(c)) depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0 && c === ";") {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

interface NodeRef {
  id: string;
  text?: string;
  shape?: FlowShape;
}

const ID_RE = /^[\p{L}\p{N}_]+/u;

/** 解析一条语句：节点，或用连线串起来的若干节点 */
class StatementParser {
  pos = 0;
  constructor(private s: string) {}

  private rest() {
    return this.s.slice(this.pos);
  }

  private skipSpaces() {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++;
  }

  /** 读到任一个结尾符号为止，返回文字和实际遇到的结尾 */
  private readText(...closes: string[]): { text: string; close: string } {
    if (this.rest().startsWith('"`')) throw new Unsupported("Markdown 文字（\"` `\"）");
    let text: string;
    let close: string | undefined;
    if (this.s[this.pos] === '"') {
      const end = this.s.indexOf('"', this.pos + 1);
      if (end < 0) throw new Error("引号没有闭合");
      text = this.s.slice(this.pos + 1, end);
      this.pos = end + 1;
      close = closes.find((c) => this.rest().startsWith(c));
      if (!close) throw new Error(`缺少 ${closes[0]}`);
    } else {
      let end = -1;
      for (const c of closes) {
        const at = this.s.indexOf(c, this.pos);
        if (at >= 0 && (end < 0 || at < end)) {
          end = at;
          close = c;
        }
      }
      if (end < 0 || !close) throw new Error(`缺少 ${closes[0]}`);
      text = this.s.slice(this.pos, end);
      if (/["()[\]{}]/.test(text)) throw new Unsupported("节点形状或文字写法");
      this.pos = end;
    }
    this.pos += close.length;
    return { text: decodeText(text.trim()).split("\n").map((l) => l.trim()).join("\n"), close };
  }

  node(): NodeRef {
    this.skipSpaces();
    const m = ID_RE.exec(this.rest());
    if (!m) throw new Error("缺少节点名称");
    const id = m[0];
    this.pos += id.length;
    const r = this.rest();
    if (r.startsWith(":::")) throw new Unsupported("样式类（:::）");
    if (r.startsWith("@{")) throw new Unsupported("新版节点写法（@{ }）");
    if (r.startsWith("(((") || r.startsWith("[[") || r.startsWith("[\\") || r.startsWith(">")) {
      throw new Unsupported("节点形状");
    }
    const shapes: [string, string[], FlowShape | ((close: string) => FlowShape)][] = [
      ["((", ["))"], "circle"],
      ["([", ["])"], "stadium"],
      ["(", [")"], "round"],
      ["[(", [")]"], "cylinder"],
      ["[/", ["/]", "\\]"], (c) => (c === "/]" ? "parallelogram" : "trapezoid")],
      ["[", ["]"], "rect"],
      ["{{", ["}}"], "hexagon"],
      ["{", ["}"], "diamond"],
    ];
    for (const [open, closes, shape] of shapes) {
      if (!r.startsWith(open)) continue;
      this.pos += open.length;
      const { text, close } = this.readText(...closes);
      return { id, text, shape: typeof shape === "function" ? shape(close) : shape };
    }
    return { id };
  }

  private pipeLabel(): string {
    this.skipSpaces();
    if (this.s[this.pos] !== "|") return "";
    this.pos++;
    let text: string;
    if (this.s[this.pos] === '"') {
      const end = this.s.indexOf('"', this.pos + 1);
      if (end < 0) throw new Error("引号没有闭合");
      text = this.s.slice(this.pos + 1, end);
      this.pos = end + 1;
      if (this.s[this.pos] !== "|") throw new Error("连线文字缺少 |");
    } else {
      const end = this.s.indexOf("|", this.pos);
      if (end < 0) throw new Error("连线文字缺少 |");
      text = this.s.slice(this.pos, end);
      this.pos = end;
    }
    this.pos++;
    return decodeEntities(text.trim());
  }

  /** 读一条连线，没有更多连线时返回 null */
  edge(): { style: FlowEdgeStyle; label: string } | null {
    this.skipSpaces();
    const r = this.rest();
    if (!r) return null;
    if (r.startsWith("&")) throw new Unsupported("多个节点同时连线（&）");
    const inline: [RegExp, FlowEdgeStyle][] = [
      [/^--(?![->])\s*(.*?)\s*-->/, "arrow"],
      [/^--(?![->])\s*(.*?)\s*---(?![->])/, "line"],
      [/^-\.(?!-)\s*(.*?)\s*\.->/, "dotted"],
      [/^==(?![=>])\s*(.*?)\s*==>/, "thick"],
    ];
    for (const [re, style] of inline) {
      const m = re.exec(r);
      if (m && m[1]) {
        this.pos += m[0].length;
        this.after();
        return { style, label: decodeEntities(m[1].replace(/^"(.*)"$/, "$1").trim()) };
      }
    }
    const plain: [RegExp, FlowEdgeStyle][] = [
      [/^-->/, "arrow"],
      [/^---(?![->])/, "line"],
      [/^-\.->/, "dotted"],
      [/^==>/, "thick"],
    ];
    for (const [re, style] of plain) {
      const m = re.exec(r);
      if (m) {
        this.pos += m[0].length;
        this.after();
        return { style, label: this.pipeLabel() };
      }
    }
    if (/^(<|--|==|-\.|~~~)/.test(r)) throw new Unsupported("连线写法（箭头样式或长度）");
    throw new Error("无法识别");
  }

  /** 连线后面紧跟的符号说明是更长的连线或其他箭头，不支持 */
  private after() {
    if (/^[-=.>ox]/.test(this.rest()) && !/^[ox][\p{L}\p{N}_]/u.test(this.rest())) {
      throw new Unsupported("连线写法（箭头样式或长度）");
    }
  }

  done(): boolean {
    this.skipSpaces();
    return this.pos >= this.s.length;
  }
}

export function parseFlow(text: string): ParseResult<FlowDoc> {
  const lines = linesOf(text);
  if (lines.every((l) => !l.trim())) return { ok: true, doc: emptyFlow() };
  const issues: DiagramIssue[] = [];
  const doc = emptyFlow();
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (isComment(t)) doc.head.push(t);
    else break;
  }
  const header = /^(flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*;?$/i.exec(lines[i]?.trim() ?? "");
  if (!header) {
    return { ok: false, issues: [{ line: Math.min(i, lines.length - 1) + 1, message: "无法识别：流程图应以 flowchart 开头" }] };
  }
  const dir = (header[2] ?? "TD").toUpperCase();
  doc.dir = dir === "TB" ? "TD" : (dir as FlowDir);

  const byId = new Map<string, FlowNode>();
  let pending: string[] = [];
  /** 下一条语句的扩展注释：节点的样式、位置、文字标记给第一个节点，走线给第一条连线 */
  let pendingSpark = null as Omit<SparkInfo, "canvas"> | null;
  let first = true;
  const touch = (ref: NodeRef): boolean => {
    let node = byId.get(ref.id);
    const created = !node;
    if (!node) {
      node = { id: ref.id, text: ref.id, shape: "rect", comments: [] };
      byId.set(ref.id, node);
      doc.nodes.push(node);
    }
    if (ref.text !== undefined) node.text = ref.text;
    if (ref.shape) node.shape = ref.shape;
    return created;
  };

  for (i++; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (isSparkLine(t)) {
      const info = parseSpark(t);
      if (first) {
        const { scheme, spacing } = info.canvas;
        doc.canvas = { ...(scheme ? { scheme } : {}), ...(spacing ? { spacing } : {}) };
      }
      const prev = pendingSpark;
      pendingSpark = {
        style: { ...prev?.style, ...info.style },
        pos: info.pos ?? prev?.pos,
        text: info.text || prev?.text,
        route: info.route ?? prev?.route,
        size: info.size ?? prev?.size,
        out: info.out ?? prev?.out,
        in: info.in ?? prev?.in,
        via: info.via ?? prev?.via,
      };
      first = false;
      continue;
    }
    first = false;
    if (isComment(t)) {
      pending.push(t);
      continue;
    }
    for (const stmt of splitStatements(t)) {
      const kw = UNSUPPORTED_KEYWORDS.find(([re]) => re.test(stmt));
      if (kw) {
        issues.push({ line: i + 1, message: `用到了暂不支持的${kw[1]}` });
        continue;
      }
      if (stmt.includes(":::")) {
        issues.push({ line: i + 1, message: "用到了暂不支持的样式类（:::）" });
        continue;
      }
      try {
        const p = new StatementParser(stmt);
        const refs = [p.node()];
        const links: { style: FlowEdgeStyle; label: string }[] = [];
        for (let link = p.edge(); link; link = p.done() ? null : p.edge()) {
          links.push(link);
          refs.push(p.node());
        }
        if (!p.done()) throw new Error("无法识别");
        if (issues.length) continue;
        let anchor: { comments: string[] } | null = null;
        for (const ref of refs) {
          if (touch(ref) && !anchor) anchor = byId.get(ref.id)!;
        }
        const spark = pendingSpark;
        pendingSpark = null;
        if (spark) {
          const n = byId.get(refs[0].id)!;
          if (Object.keys(spark.style).length) n.style = spark.style;
          if (spark.pos) {
            n.x = spark.pos.x;
            n.y = spark.pos.y;
          }
          if (spark.text) n.isText = true;
          if (spark.size) {
            n.w = spark.size.w;
            n.h = spark.size.h;
          }
        }
        links.forEach((link, k) => {
          const edge: FlowEdge = { key: newEdgeKey(), from: refs[k].id, to: refs[k + 1].id, ...link, comments: [] };
          if (k === 0 && spark?.route) edge.route = spark.route;
          if (k === 0 && spark?.out) edge.fromSide = spark.out;
          if (k === 0 && spark?.in) edge.toSide = spark.in;
          if (k === 0 && spark?.via && edge.fromSide && edge.toSide) edge.bends = spark.via;
          doc.edges.push(edge);
          if (!anchor) anchor = edge;
        });
        if (anchor && pending.length) {
          (anchor as { comments: string[] }).comments.push(...pending);
          pending = [];
        }
      } catch (e) {
        issues.push({ line: i + 1, message: e instanceof Unsupported ? `用到了暂不支持的${e.message}` : "无法识别" });
      }
    }
  }
  if (issues.length) return { ok: false, issues };
  doc.tail = pending;
  return { ok: true, doc };
}

/* ---------- 写回 ---------- */

const RESERVED = /^(end|graph|flowchart|subgraph|style|class|classDef|click|linkStyle|direction)$/i;

function quoteIfNeeded(text: string): string {
  if (text && !/["()[\]{}<>|;#&%`\\\n]/.test(text) && text === text.trim() && !RESERVED.test(text)) return text;
  return quoteText(text || " ");
}

const WRAP: Record<FlowShape, [string, string]> = {
  rect: ["[", "]"], round: ["(", ")"], stadium: ["([", "])"], circle: ["((", "))"], diamond: ["{", "}"],
  hexagon: ["{{", "}}"], parallelogram: ["[/", "/]"], trapezoid: ["[/", "\\]"], cylinder: ["[(", ")]"],
};

function nodeDef(n: FlowNode, id: string): string {
  if (n.shape === "rect" && n.text === id) return id;
  const [open, close] = WRAP[n.shape];
  const text = n.text;
  const slashed = (n.shape === "parallelogram" || n.shape === "trapezoid") && /[/\\]/.test(text);
  return `${id}${open}${slashed ? quoteText(text) : quoteIfNeeded(text)}${close}`;
}

/**
 * 写出的节点编号：小写的 `end` 是 Mermaid 的关键字，其他 Mermaid 工具读到会出错，
 * 写成 `end_`（已被占用时继续加下划线）。其余编号原样写出。
 */
function writtenIds(doc: FlowDoc): (id: string) => string {
  const used = new Set(doc.nodes.map((n) => n.id));
  const renamed = new Map<string, string>();
  for (const n of doc.nodes) {
    if (n.id !== "end" || renamed.has(n.id)) continue;
    let next = "end_";
    while (used.has(next)) next += "_";
    used.add(next);
    renamed.set(n.id, next);
  }
  return (id) => renamed.get(id) ?? id;
}

function labelOf(label: string): string {
  const t = label.replace(/\s*\n\s*/g, " ").trim();
  if (!t) return "";
  return /[|"]/.test(t) ? `|"${t.replace(/"/g, "#quot;")}"|` : `|${t}|`;
}

export function serializeFlow(doc: FlowDoc): string {
  const out = [...doc.head, `flowchart ${doc.dir}`];
  const canvas = formatCanvas({ scheme: doc.canvas.scheme, spacing: doc.canvas.spacing });
  if (canvas) out.push("  " + canvas);
  const linked = new Set(doc.edges.flatMap((e) => [e.from, e.to]));
  const idOf = writtenIds(doc);
  for (const n of doc.nodes) {
    const pos = n.x !== undefined && n.y !== undefined ? { x: n.x, y: n.y } : undefined;
    const size = n.w && n.h ? { w: n.w, h: n.h } : undefined;
    const spark = formatNode(n.style, { pos, size, text: n.isText });
    if (n.shape === "rect" && n.text === idOf(n.id) && linked.has(n.id) && !n.comments.length && !spark) continue;
    for (const c of n.comments) out.push("  " + c);
    if (spark) out.push("  " + spark);
    out.push("  " + nodeDef(n, idOf(n.id)));
  }
  for (const e of doc.edges) {
    for (const c of e.comments) out.push("  " + c);
    const spark = formatEdge(e.route, e.fromSide, e.toSide, e.bends);
    if (spark) out.push("  " + spark);
    out.push(`  ${idOf(e.from)} ${ARROW[e.style]}${labelOf(e.label)} ${idOf(e.to)}`);
  }
  for (const c of doc.tail) out.push("  " + c);
  return out.join("\n") + "\n";
}

/* ---------- 编辑操作 ---------- */

export function findFlowNode(doc: FlowDoc, id: string): FlowNode | undefined {
  return doc.nodes.find((n) => n.id === id);
}

function nextId(doc: FlowDoc): string {
  let max = 0;
  for (const n of doc.nodes) {
    const m = /^n(\d+)$/.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `n${max + 1}`;
}

export function addFlowNode(doc: FlowDoc, shape: FlowShape, text: string, at?: { x: number; y: number }, isText = false): string {
  const node: FlowNode = { id: nextId(doc), text, shape, comments: [] };
  if (at) {
    node.x = Math.round(at.x);
    node.y = Math.round(at.y);
  }
  if (isText) node.isText = true;
  doc.nodes.push(node);
  return node.id;
}

export function removeFlowNode(doc: FlowDoc, id: string) {
  doc.nodes = doc.nodes.filter((n) => n.id !== id);
  doc.edges = doc.edges.filter((e) => e.from !== id && e.to !== id);
}

export function addFlowEdge(
  doc: FlowDoc, from: string, to: string, style: FlowEdgeStyle, route?: EdgeRoute, sides: { from?: Side; to?: Side } = {},
): string | null {
  if (!findFlowNode(doc, from) || !findFlowNode(doc, to)) return null;
  const edge: FlowEdge = { key: newEdgeKey(), from, to, style, label: "", comments: [] };
  if (route && route !== "elbow") edge.route = route;
  if (sides.from) edge.fromSide = sides.from;
  if (sides.to) edge.toSide = sides.to;
  doc.edges.push(edge);
  return edge.key;
}

export function removeFlowEdge(doc: FlowDoc, key: string) {
  doc.edges = doc.edges.filter((e) => e.key !== key);
}

/** 把连线的一端改接到另一个节点，side 为松开时靠近的那一边 */
export function reconnectEdge(doc: FlowDoc, key: string, end: "from" | "to", nodeId: string, side?: Side): boolean {
  const edge = doc.edges.find((e) => e.key === key);
  if (!edge || !findFlowNode(doc, nodeId)) return false;
  edge[end] = nodeId;
  const prop = end === "from" ? "fromSide" : "toSide";
  if (side) edge[prop] = side;
  else delete edge[prop];
  delete edge.bends;
  return true;
}

/** 两端节点一起移动时，手动拖过的中间段跟着平移：首段横着时第 1、3… 段是竖段，平移 x */
export function shiftBends(bends: number[], fromSide: Side, dx: number, dy: number): number[] {
  const firstH = fromSide === "left" || fromSide === "right";
  return bends.map((c, i) => Math.round(c + ((i % 2 === 0) === firstH ? dx : dy)));
}

/** 复制的一组节点和它们之间的连线 */
export interface FlowFragment {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export function copyFragment(doc: FlowDoc, ids: string[]): FlowFragment {
  const set = new Set(ids);
  return structuredClone({
    nodes: doc.nodes.filter((n) => set.has(n.id)).map((n) => ({ ...n, comments: [] })),
    edges: doc.edges.filter((e) => set.has(e.from) && set.has(e.to)).map((e) => ({ ...e, comments: [] })),
  });
}

/** 粘贴：换上新编号，整体平移使左上角的节点中心落在 at（不给 at 时按 offset 平移），返回新节点的编号 */
export function pasteFragment(doc: FlowDoc, frag: FlowFragment, place: { at?: { x: number; y: number }; offset?: number }): string[] {
  if (!frag.nodes.length) return [];
  const xs = frag.nodes.map((n) => n.x ?? 0);
  const ys = frag.nodes.map((n) => n.y ?? 0);
  const dx = place.at ? place.at.x - Math.min(...xs) : place.offset ?? 0;
  const dy = place.at ? place.at.y - Math.min(...ys) : place.offset ?? 0;
  const ids = new Map<string, string>();
  for (const n of frag.nodes) {
    const id = nextId(doc);
    ids.set(n.id, id);
    doc.nodes.push({ ...structuredClone(n), id, x: Math.round((n.x ?? 0) + dx), y: Math.round((n.y ?? 0) + dy) });
  }
  for (const e of frag.edges) {
    const edge: FlowEdge = { ...structuredClone(e), key: newEdgeKey(), from: ids.get(e.from)!, to: ids.get(e.to)! };
    if (edge.bends && edge.fromSide) edge.bends = shiftBends(edge.bends, edge.fromSide, dx, dy);
    doc.edges.push(edge);
  }
  return [...ids.values()];
}

/** 每个节点一行，用于系统剪贴板 */
export function fragmentToText(frag: FlowFragment): string {
  return frag.nodes.map((n) => n.text.replace(/\n/g, " ")).join("\n");
}

/** 从其他软件复制的多行文字：每行一个矩形节点，从上往下排开，不连线 */
export function textToFragment(text: string, gap = 70): FlowFragment {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim().replace(/^([-*+•]|\d+[.)、])\s+/, "")).filter(Boolean);
  return {
    nodes: lines.map((t, i) => ({ id: `p${i}`, text: t, shape: "rect" as const, comments: [], x: 0, y: i * gap })),
    edges: [],
  };
}

/** 所有节点都有位置 */
export function hasPositions(doc: FlowDoc): boolean {
  return doc.nodes.every((n) => n.x !== undefined && n.y !== undefined);
}
