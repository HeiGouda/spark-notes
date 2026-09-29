import type { FlowDir, FlowDoc, FlowNode, FlowShape } from "./flowchart";
import type { EdgeRoute, NodeStyle, Side } from "./spark";
import { SIZE_SCALE, SPACING_SCALE } from "./colors";
import { textWidth, wrapText } from "./measure";

/**
 * 流程图的几何（需求文档 5.18）：节点按文件里的位置摆放，连线按走线样式连接两个节点相对的一边。
 * AI 整理与补位置用分层排版（自行实现，不依赖排版库）：
 * 1. 按定义顺序深度优先找出成环的连线，排版时反向处理；
 * 2. 最长路径分层；跨越多层的连线在中间层插入中转点；
 * 3. 同一层按定义顺序排列；
 * 4. 上下几轮让节点对齐到上下游的中位位置，再消除重叠。
 * 先按上到下计算，最后按方向转换坐标。
 */

interface Pt { x: number; y: number }

export interface FlowBox {
  id: string;
  shape: FlowShape;
  isText: boolean;
  /** 中心点 */
  cx: number;
  cy: number;
  w: number;
  h: number;
  lines: string[];
  lineH: number;
  size: number;
  weight: number;
}

export interface FlowRoute {
  key: string;
  points: Pt[];
  d: string;
  label: { x: number; y: number; w: number; h: number } | null;
}

export interface FlowGeometry {
  boxes: Map<string, FlowBox>;
  routes: FlowRoute[];
  minX: number;
  minY: number;
  width: number;
  height: number;
}

export const FLOW_FONT = 13;
export const GRID = 10;
const MAX_TEXT = 180;
const RANK_GAP = 56;
const NODE_GAP = 36;
const LABEL_FONT = 12;

export interface NodeMeasure {
  w: number;
  h: number;
  lines: string[];
  size: number;
  weight: number;
  lineH: number;
}

/** 图形尺寸 = 文字尺寸 × k + 内边距 */
const PAD: Record<FlowShape | "text", { kx: number; px: number; ky: number; py: number }> = {
  rect: { kx: 1, px: 32, ky: 1, py: 18 },
  round: { kx: 1, px: 32, ky: 1, py: 18 },
  stadium: { kx: 1, px: 44, ky: 1, py: 18 },
  circle: { kx: 1, px: 28, ky: 1, py: 28 },
  diamond: { kx: 1.4, px: 40, ky: 1.4, py: 30 },
  hexagon: { kx: 1, px: 48, ky: 1, py: 20 },
  parallelogram: { kx: 1, px: 52, ky: 1, py: 18 },
  trapezoid: { kx: 1, px: 52, ky: 1, py: 18 },
  cylinder: { kx: 1, px: 32, ky: 1, py: 34 },
  text: { kx: 1, px: 12, ky: 1, py: 8 },
};

export const MIN_W = 40;
export const MIN_H = 24;

/** 节点尺寸；fixed 为手动调整的大小时，文字在框内换行，框比文字矮时随文字变高 */
export function measureNode(text: string, shape: FlowShape, style?: NodeStyle, isText = false, fixed?: { w: number; h: number }): NodeMeasure {
  const size = Math.round(FLOW_FONT * SIZE_SCALE[style?.size ?? "m"]);
  const weight = style?.bold ? 700 : 400;
  const lineH = Math.round(size * 1.46);
  const p = PAD[isText ? "text" : shape];
  const maxW = fixed ? Math.max(size, (fixed.w - p.px) / p.kx) : MAX_TEXT * (size / FLOW_FONT);
  const lines = wrapText(text || " ", size, maxW, weight);
  const tw = Math.max(...lines.map((l) => textWidth(l, size, weight)), 20);
  const th = lines.length * lineH;
  let w = Math.ceil(tw * p.kx + p.px);
  let h = Math.ceil(th * p.ky + p.py);
  if (!isText && shape === "circle" && !fixed) w = h = Math.max(w, h);
  if (fixed) {
    w = Math.max(MIN_W, fixed.w);
    h = Math.max(MIN_H, fixed.h, h);
  }
  return { lines, size, weight, lineH, w, h };
}

/** 平行四边形、梯形的斜边在水平方向上占多宽 */
function skewOf(w: number, h: number): number {
  return Math.min(h * 0.5, w * 0.2);
}

