/**
 * Spark 写进图文件的扩展信息（需求文档 5.18）：以 `%% spark:` 开头的注释，内容是空格分隔的 `键=值`。
 * - 整张图（`mindmap` / `flowchart` 下面的第一行）：layout、scheme、spacing；
 * - 节点（该节点的前一行）：bg、border、color、size、bold，概要节点另有 summary。
 * 不认识的键和不合法的值直接忽略，节点照常显示。
 */

export type MindStructure = "right" | "balanced" | "left" | "down" | "fishbone";
export type Spacing = "compact" | "standard" | "loose";
export type FontSize = "s" | "m" | "l" | "xl";
/** 思维导图的线条：曲线、圆角折线、直角折线、分叉斜线、直线、先斜后平 */
export type MindLine = "curve" | "round" | "elbow" | "fork" | "straight" | "slant";
/** 流程图连线的走线：直角、圆角、直线 */
export type EdgeRoute = "elbow" | "round" | "straight";
/** 思维导图的节点外观：方框、纯文字 */
export type MindLook = "box" | "text";

export const STRUCTURES: MindStructure[] = ["right", "balanced", "left", "down", "fishbone"];
export const SPACINGS: Spacing[] = ["compact", "standard", "loose"];
export const FONT_SIZES: FontSize[] = ["s", "m", "l", "xl"];
export const MIND_LINES: MindLine[] = ["curve", "round", "elbow", "fork", "straight", "slant"];
export const EDGE_ROUTES: EdgeRoute[] = ["elbow", "round", "straight"];
export const MIND_LOOKS: MindLook[] = ["box", "text"];

/** 整张图的设置；缺省即默认值（向右、曲线、跟随应用主题、标准间距） */
export interface CanvasStyle {
  structure?: MindStructure;
  look?: MindLook;
  line?: MindLine;
  scheme?: string;
  spacing?: Spacing;
}

/** 节点样式：颜色为色板名称（随深色主题调暗）或 #rrggbb（原样显示） */
export interface NodeStyle {
  bg?: string;
  border?: string;
  color?: string;
  size?: FontSize;
  bold?: boolean;
}

export const PALETTE_NAMES = ["rose", "apricot", "lemon", "mint", "sky", "lavender", "red", "orange", "green", "blue", "purple", "ink"] as const;
export type PaletteName = (typeof PALETTE_NAMES)[number];

const PREFIX = /^%%\s*spark:/i;

export function isSparkLine(t: string): boolean {
  return PREFIX.test(t);
}

function fields(t: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of t.replace(PREFIX, "").trim().split(/\s+/)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) out.set(part.toLowerCase(), "");
    else out.set(part.slice(0, eq).toLowerCase(), part.slice(eq + 1));
  }
  return out;
}

export function isColor(v: string): boolean {
  return (PALETTE_NAMES as readonly string[]).includes(v) || /^#[0-9a-f]{6}$/i.test(v);
}

