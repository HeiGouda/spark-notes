import { countMind, type MindNode } from "./mindmap";
import type { MindLine, MindLook, MindStructure, NodeStyle, Spacing } from "./spark";
import { SIZE_SCALE, SPACING_SCALE } from "./colors";
import { polylinePath } from "./flowLayout";
import { textWidth, wrapText } from "./measure";

/**
 * 思维导图排版（需求文档 5.18）。向右、向左、左右平衡、向下共用一套树形排版：
 * 同一个父节点的子节点排成一列，整体在父节点外侧居中；概要节点放在它概括的那段子树外侧，
 * 概要节点比那段子树高时，在这段前后留出空白。鱼骨图单独排版，不显示概要。
 */

/** 子节点从这个节点往哪边长；鱼骨图的一级主题为 fish */
export type GrowDir = "right" | "left" | "down" | "fish";

export interface MindBox {
  id: string;
  parent: string | null;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  size: number;
  weight: number;
  lineH: number;
  padX: number;
  padY: number;
  /** 折叠时隐藏的子孙数量 */
  hidden: number;
  summary: boolean;
  /** 所在一级分支的序号，根节点为 -1 */
  branch: number;
  dir: GrowDir;
  /** 同级节点的排列方向：v 上下排，h 左右排 */
  sib: "v" | "h";
  /** 画成方框（方框外观下的根节点、一级主题、概要节点，以及设了背景或边框的节点） */
  boxed: boolean;
  /** 文字下面画下划线，连线接在下划线的端点；否则连线接在节点左右两端的中间 */
  underline: boolean;
}

export interface MindLink {
  from: string;
  to: string;
  d: string;
}

export interface MindLayout {
  boxes: Map<string, MindBox>;
  /** 可见节点的先序顺序 */
  order: string[];
  links: MindLink[];
  /** 概要的括号，id 为概要节点 */
  brackets: { id: string; d: string }[];
  /** 鱼骨图的主骨 */
  spine: string | null;
  width: number;
  height: number;
}

export interface MindLayoutOptions {
  structure?: MindStructure;
  look?: MindLook;
  line?: MindLine;
  spacing?: Spacing;
  /** 节点样式，按节点 id */
  styles?: Map<string, NodeStyle>;
}

const MAX_TEXT = 260;
const BRACKET = 16;
/** 鱼骨与主骨成 60 度：每往外一个单位，往左偏 tan30° */
const FISH_SLANT = Math.tan(Math.PI / 6);

/**
 * 节点的字号、粗细、内边距和画法。纯文字外观下只有设了背景或边框的节点画框，其余只显示文字；
 * 鱼骨图的小骨（二级及以下）始终带下划线。
 */
export function nodeStyle(depth: number, summary = false, style?: NodeStyle, look: MindLook = "box", fishRib = false) {
  const base = depth === 0
    ? { size: 16, weight: 700, padX: 18, padY: 11 }
    : depth === 1 || summary ? { size: 14, weight: 600, padX: 14, padY: 8 } : { size: 13, weight: 400, padX: 6, padY: 6 };
  const k = SIZE_SCALE[style?.size ?? "m"];
  const painted = !!(style?.bg || style?.border);
  const boxed = painted || (look === "box" && (depth <= 1 || summary));
  const underline = !boxed && (look === "box" || fishRib);
  const padX = boxed ? (depth >= 2 && !summary ? 10 : base.padX) : underline ? base.padX : 4;
  return {
    size: Math.round(base.size * k),
    weight: style?.bold === undefined ? base.weight : style.bold ? 700 : 400,
    padX: Math.round(padX * k),
    padY: Math.round(base.padY * k),
    boxed,
    underline,
  };
}

interface Pt { x: number; y: number }

/**
 * 父节点到子节点的连线。axis 为 h 时从左右两边连（向右、向左、左右平衡），为 v 时从上往下连（向下）。
 * 同一父节点的子节点排在同一列，折点都落在两端的中间，看起来是一根主干分出去。
 */