/** 以中心为原点的图形轮廓 */
export function shapePath(shape: FlowShape, w: number, h: number): string {
  const hw = w / 2;
  const hh = h / 2;
  switch (shape) {
    case "round": {
      const r = Math.min(hh, 10);
      return roundRect(hw, hh, r);
    }
    case "stadium":
      return roundRect(hw, hh, hh);
    case "circle":
      return `M${-hw} 0A${hw} ${hh} 0 1 0 ${hw} 0A${hw} ${hh} 0 1 0 ${-hw} 0Z`;
    case "diamond":
      return `M0 ${-hh}L${hw} 0L0 ${hh}L${-hw} 0Z`;
    case "hexagon": {
      const k = Math.min(hh, w / 4);
      return `M${-hw + k} ${-hh}H${hw - k}L${hw} 0L${hw - k} ${hh}H${-hw + k}L${-hw} 0Z`;
    }
    case "parallelogram": {
      const s = skewOf(w, h);
      return `M${-hw + s} ${-hh}H${hw}L${hw - s} ${hh}H${-hw}Z`;
    }
    case "trapezoid": {
      const s = skewOf(w, h);
      return `M${-hw + s} ${-hh}H${hw - s}L${hw} ${hh}H${-hw}Z`;
    }
    case "cylinder": {
      const ry = cylinderRy(h);
      return `M${-hw} ${-hh + ry}A${hw} ${ry} 0 0 1 ${hw} ${-hh + ry}V${hh - ry}A${hw} ${ry} 0 0 1 ${-hw} ${hh - ry}Z` +
        `M${-hw} ${-hh + ry}A${hw} ${ry} 0 0 0 ${hw} ${-hh + ry}`;
    }
    default:
      return roundRect(hw, hh, 3);
  }
}

export function cylinderRy(h: number): number {
  return Math.min(8, h / 6);
}

function roundRect(hw: number, hh: number, r: number): string {
  return `M${-hw + r} ${-hh}H${hw - r}A${r} ${r} 0 0 1 ${hw} ${-hh + r}V${hh - r}A${r} ${r} 0 0 1 ${hw - r} ${hh}` +
    `H${-hw + r}A${r} ${r} 0 0 1 ${-hw} ${hh - r}V${-hh + r}A${r} ${r} 0 0 1 ${-hw + r} ${-hh}Z`;
}

/* ---------- 按位置摆放与连线 ---------- */

/** 两个节点相对的两边：水平方向的空隙比垂直方向大时走左右，否则走上下 */
export function facing(a: FlowBox, b: FlowBox): [Side, Side] {
  const gx = Math.max(b.cx - b.w / 2 - (a.cx + a.w / 2), a.cx - a.w / 2 - (b.cx + b.w / 2));
  const gy = Math.max(b.cy - b.h / 2 - (a.cy + a.h / 2), a.cy - a.h / 2 - (b.cy + b.h / 2));
  if (gx >= gy) return b.cx >= a.cx ? ["right", "left"] : ["left", "right"];
  return b.cy >= a.cy ? ["bottom", "top"] : ["top", "bottom"];
}

function anchor(b: FlowBox, side: Side): Pt {
  const inset = !b.isText && (b.shape === "parallelogram" || b.shape === "trapezoid") ? skewOf(b.w, b.h) / 2 : 0;
  switch (side) {
    case "top": return { x: b.cx, y: b.cy - b.h / 2 };
    case "bottom": return { x: b.cx, y: b.cy + b.h / 2 };
    case "left": return { x: b.cx - b.w / 2 + inset, y: b.cy };
    default: return { x: b.cx + b.w / 2 - inset, y: b.cy };
  }
}

/** 从节点中心朝 toward 方向，与节点边框的交点 */
export function clip(b: { cx: number; cy: number; w: number; h: number; shape: FlowShape }, toward: Pt): Pt {
  const dx = toward.x - b.cx;
  const dy = toward.y - b.cy;
  if (!dx && !dy) return { x: b.cx, y: b.cy };
  const hw = b.w / 2;
  const hh = b.h / 2;
  let t: number;
  if (b.shape === "circle") {
    t = 1 / Math.hypot(dx / hw, dy / hh);
  } else if (b.shape === "diamond") {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else {
    t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  }
  return { x: b.cx + dx * t, y: b.cy + dy * t };
}

/** 在节点的某一边上、偏离中线 offset 处的边框点；菱形和圆按实际轮廓 */
function edgePoint(b: FlowBox, side: Side, offset: number): Pt {
  const vertical = side === "top" || side === "bottom";
  const half = vertical ? b.h / 2 : b.w / 2;
  const span = vertical ? b.w / 2 : b.h / 2;
  let depth = half;
  if (!b.isText && b.shape === "diamond") depth = half * (1 - Math.abs(offset) / span);
  else if (!b.isText && b.shape === "circle") depth = half * Math.sqrt(Math.max(0, 1 - (offset / span) ** 2));
  const sign = side === "top" || side === "left" ? -1 : 1;
  return vertical ? { x: b.cx + offset, y: b.cy + sign * depth } : { x: b.cx + sign * depth, y: b.cy + offset };
}

/** 连线可以接在这条边上的范围（相对中线）：菱形和圆只用中间一段，免得接到尖角上 */
function edgeSpan(b: FlowBox, vertical: boolean): number {
  const span = vertical ? b.w / 2 : b.h / 2;
  return !b.isText && (b.shape === "diamond" || b.shape === "circle") ? span * 0.6 : span - 4;
}

const NORMAL: Record<Side, [number, number]> = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
/** 固定接边时，从边上先直着伸出去这么长再拐弯 */
const STUB = 20;

/** 离点 p 最近的那一边 */
export function sideNear(b: FlowBox, p: Pt): Side {
  const dx = (p.x - b.cx) / (b.w / 2 || 1);
  const dy = (p.y - b.cy) / (b.h / 2 || 1);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

export function opposite(side: Side): Side {
  return ({ top: "bottom", bottom: "top", left: "right", right: "left" } as const)[side];
}

/** 去掉重复的点和三点一线中间的点 */
function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((Math.abs(prev.x - last.x) < 0.5 && Math.abs(last.x - p.x) < 0.5) || (Math.abs(prev.y - last.y) < 0.5 && Math.abs(last.y - p.y) < 0.5))) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/** 横竖线段是否穿过节点内部（贴着边框走不算） */
function crosses(p: Pt, q: Pt, b: FlowBox): boolean {
  const l = b.cx - b.w / 2 + 1;
  const r = b.cx + b.w / 2 - 1;
  const t = b.cy - b.h / 2 + 1;
  const btm = b.cy + b.h / 2 - 1;
  return Math.max(p.x, q.x) > l && Math.min(p.x, q.x) < r && Math.max(p.y, q.y) > t && Math.min(p.y, q.y) < btm;
}

/** 折线的代价：往回折、穿过节点都算很大的代价，其余按长度和拐弯数 */
function routeCost(points: Pt[], boxes: FlowBox[]): number {
  let cost = 0;
  let prev: [number, number] | null = null;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    const dx = Math.sign(Math.round(q.x - p.x));
    const dy = Math.sign(Math.round(q.y - p.y));
    if (!dx && !dy) continue;
    cost += Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
    if (prev && prev[0] === -dx && prev[1] === -dy) cost += 1e5;
    else if (prev && (prev[0] !== dx || prev[1] !== dy)) cost += 30;
    prev = [dx, dy];
    for (const b of boxes) if (crosses(p, q, b)) cost += 1e4;
  }
  return cost;
}