function pick<T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined {
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

export interface SparkInfo {
  canvas: CanvasStyle;
  style: NodeStyle;
  /** 概要：概括前面几个同级节点 */
  summary?: number;
  /** 流程图节点的中心位置 */
  pos?: { x: number; y: number };
  /** 流程图的文字节点 */
  text?: boolean;
  /** 流程图连线的走线 */
  route?: EdgeRoute;
  /** 流程图节点手动调整的大小 */
  size?: { w: number; h: number };
  /** 流程图连线两端接在哪一边 */
  out?: Side;
  in?: Side;
  /** 流程图连线手动拖过的中间段位置 */
  via?: number[];
}

export type Side = "top" | "right" | "bottom" | "left";
export const SIDES: Side[] = ["top", "right", "bottom", "left"];

export function parseSpark(t: string): SparkInfo {
  const f = fields(t);
  const canvas: CanvasStyle = {};
  const style: NodeStyle = {};
  const structure = pick(f.get("layout"), STRUCTURES);
  if (structure) canvas.structure = structure;
  const look = pick(f.get("look"), MIND_LOOKS);
  if (look) canvas.look = look;
  const lineKind = pick(f.get("line"), MIND_LINES);
  if (lineKind) canvas.line = lineKind;
  const scheme = f.get("scheme");
  if (scheme && /^[a-z][a-z0-9-]*$/.test(scheme)) canvas.scheme = scheme;
  const spacing = pick(f.get("spacing"), SPACINGS);
  if (spacing) canvas.spacing = spacing;
  for (const key of ["bg", "border", "color"] as const) {
    const v = f.get(key)?.toLowerCase();
    if (v && isColor(v)) style[key] = v;
  }
  const size = pick(f.get("size"), FONT_SIZES);
  if (size) style.size = size;
  const bold = f.get("bold");
  if (bold === "1" || bold === "") style.bold = true;
  else if (bold === "0") style.bold = false;
  const info: SparkInfo = { canvas, style };
  const n = Number(f.get("summary"));
  if (f.has("summary") && Number.isInteger(n) && n > 0) info.summary = n;
  const num = (v: string | undefined) => (v !== undefined && /^-?\d+(\.\d+)?$/.test(v) ? Math.round(Number(v)) : null);
  const x = num(f.get("x"));
  const y = num(f.get("y"));
  if (x !== null && y !== null) info.pos = { x, y };
  if (f.has("text") && f.get("text") !== "0") info.text = true;
  const route = pick(f.get("route"), EDGE_ROUTES);
  if (route) info.route = route;
  const w = num(f.get("w"));
  const h = num(f.get("h"));
  if (w !== null && h !== null && w > 0 && h > 0) info.size = { w, h };
  const out = pick(f.get("out"), SIDES);
  if (out) info.out = out;
  const inSide = pick(f.get("in"), SIDES);
  if (inSide) info.in = inSide;
  const via = f.get("via")?.split(",").map(num);
  if (via?.length && via.every((v) => v !== null)) info.via = via as number[];
  return info;
}

function line(parts: (string | null)[]): string | null {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length ? `%% spark: ${kept.join(" ")}` : null;
}

/** 整张图的扩展注释；全是默认值时返回 null，不写这一行 */
export function formatCanvas(c: CanvasStyle): string | null {
  return line([
    c.structure && c.structure !== "right" ? `layout=${c.structure}` : null,
    c.look && c.look !== "box" ? `look=${c.look}` : null,
    c.line && c.line !== "curve" ? `line=${c.line}` : null,
    c.scheme && c.scheme !== "theme" ? `scheme=${c.scheme}` : null,
    c.spacing && c.spacing !== "standard" ? `spacing=${c.spacing}` : null,
  ]);
}

/** 节点的扩展注释；没有样式、位置，也不是概要或文字时返回 null */
export function formatNode(
  style: NodeStyle | undefined,
  extra: { summary?: number; pos?: { x: number; y: number }; size?: { w: number; h: number }; text?: boolean } = {},
): string | null {
  const s = style ?? {};
  return line([
    extra.summary ? `summary=${extra.summary}` : null,
    extra.pos ? `x=${Math.round(extra.pos.x)} y=${Math.round(extra.pos.y)}` : null,
    extra.size ? `w=${Math.round(extra.size.w)} h=${Math.round(extra.size.h)}` : null,
    extra.text ? "text" : null,
    s.bg ? `bg=${s.bg}` : null,
    s.border ? `border=${s.border}` : null,
    s.color ? `color=${s.color}` : null,
    s.size && s.size !== "m" ? `size=${s.size}` : null,
    s.bold === undefined ? null : `bold=${s.bold ? 1 : 0}`,
  ]);
}

/** 流程图连线的扩展注释；默认的直角走线、自动选边不写 */
export function formatEdge(route: EdgeRoute | undefined, out?: Side, inSide?: Side, via?: number[]): string | null {
  return line([
    route && route !== "elbow" ? `route=${route}` : null,
    out ? `out=${out}` : null,
    inSide ? `in=${inSide}` : null,
    via?.length ? `via=${via.map(Math.round).join(",")}` : null,
  ]);
}

export function hasStyle(s: NodeStyle | undefined): boolean {
  return !!s && Object.values(s).some((v) => v !== undefined);
}

/** 合并样式修改：值为 undefined 的键表示清除 */
export function patchStyle(s: NodeStyle | undefined, patch: Partial<NodeStyle>): NodeStyle | undefined {
  const next: NodeStyle = { ...s };
  for (const [k, v] of Object.entries(patch) as [keyof NodeStyle, NodeStyle[keyof NodeStyle]][]) {
    if (v === undefined) delete next[k];
    else (next as Record<string, unknown>)[k] = v;
  }
  return hasStyle(next) ? next : undefined;
}