export function linkPath(a: Pt, b: Pt, axis: "h" | "v", line: MindLine): string {
  const P = (main: number, cross: number): Pt => (axis === "h" ? { x: main, y: cross } : { x: cross, y: main });
  const m1 = axis === "h" ? a.x : a.y;
  const c1 = axis === "h" ? a.y : a.x;
  const m2 = axis === "h" ? b.x : b.y;
  const c2 = axis === "h" ? b.y : b.x;
  const at = (t: number) => m1 + (m2 - m1) * t;
  switch (line) {
    case "round":
    case "elbow":
      return polylinePath([a, P(at(0.5), c1), P(at(0.5), c2), b], line === "round");
    case "fork":
      return polylinePath([a, P(at(0.35), c1), P(at(0.65), c2), b], false);
    case "straight":
      return polylinePath([a, b], false);
    case "slant":
      return polylinePath([a, P(at(0.5), c2), b], false);
    default: {
      const q1 = P(at(0.5), c1);
      const q2 = P(at(0.5), c2);
      return `M${a.x} ${a.y}C${q1.x} ${q1.y} ${q2.x} ${q2.y} ${b.x} ${b.y}`;
    }
  }
}
interface LinkSpec { from: string; to: string; kind: "curve" | "elbow" | "line"; sign: number; a?: Pt; b?: Pt }
interface BracketSpec { id: string; sign: number; far: number; lo: number; hi: number; mid: number }
interface Col {
  kids: MindNode[];
  ks: number[];
  before: number[];
  after: number[];
  sums: { i: number; j: number; node: MindNode }[];
  size: number;
  gap: number;
}