/**
 * 两端接边已定时的横竖折线：各自沿边的法线伸出一小段，再从几种连法里挑不回折、不穿节点、最短的。
 * 给出 obstacles 时同时避开这些节点，并试着从它们外侧绕过去。
 */
function orthoRoute(a: FlowBox, b: FlowBox, sa: Side, sb: Side, obstacles: FlowBox[] = []): { points: Pt[]; cost: number } {
  const p1 = anchor(a, sa);
  const p2 = anchor(b, sb);
  const n1 = NORMAL[sa];
  const n2 = NORMAL[sb];
  const q1 = { x: p1.x + n1[0] * STUB, y: p1.y + n1[1] * STUB };
  const q2 = { x: p2.x + n2[0] * STUB, y: p2.y + n2[1] * STUB };
  const all = [a, b, ...obstacles];
  const xs = [(q1.x + q2.x) / 2, ...all.flatMap((o) => [o.cx - o.w / 2 - STUB, o.cx + o.w / 2 + STUB])];
  const ys = [(q1.y + q2.y) / 2, ...all.flatMap((o) => [o.cy - o.h / 2 - STUB, o.cy + o.h / 2 + STUB])];
  const mids: Pt[][] = [
    [{ x: q2.x, y: q1.y }],
    [{ x: q1.x, y: q2.y }],
    ...xs.map((x) => [{ x, y: q1.y }, { x, y: q2.y }]),
    ...ys.map((y) => [{ x: q1.x, y }, { x: q2.x, y }]),
  ];
  const boxes = a === b ? [a, ...obstacles] : all;
  let best = { points: [p1, p2], cost: Infinity };
  for (const mid of mids) {
    const raw = [p1, q1, ...mid, q2, p2];
    const cost = routeCost(raw, boxes);
    if (cost < best.cost) best = { points: simplify(raw), cost };
  }
  return best;
}

function fixedRoute(a: FlowBox, b: FlowBox, sa: Side | undefined, sb: Side | undefined, route: EdgeRoute): Pt[] {
  const all: Side[] = ["top", "right", "bottom", "left"];
  const [fa, fb] = facing(a, b);
  if (route === "straight") return [anchor(a, sa ?? fa), anchor(b, sb ?? fb)];
  // 只定了一端时，另一端挑走得最顺的那一边
  let best = { points: [] as Pt[], cost: Infinity };
  for (const s1 of sa ? [sa] : all) {
    for (const s2 of sb ? [sb] : all) {
      const r = orthoRoute(a, b, s1, s2);
      if (r.cost < best.cost) best = r;
    }
  }
  return best.points;
}

/**
 * 连线避让（直接修改 doc）：自动走线会穿过其他节点的连线，改挑四边里走得最顺、绕开节点的接法，
 * 把接边和折点写进连线，打开文件时画出来的和现在一样。用于 AI 生成的流程图。
 */