export function layoutMind(root: MindNode, collapsed: Set<string>, opts: MindLayoutOptions = {}): MindLayout {
  const structure = opts.structure ?? "right";
  const line = opts.line ?? "curve";
  const k = SPACING_SCALE[opts.spacing ?? "standard"];
  const fish = structure === "fishbone";
  const axis: "h" | "v" = structure === "down" ? "v" : "h";
  const MAIN_GAP = Math.round((axis === "v" ? 40 : 44) * k);
  const sibGap = (depth: number) => Math.round((axis === "v" ? (depth <= 1 ? 24 : 14) : depth <= 1 ? 16 : 8) * k);

  const boxes = new Map<string, MindBox>();
  const order: string[] = [];
  const specs: LinkSpec[] = [];
  const bracketSpecs: BracketSpec[] = [];
  const open = (n: MindNode) => !collapsed.has(n.id);
  const sumsShown = (n: MindNode) => (!fish && open(n) ? n.summaries ?? [] : []);

  /* ---------- 量尺寸 ---------- */
  const visit = (n: MindNode, depth: number, parent: string | null, summary: boolean, branch: number) => {
    const st = nodeStyle(depth, summary, opts.styles?.get(n.id), opts.look, fish && depth >= 2);
    const lineH = Math.round(st.size * 1.5);
    const lines = wrapText(n.text || " ", st.size, MAX_TEXT, st.weight);
    const textW = Math.max(...lines.map((l) => textWidth(l, st.size, st.weight)), st.size * 2);
    boxes.set(n.id, {
      id: n.id, parent, depth, x: 0, y: 0,
      w: Math.ceil(textW + st.padX * 2), h: lines.length * lineH + st.padY * 2,
      lines, size: st.size, weight: st.weight, lineH, padX: st.padX, padY: st.padY,
      hidden: open(n) ? 0 : countMind(n) - 1,
      summary, branch, dir: "right", sib: "v", boxed: st.boxed, underline: st.underline,
    });
    order.push(n.id);
    if (!open(n)) return;
    n.children.forEach((c, i) => visit(c, depth + 1, n.id, false, depth === 0 ? i : branch));
    for (const s of sumsShown(n)) {
      const at = n.children.findIndex((c) => c.id === s.from);
      visit(s.node, depth + 1, n.id, true, depth === 0 ? at : branch);
    }
  };
  visit(root, 0, null, false, -1);

  const crossOf = (b: MindBox) => (axis === "h" ? b.h : b.w);
  const mainOf = (b: MindBox) => (axis === "h" ? b.w : b.h);
  const setPos = (b: MindBox, main: number, cross: number) => {
    if (axis === "h") {
      b.x = main;
      b.y = cross;
    } else {
      b.x = cross;
      b.y = main;
    }
  };

  /* ---------- 每个子树在交叉方向上占多宽 ---------- */
  const ext = new Map<string, number>();
  const cols = new Map<string, Col>();

  const sumsIn = (n: MindNode, kids: MindNode[]) => {
    const out: Col["sums"] = [];
    for (const s of sumsShown(n)) {
      let i = kids.findIndex((c) => c.id === s.from);
      let j = kids.findIndex((c) => c.id === s.to);
      if (i < 0 && j < 0) continue;
      // 左右平衡时范围跨两侧：只在 from 所在的一侧显示
      if (i < 0) continue;
      if (j < 0) j = kids.length - 1;
      if (i > j) [i, j] = [j, i];
      out.push({ i, j, node: s.node });
    }
    return out;
  };

  const makeCol = (kids: MindNode[], sums: Col["sums"], depth: number): Col => {
    const gap = sibGap(depth + 1);
    const ks = kids.map((c) => extent(c));
    const before = kids.map(() => 0);
    const after = kids.map(() => 0);
    for (const s of sums) {
      const se = extent(s.node);
      let span = 0;
      for (let x = s.i; x <= s.j; x++) span += ks[x] + (x > s.i ? gap + before[x] : 0) + (x < s.j ? after[x] : 0);
      if (se > span) {
        before[s.i] += (se - span) / 2;
        after[s.j] += (se - span) / 2;
      }
    }
    const sum = (a: number[]) => a.reduce((p, q) => p + q, 0);
    const size = sum(ks) + gap * Math.max(0, kids.length - 1) + sum(before) + sum(after);
    return { kids, ks, before, after, sums, size, gap };
  };

  function extent(n: MindNode): number {
    const hit = ext.get(n.id);
    if (hit !== undefined) return hit;
    const b = boxes.get(n.id)!;
    let e = crossOf(b);
    if (open(n) && n.children.length) {
      const col = makeCol(n.children, sumsIn(n, n.children), b.depth);
      cols.set(n.id, col);
      e = Math.max(e, col.size);
    }
    ext.set(n.id, e);
    return e;
  }

  /* ---------- 放置 ---------- */
  const eachVisible = (n: MindNode, fn: (b: MindBox) => void) => {
    fn(boxes.get(n.id)!);
    if (!open(n)) return;
    n.children.forEach((c) => eachVisible(c, fn));
    sumsShown(n).forEach((s) => eachVisible(s.node, fn));
  };

  /** near：靠父节点一侧的主轴坐标；start：在交叉方向上分到的起点 */
  function place(n: MindNode, near: number, start: number, sign: number, dir: GrowDir) {
    const b = boxes.get(n.id)!;
    const e = extent(n);
    const mainStart = sign > 0 ? near : near - mainOf(b);
    setPos(b, mainStart, start + (e - crossOf(b)) / 2);
    b.dir = dir;
    b.sib = axis === "h" ? "v" : "h";
    const col = cols.get(n.id);
    if (col) placeCol(n, col, sign > 0 ? mainStart + mainOf(b) + MAIN_GAP : mainStart - MAIN_GAP, start + (e - col.size) / 2, sign, dir);
  }

  function placeCol(parent: MindNode, col: Col, near: number, start: number, sign: number, dir: GrowDir) {
    let c = start;
    const bands: [number, number][] = [];
    col.kids.forEach((kid, i) => {
      const s0 = c;
      c += col.before[i];
      specs.push({ from: parent.id, to: kid.id, kind: axis === "v" ? "elbow" : "curve", sign });
      place(kid, near, c, sign, dir);
      c += col.ks[i] + col.after[i];
      bands.push([s0, c]);
      c += col.gap;
    });
    for (const s of col.sums) {
      let lo = Infinity;
      let hi = -Infinity;
      let far = sign > 0 ? -Infinity : Infinity;
      for (let x = s.i; x <= s.j; x++) {
        eachVisible(col.kids[x], (b) => {
          const cs = axis === "h" ? b.y : b.x;
          const ms = axis === "h" ? b.x : b.y;
          lo = Math.min(lo, cs);
          hi = Math.max(hi, cs + crossOf(b));
          far = sign > 0 ? Math.max(far, ms + mainOf(b)) : Math.min(far, ms);
        });
      }
      const mid = (bands[s.i][0] + bands[s.j][1]) / 2;
      bracketSpecs.push({ id: s.node.id, sign, far, lo, hi, mid });
      place(s.node, far + sign * (BRACKET + 8), mid - extent(s.node) / 2, sign, dir);
    }
  }

  const rootBox = boxes.get(root.id)!;
  let spine: { x1: number; x2: number } | null = null;

  if (fish) {
    rootBox.dir = "fish";
    rootBox.sib = "h";
    rootBox.x = 0;
    rootBox.y = -rootBox.h / 2;
    if (open(root) && root.children.length) spine = layoutFish();
  } else if (structure === "balanced") {
    rootBox.dir = "right";
    rootBox.x = 0;
    rootBox.y = -rootBox.h / 2;
    if (open(root)) {
      const half = Math.ceil(root.children.length / 2);
      const right = root.children.slice(0, half);
      const left = root.children.slice(half);
      const colR = makeCol(right, sumsIn(root, right), 0);
      const colL = makeCol(left, sumsIn(root, left), 0);
      placeCol(root, colR, rootBox.w + MAIN_GAP, -colR.size / 2, 1, "right");
      placeCol(root, colL, -MAIN_GAP, -colL.size / 2, -1, "left");
    }
  } else {
    const sign = structure === "left" ? -1 : 1;
    const dir: GrowDir = structure === "left" ? "left" : structure === "down" ? "down" : "right";
    rootBox.dir = dir;
    rootBox.sib = axis === "h" ? "v" : "h";
    setPos(rootBox, sign > 0 ? 0 : -mainOf(rootBox), -crossOf(rootBox) / 2);
    if (open(root) && root.children.length) {
      const col = makeCol(root.children, sumsIn(root, root.children), 0);
      const near = sign > 0 ? mainOf(rootBox) + MAIN_GAP : -mainOf(rootBox) - MAIN_GAP;
      placeCol(root, col, near, -col.size / 2, sign, dir);
    }
  }

  /**
   * 鱼骨图：鱼头（根节点）在右，一级主题是斜着的大骨，上下交替、从右往左排；
   * 二级主题是贴在大骨上的水平小骨，更深的层级从小骨往左展开。
   */
  function layoutFish(): { x1: number; x2: number } {
    const margin = Math.round(18 * k);
    const gap2 = sibGap(2);
    const step = Math.round(40 * k);
    const limit: Record<number, number> = { [-1]: -MAIN_GAP, [1]: -MAIN_GAP };
    let prevSx = Infinity;
    let tail = 0;
    root.children.forEach((kid, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      const kb = boxes.get(kid.id)!;
      kb.dir = "fish";
      kb.sib = "h";
      const subs = open(kid) ? kid.children : [];
      const exts = subs.map((c) => extent(c));
      const L = Math.max(Math.round(48 * k), margin * 2 + exts.reduce((a, b) => a + b, 0) + gap2 * Math.max(0, subs.length - 1));
      const endX = -L * FISH_SLANT;
      const endY = side * L;
      kb.x = endX - kb.w / 2;
      kb.y = side < 0 ? endY - kb.h : endY;
      const ribs: LinkSpec[] = [];
      let d = L - margin;
      subs.forEach((c, j) => {
        const e = exts[j];
        const bandTop = side < 0 ? -d : d - e;
        const cb = boxes.get(c.id)!;
        const bottom = bandTop + (e - cb.h) / 2 + cb.h;
        const boneX = -Math.abs(bottom) * FISH_SLANT;
        place(c, boneX - 3, bandTop, -1, "left");
        ribs.push({ from: kid.id, to: c.id, kind: "line", sign: -1, a: { x: boneX - 3, y: bottom }, b: { x: boneX, y: bottom } });
        d -= e + gap2;
      });
      let minX = kb.x;
      let maxX = Math.max(0, kb.x + kb.w);
      subs.forEach((c) => eachVisible(c, (b) => {
        minX = Math.min(minX, b.x);
        maxX = Math.max(maxX, b.x + b.w);
      }));
      const sx = Math.min(limit[side] - maxX, prevSx - step);
      kb.x += sx;
      subs.forEach((c) => eachVisible(c, (b) => void (b.x += sx)));
      for (const r of ribs) {
        r.a!.x += sx;
        r.b!.x += sx;
        specs.push(r);
      }
      specs.push({ from: root.id, to: kid.id, kind: "line", sign: -1, a: { x: sx, y: 0 }, b: { x: sx + endX, y: endY } });
      limit[side] = sx + minX - MAIN_GAP;
      prevSx = sx;
      tail = Math.min(tail, sx + endX);
    });
    return { x1: tail - margin * 2, x2: 0 };
  }

  /* ---------- 平移到从 (0, 0) 开始 ---------- */
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes.values()) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (spine) {
    minX = Math.min(minX, spine.x1);
    maxX = Math.max(maxX, spine.x2);
  }
  const dx = -minX;
  const dy = -minY;
  for (const b of boxes.values()) {
    b.x += dx;
    b.y += dy;
  }

  const links: MindLink[] = specs.map((s) => {
    const p = boxes.get(s.from)!;
    const c = boxes.get(s.to)!;
    if (s.a && s.b) return { from: s.from, to: s.to, d: `M${s.a.x + dx} ${s.a.y + dy}L${s.b.x + dx} ${s.b.y + dy}` };
    if (s.kind === "elbow") {
      const d = linkPath({ x: p.x + p.w / 2, y: p.y + p.h }, { x: c.x + c.w / 2, y: c.y }, "v", line);
      return { from: s.from, to: s.to, d };
    }
    const a = { x: s.sign > 0 ? p.x + p.w : p.x, y: p.underline ? p.y + p.h : p.y + p.h / 2 };
    const b = { x: s.sign > 0 ? c.x : c.x + c.w, y: c.underline ? c.y + c.h : c.y + c.h / 2 };
    return { from: s.from, to: s.to, d: linkPath(a, b, "h", line) };
  });

  const brackets = bracketSpecs.map((s) => {
    const P = (m: number, c: number) => (axis === "h" ? `${m + dx} ${c + dy}` : `${c + dx} ${m + dy}`);
    const m0 = s.far + s.sign * 4;
    const m1 = s.far + s.sign * 10;
    const tip = s.far + s.sign * BRACKET;
    const r = Math.min(6, (s.hi - s.lo) / 4);
    const mid = Math.min(Math.max(s.mid, s.lo + r), s.hi - r);
    const d =
      `M${P(m0, s.lo)}Q${P(m1, s.lo)} ${P(m1, s.lo + r)}L${P(m1, mid - r)}Q${P(m1, mid)} ${P(tip, mid)}` +
      `Q${P(m1, mid)} ${P(m1, mid + r)}L${P(m1, s.hi - r)}Q${P(m1, s.hi)} ${P(m0, s.hi)}` +
      `M${P(tip, mid)}L${P(tip + s.sign * 8, s.mid)}`;
    return { id: s.id, d };
  });

  return {
    boxes,
    order,
    links,
    brackets,
    spine: spine ? `M${spine.x1 + dx} ${dy}H${rootBox.x}` : null,
    width: maxX - minX,
    height: maxY - minY,
  };
}