export function avoidNodes(doc: FlowDoc) {
  const geo = flowGeometry(doc);
  const boxes = geo.boxes;
  const sides: Side[] = ["top", "right", "bottom", "left"];
  /** 每个节点的每一边接了几条线：尽量不和别的连线挤在同一边 */
  const used = new Map<string, number>();
  const bump = (id: string, s: Side, d: number) => used.set(`${id}:${s}`, (used.get(`${id}:${s}`) ?? 0) + d);
  const endsOf = new Map<string, { from: Side; to: Side }>();
  for (const r of geo.routes) {
    const e = doc.edges.find((x) => x.key === r.key);
    if (!e || e.from === e.to || r.points.length < 2) continue;
    const s = sidesOf(r.points);
    endsOf.set(e.key, s);
    bump(e.from, s.from, 1);
    bump(e.to, s.to, 1);
  }
  for (const e of doc.edges) {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b || a === b || (e.route ?? "elbow") === "straight") continue;
    const others = [...boxes.values()].filter((o) => o !== a && o !== b);
    const auto = routePoints(a, b, e.route ?? "elbow", { from: e.fromSide, to: e.toSide, bends: e.bends });
    if (routeCost(auto, others) < 1e4) continue;
    const own = endsOf.get(e.key);
    if (own) {
      bump(e.from, own.from, -1);
      bump(e.to, own.to, -1);
    }
    let best = { points: [] as Pt[], cost: Infinity };
    for (const s1 of sides) {
      for (const s2 of sides) {
        const r = orthoRoute(a, b, s1, s2, others);
        const crowd = ((used.get(`${e.from}:${s1}`) ?? 0) + (used.get(`${e.to}:${s2}`) ?? 0)) * 120;
        if (r.cost + crowd < best.cost) best = { points: r.points, cost: r.cost + crowd };
      }
    }
    if (!best.points.length) continue;
    const { from, to } = sidesOf(best.points);
    bump(e.from, from, 1);
    bump(e.to, to, 1);
    const bends = bendsOf(best.points);
    e.fromSide = from;
    e.toSide = to;
    const same = JSON.stringify(routePoints(a, b, "elbow", { from, to, bends })) === JSON.stringify(best.points);
    if (same && bends.length) e.bends = bends;
    else delete e.bends;
  }
}

const isHorizontal = (p: Pt, q: Pt) => Math.abs(p.y - q.y) < 0.5 && Math.abs(p.x - q.x) >= 0.5;

/**
 * 手动拖过的横竖折线：bends 依次是中间各段的位置（横段记 y、竖段记 x），和首段交替横竖；
 * 首尾两段贴着节点，随节点移动。
 */
function bentRoute(a: FlowBox, b: FlowBox, sa: Side, sb: Side, bends: number[]): Pt[] {
  const p1 = anchor(a, sa);
  const p2 = anchor(b, sb);
  let horiz = NORMAL[sa][0] !== 0;
  let line = horiz ? p1.y : p1.x;
  const pts = [p1];
  const turn = (c: number) => {
    pts.push(horiz ? { x: c, y: line } : { x: line, y: c });
    horiz = !horiz;
    line = c;
  };
  for (const c of bends) turn(c);
  const lastH = NORMAL[sb][0] !== 0;
  if (horiz === lastH) {
    const n2 = NORMAL[sb];
    turn(lastH ? p2.x + n2[0] * STUB : p2.y + n2[1] * STUB);
  }
  turn(lastH ? p2.y : p2.x);
  pts.push(p2);
  return simplify(pts);
}

/** 横竖折线中间各段的位置（横段记 y、竖段记 x）；首尾两段不记 */
export function bendsOf(points: Pt[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length - 2; i++) out.push(isHorizontal(points[i], points[i + 1]) ? points[i].y : points[i].x);
  return out;
}

/** 折线首尾两段的走向对应接在哪一边 */
export function sidesOf(points: Pt[]): { from: Side; to: Side } {
  const dir = (p: Pt, q: Pt): Side => (isHorizontal(p, q) ? (q.x > p.x ? "right" : "left") : q.y > p.y ? "bottom" : "top");
  const n = points.length;
  return { from: dir(points[0], points[1]), to: dir(points[n - 1], points[n - 2]) };
}

/**
 * 开始拖动折线的第 seg 段：返回拖动时改写的 bends、这一段在其中的下标和移动方向。
 * 拖首尾段时先在节点边上留出一小段，把原来的段变成可以平移的中间段。
 */
export function bendHandle(points: Pt[], seg: number): { bends: number[]; index: number; axis: "x" | "y" } | null {
  const n = points.length;
  if (n < 2 || seg < 0 || seg > n - 2) return null;
  const horiz = (i: number) => isHorizontal(points[i], points[i + 1]);
  const coord = (i: number) => (horiz(i) ? points[i].y : points[i].x);
  const axis = horiz(seg) ? "y" : "x";
  const inner = bendsOf(points);
  if (seg > 0 && seg < n - 2) return { bends: inner, index: seg - 1, axis };
  const stub = (from: Pt, to: Pt) => {
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const t = Math.min(STUB, len / 2) / len;
    const q = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    return isHorizontal(from, to) ? q.x : q.y;
  };
  const head = stub(points[0], points[1]);
  const tail = stub(points[n - 1], points[n - 2]);
  if (n === 2) return { bends: [head, coord(0), tail], index: 1, axis };
  if (seg === 0) return { bends: [head, coord(0), ...inner], index: 1, axis };
  return { bends: [...inner, coord(n - 2), tail], index: inner.length, axis };
}

/**
 * 拖连线时的预览：从节点 a 的 side 边连到任意点 p。直角和圆角走线先顺着这条边伸出去，
 * 点在前方时拐一次（L 形），在侧后方时先伸出一小段再绕过去。
 */
export function pointRoute(a: FlowBox, side: Side, p: Pt, route: EdgeRoute): Pt[] {
  const p1 = anchor(a, side);
  if (route === "straight") return [p1, p];
  const [nx, ny] = NORMAL[side];
  const ahead = (p.x - p1.x) * nx + (p.y - p1.y) * ny;
  if (ahead > STUB) return simplify(nx ? [p1, { x: p.x, y: p1.y }, p] : [p1, { x: p1.x, y: p.y }, p]);
  const q1 = { x: p1.x + nx * STUB, y: p1.y + ny * STUB };
  return simplify(nx ? [p1, q1, { x: q1.x, y: p.y }, p] : [p1, q1, { x: p.x, y: q1.y }, p]);
}

/** 折线最后一段从哪个方向进来，决定终点节点接在哪一边（往下走就接在顶边） */
export function approachSide(points: Pt[]): Side {
  const a = points[points.length - 2] ?? points[0];
  const b = points[points.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "left" : "right";
  return dy >= 0 ? "top" : "bottom";
}

/** 节点四条边的中点：拖连线时在目标节点上显示可以接的位置 */
export function sidePoints(b: FlowBox): { side: Side; x: number; y: number }[] {
  return (["top", "right", "bottom", "left"] as Side[]).map((side) => ({ side, ...anchor(b, side) }));
}

export function routePoints(a: FlowBox, b: FlowBox, route: EdgeRoute, sides: { from?: Side; to?: Side; bends?: number[] } = {}): Pt[] {
  if (sides.bends?.length && sides.from && sides.to && route !== "straight") return bentRoute(a, b, sides.from, sides.to, sides.bends);
  if (sides.from || sides.to) return fixedRoute(a, b, sides.from, sides.to, route);
  if (route === "straight") return [clip(a, { x: b.cx, y: b.cy }), clip(b, { x: a.cx, y: a.cy })];
  const [sa, sb] = facing(a, b);
  const horizontal = sa === "left" || sa === "right";
  // 两个节点在另一个方向上有重叠时画一条不拐弯的直线
  const ca = horizontal ? a.cy : a.cx;
  const cb = horizontal ? b.cy : b.cx;
  const lo = Math.max(ca - edgeSpan(a, !horizontal), cb - edgeSpan(b, !horizontal));
  const hi = Math.min(ca + edgeSpan(a, !horizontal), cb + edgeSpan(b, !horizontal));
  if (lo <= hi) {
    const at = Math.min(Math.max((ca + cb) / 2, lo), hi);
    return [edgePoint(a, sa, at - ca), edgePoint(b, sb, at - cb)];
  }
  // 上下关系为主、目标又在斜下方（或斜上方）时走 L 形：从侧边水平出去，再竖着接到目标的顶边或底边
  if (!horizontal && Math.abs(b.cx - a.cx) > a.w / 2 + 8 && Math.abs(a.cy - b.cy) > b.h / 2 + 8) {
    const p1 = anchor(a, b.cx > a.cx ? "right" : "left");
    const p2 = anchor(b, b.cy > a.cy ? "top" : "bottom");
    return [p1, { x: p2.x, y: p1.y }, p2];
  }
  const p1 = anchor(a, sa);
  const p2 = anchor(b, sb);
  if (horizontal ? Math.abs(p1.y - p2.y) < 0.5 : Math.abs(p1.x - p2.x) < 0.5) return [p1, p2];
  if (horizontal) {
    const mx = (p1.x + p2.x) / 2;
    return [p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2];
  }
  const my = (p1.y + p2.y) / 2;
  return [p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2];
}

/** 折线；rounded 时拐角画成圆弧 */
export function polylinePath(points: Pt[], rounded: boolean): string {
  if (points.length < 2) return "";
  let d = `M${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    if (!rounded) {
      d += `L${p.x} ${p.y}`;
      continue;
    }
    const a = points[i - 1];
    const c = points[i + 1];
    const la = Math.hypot(p.x - a.x, p.y - a.y);
    const lc = Math.hypot(c.x - p.x, c.y - p.y);
    const r = Math.min(10, la / 2, lc / 2);
    if (r < 0.5) {
      d += `L${p.x} ${p.y}`;
      continue;
    }
    const p1 = { x: p.x + ((a.x - p.x) / la) * r, y: p.y + ((a.y - p.y) / la) * r };
    const p2 = { x: p.x + ((c.x - p.x) / lc) * r, y: p.y + ((c.y - p.y) / lc) * r };
    d += `L${p1.x} ${p1.y}Q${p.x} ${p.y} ${p2.x} ${p2.y}`;
  }
  const last = points[points.length - 1];
  return d + `L${last.x} ${last.y}`;
}

function selfLoop(b: FlowBox): Pt[] {
  const x = b.cx + b.w / 2;
  return [{ x, y: b.cy - 8 }, { x: x + 28, y: b.cy - 8 }, { x: x + 28, y: b.cy + 8 }, { x, y: b.cy + 8 }];
}

/** 折线长度的一半处 */
function midpoint(points: Pt[]): Pt {
  const lens = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let half = lens.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lens.length; i++) {
    if (half <= lens[i] || i === lens.length - 1) {
      const t = lens[i] ? half / lens[i] : 0;
      return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t };
    }
    half -= lens[i];
  }
  return points[0];
}

export function fixedSize(n: FlowNode): { w: number; h: number } | undefined {
  return n.w && n.h ? { w: n.w, h: n.h } : undefined;
}

export function boxOf(n: FlowNode): FlowBox {
  const m = measureNode(n.text, n.shape, n.style, n.isText, fixedSize(n));
  return { id: n.id, shape: n.shape, isText: !!n.isText, cx: n.x ?? 0, cy: n.y ?? 0, ...m };
}

export function flowGeometry(doc: FlowDoc): FlowGeometry {
  const boxes = new Map(doc.nodes.map((n) => [n.id, boxOf(n)]));
  const routes: FlowRoute[] = [];
  for (const e of doc.edges) {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) continue;
    const route = e.route ?? "elbow";
    const points = e.from === e.to ? selfLoop(a) : routePoints(a, b, route, { from: e.fromSide, to: e.toSide, bends: e.bends });
    let label = null;
    if (e.label) {
      const mid = midpoint(points);
      const w = textWidth(e.label, LABEL_FONT) + 12;
      label = { x: mid.x - w / 2, y: mid.y - 10, w, h: 20 };
    }
    routes.push({ key: e.key, points, d: polylinePath(points, route === "round" || e.from === e.to), label });
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x1: number, y1: number, x2: number, y2: number) => {
    minX = Math.min(minX, x1);
    minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2);
    maxY = Math.max(maxY, y2);
  };
  for (const b of boxes.values()) grow(b.cx - b.w / 2, b.cy - b.h / 2, b.cx + b.w / 2, b.cy + b.h / 2);
  for (const r of routes) {
    for (const p of r.points) grow(p.x, p.y, p.x, p.y);
    if (r.label) grow(r.label.x, r.label.y, r.label.x + r.label.w, r.label.y + r.label.h);
  }
  if (minX === Infinity) return { boxes, routes, minX: 0, minY: 0, width: 0, height: 0 };
  return { boxes, routes, minX, minY, width: maxX - minX, height: maxY - minY };
}

/* ---------- 自动整理 ---------- */

interface Item {
  id: string;
  /** 中转点没有尺寸 */
  dummy: boolean;
  /** 层内顺序的依据 */
  key: number;
  size: number;
  cross: number;
}

/** 按定义顺序深度优先找出成环的连线并反向，再按最长路径分层 */
function longestPathRanks(doc: FlowDoc): Map<string, number> {
  const ids = new Set(doc.nodes.map((n) => n.id));
  const out = new Map<string, string[]>(doc.nodes.map((n) => [n.id, []]));
  doc.edges.forEach((e) => {
    if (e.from !== e.to && ids.has(e.to)) out.get(e.from)?.push(e.to);
  });
  const reversed = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      const s = state.get(to);
      if (s === 1) reversed.add(`${id}>${to}`);
      else if (!s) visit(to);
    }
    state.set(id, 2);
  };
  doc.nodes.forEach((n) => state.has(n.id) || visit(n.id));

  const rank = new Map<string, number>(doc.nodes.map((n) => [n.id, 0]));
  const preds = new Map<string, string[]>(doc.nodes.map((n) => [n.id, []]));
  const succs = new Map<string, string[]>(doc.nodes.map((n) => [n.id, []]));
  for (const e of doc.edges) {
    if (e.from === e.to || !ids.has(e.from) || !ids.has(e.to)) continue;
    const [a, b] = reversed.has(`${e.from}>${e.to}`) ? [e.to, e.from] : [e.from, e.to];
    succs.get(a)!.push(b);
    preds.get(b)!.push(a);
  }
  const indeg = new Map(doc.nodes.map((n) => [n.id, preds.get(n.id)!.length]));
  const queue = doc.nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const to of succs.get(id)!) {
      rank.set(to, Math.max(rank.get(to)!, rank.get(id)! + 1));
      indeg.set(to, indeg.get(to)! - 1);
      if (!indeg.get(to)) queue.push(to);
    }
  }
  return rank;
}

function forcedRanks(layers: string[][]): Map<string, number> {
  const rank = new Map<string, number>();
  layers.forEach((l, r) => l.forEach((id) => rank.set(id, r)));
  return rank;
}

/**
 * 按分层布局算出每个节点的中心位置（左上角从 0 开始）。
 * layers 给出时（AI 整理）按它分层、按它排同一层里的先后，必须包含全部节点；否则按最长路径自动分层。
 */
export function autoPositions(doc: FlowDoc, dir: FlowDir, layers?: string[][]): Map<string, Pt> {
  const vertical = dir === "TD" || dir === "BT";
  const k = SPACING_SCALE[doc.canvas?.spacing ?? "standard"];
  const RANK_GAP_K = Math.round(RANK_GAP * k);
  const NODE_GAP_K = Math.round(NODE_GAP * k);
  const index = new Map(doc.nodes.map((n, i) => [n.id, i]));
  const sizes = new Map(doc.nodes.map((n) => [n.id, measureNode(n.text, n.shape, n.style, n.isText, fixedSize(n))]));
  const rankSize = (id: string) => (vertical ? sizes.get(id)!.h : sizes.get(id)!.w);
  const crossSize = (id: string) => (vertical ? sizes.get(id)!.w : sizes.get(id)!.h);

  const rank = layers ? forcedRanks(layers) : longestPathRanks(doc);
  const inLayer = new Map<string, number>();
  layers?.forEach((l) => l.forEach((id, k) => inLayer.set(id, k)));
  const keyOf = (id: string) => inLayer.get(id) ?? index.get(id)!;
  /** 连线按层从浅到深的方向处理；同一层里的连线不参与排序 */
  const forward = (from: string, to: string): [string, string] | null => {
    const ra = rank.get(from)!;
    const rb = rank.get(to)!;
    if (ra === rb) return null;
    return ra < rb ? [from, to] : [to, from];
  };

  // 3. 中转点
  const maxRank = Math.max(0, ...rank.values());
  const grid: Item[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const n of doc.nodes) {
    grid[rank.get(n.id)!].push({ id: n.id, dummy: false, key: keyOf(n.id), size: crossSize(n.id), cross: 0 });
  }
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    if (!down.has(a)) down.set(a, []);
    if (!up.has(b)) up.set(b, []);
    down.get(a)!.push(b);
    up.get(b)!.push(a);
  };
  for (const e of doc.edges) {
    if (e.from === e.to || !index.has(e.from) || !index.has(e.to)) continue;
    const pair = forward(e.from, e.to);
    if (!pair) continue;
    const [a, b] = pair;
    let prev = a;
    for (let r = rank.get(a)! + 1; r < rank.get(b)!; r++) {
      const id = `${e.key}#${r}`;
      grid[r].push({ id, dummy: true, key: (keyOf(a) + keyOf(b)) / 2 + 0.01 * r, size: 0, cross: 0 });
      link(prev, id);
      prev = id;
    }
    link(prev, b);
  }

  // 4. 层内顺序：真实节点保持定义顺序；中转点按上游在上一层的位置插入，减少交叉
  const posIndex = new Map<string, number>();
  grid.forEach((layer, r) => {
    const median = (id: string) => {
      const ps = (up.get(id) ?? []).map((p) => posIndex.get(p) ?? 0).sort((a, b) => a - b);
      if (!ps.length) return 0;
      const m = ps.length >> 1;
      return ps.length % 2 ? ps[m] : (ps[m - 1] + ps[m]) / 2;
    };
    const bary = new Map<string, number>();
    if (r > 0) {
      let floor = -Infinity;
      for (const it of [...layer].filter((x) => !x.dummy).sort((a, b) => a.key - b.key)) {
        floor = Math.max(floor, median(it.id));
        bary.set(it.id, floor);
      }
      for (const it of layer) if (it.dummy) bary.set(it.id, median(it.id));
    }
    layer.sort((x, y) => (bary.get(x.id) ?? 0) - (bary.get(y.id) ?? 0) || x.key - y.key);
    layer.forEach((it, i) => posIndex.set(it.id, i));
  });
  for (const layer of grid) {
    let pos = 0;
    for (const it of layer) {
      it.cross = pos + it.size / 2;
      pos += it.size + NODE_GAP_K;
    }
  }
  const items = new Map<string, Item>();
  grid.forEach((l) => l.forEach((it) => items.set(it.id, it)));
  const gapOf = (a: Item, b: Item) => (a.size + b.size) / 2 + (a.dummy || b.dummy ? NODE_GAP_K / 2 : NODE_GAP_K);

  const place = (layer: Item[], neighbors: Map<string, string[]>) => {
    const want = layer.map((it) => {
      const ns = (neighbors.get(it.id) ?? []).map((id) => items.get(id)!.cross).sort((a, b) => a - b);
      if (!ns.length) return it.cross;
      const m = ns.length >> 1;
      return ns.length % 2 ? ns[m] : (ns[m - 1] + ns[m]) / 2;
    });
    const fwd = [...want];
    for (let i = 1; i < layer.length; i++) fwd[i] = Math.max(fwd[i], fwd[i - 1] + gapOf(layer[i - 1], layer[i]));
    const bwd = [...want];
    for (let i = layer.length - 2; i >= 0; i--) bwd[i] = Math.min(bwd[i], bwd[i + 1] - gapOf(layer[i], layer[i + 1]));
    const mid = fwd.map((f, i) => (f + bwd[i]) / 2);
    for (let i = 1; i < layer.length; i++) mid[i] = Math.max(mid[i], mid[i - 1] + gapOf(layer[i - 1], layer[i]));
    layer.forEach((it, i) => (it.cross = mid[i]));
  };
  for (let round = 0; round < 4; round++) {
    for (let r = 1; r < grid.length; r++) place(grid[r], up);
    for (let r = grid.length - 2; r >= 0; r--) place(grid[r], down);
  }

  const minCross = Math.min(0, ...[...items.values()].map((it) => it.cross - it.size / 2));
  for (const it of items.values()) it.cross -= minCross;

  // 每层在主轴上的位置
  const rankStart: number[] = [];
  const rankThick: number[] = [];
  let at = 0;
  grid.forEach((layer, r) => {
    const thick = Math.max(0, ...layer.filter((it) => !it.dummy).map((it) => rankSize(it.id)));
    rankStart[r] = at;
    rankThick[r] = thick;
    at += thick + RANK_GAP_K;
  });
  const mainExtent = Math.max(0, at - RANK_GAP_K);
  const flipMain = dir === "BT" || dir === "RL";
  const out2 = new Map<string, Pt>();
  for (const n of doc.nodes) {
    const r = rank.get(n.id)!;
    const main = rankStart[r] + rankThick[r] / 2;
    const m = flipMain ? mainExtent - main : main;
    const cross = items.get(n.id)!.cross;
    out2.set(n.id, vertical ? { x: Math.round(cross), y: Math.round(m) } : { x: Math.round(m), y: Math.round(cross) });
  }
  return out2;
}

/**
 * 给没有位置的节点补上位置（直接修改 doc），返回是否补过。
 * 全都没有时整张图自动排一次；只有一部分没有时，把它们按自动排版的相对位置放在已有节点右边。
 */
export function fillPositions(doc: FlowDoc): boolean {
  const missing = doc.nodes.filter((n) => n.x === undefined || n.y === undefined);
  if (!missing.length) return false;
  const auto = autoPositions(doc, doc.dir);
  let dx = 0;
  let dy = 0;
  if (missing.length < doc.nodes.length) {
    const placed = doc.nodes.filter((n) => !missing.includes(n)).map(boxOf);
    const right = Math.max(...placed.map((b) => b.cx + b.w / 2));
    const top = Math.min(...placed.map((b) => b.cy - b.h / 2));
    const boxes = missing.map((n) => ({ ...boxOf(n), cx: auto.get(n.id)!.x, cy: auto.get(n.id)!.y }));
    dx = right + 80 - Math.min(...boxes.map((b) => b.cx - b.w / 2));
    dy = top - Math.min(...boxes.map((b) => b.cy - b.h / 2));
  }
  for (const n of missing) {
    const p = auto.get(n.id)!;
    n.x = Math.round(p.x + dx);
    n.y = Math.round(p.y + dy);
  }
  return true;
}

/** 整理：按方向（和 AI 给出的分层）重新排全部节点（直接修改 doc）；位置全变了，连线改回自动选边 */
export function arrange(doc: FlowDoc, dir: FlowDir, layers?: string[][]) {
  const auto = autoPositions(doc, dir, layers);
  doc.dir = dir;
  for (const n of doc.nodes) {
    const p = auto.get(n.id)!;
    n.x = p.x;
    n.y = p.y;
  }
  for (const e of doc.edges) {
    delete e.fromSide;
    delete e.toSide;
    delete e.bends;
  }
}

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "hspace" | "vspace";

/** 对齐与分布（直接修改 doc）。对齐以选中节点的整体范围为准；等间距保留两端的节点不动，中间的节点让空隙相等 */
export function alignNodes(doc: FlowDoc, ids: string[], mode: AlignMode) {
  const nodes = doc.nodes.filter((n) => ids.includes(n.id));
  if (nodes.length < 2) return;
  const boxes = nodes.map((n) => ({ n, b: boxOf(n) }));
  const left = Math.min(...boxes.map(({ b }) => b.cx - b.w / 2));
  const right = Math.max(...boxes.map(({ b }) => b.cx + b.w / 2));
  const top = Math.min(...boxes.map(({ b }) => b.cy - b.h / 2));
  const bottom = Math.max(...boxes.map(({ b }) => b.cy + b.h / 2));
  for (const { n, b } of boxes) {
    if (mode === "left") n.x = Math.round(left + b.w / 2);
    else if (mode === "right") n.x = Math.round(right - b.w / 2);
    else if (mode === "hcenter") n.x = Math.round((left + right) / 2);
    else if (mode === "top") n.y = Math.round(top + b.h / 2);
    else if (mode === "bottom") n.y = Math.round(bottom - b.h / 2);
    else if (mode === "vcenter") n.y = Math.round((top + bottom) / 2);
  }
  if ((mode === "hspace" || mode === "vspace") && boxes.length >= 3) {
    const h = mode === "hspace";
    const sorted = [...boxes].sort((p, q) => (h ? p.b.cx - q.b.cx : p.b.cy - q.b.cy));
    const sizeOf = (b: FlowBox) => (h ? b.w : b.h);
    const total = sorted.reduce((s, { b }) => s + sizeOf(b), 0);
    const span = h ? right - left : bottom - top;
    const gap = (span - total) / (sorted.length - 1);
    let at = h ? left : top;
    for (const { n, b } of sorted) {
      if (h) n.x = Math.round(at + b.w / 2);
      else n.y = Math.round(at + b.h / 2);
      at += sizeOf(b) + gap;
    }
  }
}

export function dirLabel(dir: FlowDir): string {
  return { TD: "上 → 下", BT: "下 → 上", LR: "左 → 右", RL: "右 → 左" }[dir];
}
