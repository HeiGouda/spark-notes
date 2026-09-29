import type { NodeStyle, PaletteName } from "./spark";

/**
 * 配色方案与节点色板（需求文档 5.18）。“跟随应用主题”直接引用主题令牌；
 * 预设方案各有浅色版和深色版，应用处于夜读、纯黑时用深色版。
 */
export interface SchemeColors {
  root: string;
  rootText: string;
  /** 一级主题、概要节点、流程图节点 */
  main: string;
  mainStroke: string;
  mainText: string;
  /** 二级及以下的文字 */
  sub: string;
  /** 思维导图连线、下划线 */
  line: string;
  /** 流程图判断节点 */
  soft: string;
  /** 流程图连线 */
  edge: string;
  /** 按一级分支轮换的颜色（彩虹） */
  branches?: string[];
}

export interface Scheme {
  id: string;
  name: string;
  light: SchemeColors;
  dark: SchemeColors;
}

const THEME: SchemeColors = {
  root: "var(--accent)", rootText: "var(--paper)", main: "var(--paper)", mainStroke: "var(--line-strong)", mainText: "var(--ink)",
  sub: "var(--ink-2)", line: "var(--line-strong)", soft: "var(--accent-soft)", edge: "var(--ink-2)",
};

export const SCHEMES: Scheme[] = [
  { id: "theme", name: "跟随应用主题", light: THEME, dark: THEME },
  {
    id: "classic", name: "经典",
    light: { root: "#C0604C", rootText: "#FFFFFF", main: "#FBF3E4", mainStroke: "#E0B84C", mainText: "#3B2F1E", sub: "#4A4A4A", line: "#6B8F71", soft: "#F6E3C2", edge: "#6B6B6B" },
    dark: { root: "#B5584A", rootText: "#FFF6F0", main: "#2E2A22", mainStroke: "#C9A445", mainText: "#EDE3D0", sub: "#C8C8C8", line: "#7FA586", soft: "#4A3F2A", edge: "#A8A8A8" },
  },
  {
    id: "fresh", name: "清新",
    light: { root: "#3F8F6A", rootText: "#FFFFFF", main: "#E8F3EC", mainStroke: "#9CCFB2", mainText: "#1F3D2E", sub: "#3E5247", line: "#9CCFB2", soft: "#D6EDE0", edge: "#5E7F6E" },
    dark: { root: "#3A8061", rootText: "#F0FFF6", main: "#1E2E26", mainStroke: "#4E8C6B", mainText: "#D5EBDD", sub: "#AFC6B8", line: "#4E8C6B", soft: "#24392E", edge: "#8FB3A0" },
  },
  {
    id: "blue", name: "商务蓝",
    light: { root: "#2F6FD0", rootText: "#FFFFFF", main: "#E6EEFB", mainStroke: "#8CB3EA", mainText: "#17325E", sub: "#3A4A63", line: "#8CB3EA", soft: "#D7E4F8", edge: "#5A6B85" },
    dark: { root: "#3A73C8", rootText: "#F2F7FF", main: "#1C2638", mainStroke: "#4A74B0", mainText: "#D6E2F5", sub: "#AEBBD0", line: "#4A74B0", soft: "#22314A", edge: "#8FA3C2" },
  },
  {
    id: "ink", name: "墨黑",
    light: { root: "#2B2B35", rootText: "#FFFFFF", main: "#EEEEEE", mainStroke: "#777777", mainText: "#222222", sub: "#444444", line: "#999999", soft: "#E2E2E2", edge: "#555555" },
    dark: { root: "#E6E6EA", rootText: "#1A1A1F", main: "#26262C", mainStroke: "#8A8A92", mainText: "#E4E4E7", sub: "#BDBDC3", line: "#6E6E76", soft: "#303036", edge: "#A0A0A8" },
  },
  {
    id: "violet", name: "紫罗兰",
    light: { root: "#5A3FA0", rootText: "#FFFFFF", main: "#EFEAF8", mainStroke: "#A894D6", mainText: "#2E2152", sub: "#4A405E", line: "#A894D6", soft: "#E3DAF4", edge: "#6E6488" },
    dark: { root: "#6B4FB8", rootText: "#F7F2FF", main: "#251F36", mainStroke: "#7A63B8", mainText: "#E0D8F5", sub: "#BCB2D4", line: "#7A63B8", soft: "#2E2645", edge: "#A69BC4" },
  },
  {
    id: "warm", name: "暖橙",
    light: { root: "#E0773A", rootText: "#FFFFFF", main: "#FBEEE4", mainStroke: "#F0B98E", mainText: "#5A2E12", sub: "#5E4A3E", line: "#F0B98E", soft: "#F8E0CC", edge: "#8A6A55" },
    dark: { root: "#C96A33", rootText: "#FFF6EE", main: "#33261D", mainStroke: "#B07A52", mainText: "#F2DECD", sub: "#CDB8A8", line: "#B07A52", soft: "#3D2C20", edge: "#BFA08A" },
  },
  {
    id: "rainbow", name: "彩虹",
    light: {
      root: "#3A3F4B", rootText: "#FFFFFF", main: "#FFFFFF", mainStroke: "#D65A8A", mainText: "#222222", sub: "#444444", line: "#BBBBBB", soft: "#FDF1D0", edge: "#666666",
      branches: ["#D65A8A", "#4AA3C4", "#E8A93A", "#5BAE6E", "#8A6BD6", "#E07A4B"],
    },
    dark: {
      root: "#E4E4E7", rootText: "#1A1A1F", main: "#1F2128", mainStroke: "#E07AA0", mainText: "#E4E4E7", sub: "#C0C0C6", line: "#55555C", soft: "#3A3322", edge: "#A0A0A8",
      branches: ["#E07AA0", "#5DB5D6", "#E8B550", "#6FC283", "#A08AE6", "#E8906A"],
    },
  },
];

export function schemeOf(id: string | undefined): Scheme {
  return SCHEMES.find((s) => s.id === id) ?? SCHEMES[0];
}

export function schemeColors(id: string | undefined, dark: boolean): SchemeColors {
  const s = schemeOf(id);
  return dark ? s.dark : s.light;
}

/** 面板上的三色预览 */
export function swatches(id: string, dark: boolean): string[] {
  const c = schemeColors(id, dark);
  return [c.root, c.branches?.[1] ?? c.mainStroke, c.branches?.[2] ?? c.main];
}

/* ---------- 节点色板：12 色，深色主题下调暗 ---------- */

export const PALETTE: { name: PaletteName; label: string; light: string; dark: string }[] = [
  { name: "rose", label: "玫瑰", light: "#F6D5CF", dark: "#5C3630" },
  { name: "apricot", label: "杏色", light: "#F8E3C4", dark: "#5A4428" },
  { name: "lemon", label: "柠檬", light: "#F4EDB8", dark: "#524D26" },
  { name: "mint", label: "薄荷", light: "#D6EAD8", dark: "#2E4A36" },
  { name: "sky", label: "天蓝", light: "#D3E5F3", dark: "#2A4458" },
  { name: "lavender", label: "薰衣草", light: "#E0DAF3", dark: "#3E3860" },
  { name: "red", label: "红", light: "#C8553D", dark: "#B04A36" },
  { name: "orange", label: "橙", light: "#E08A2E", dark: "#B8702A" },
  { name: "green", label: "绿", light: "#3F8F5A", dark: "#357A4C" },
  { name: "blue", label: "蓝", light: "#2F6FD0", dark: "#2C5FAE" },
  { name: "purple", label: "紫", light: "#7D4FC0", dark: "#6A45A3" },
  { name: "ink", label: "墨", light: "#3A3F4B", dark: "#C9CDD6" },
];

/** 色板名称按当前主题取色；取色器选的 #rrggbb 原样返回 */
export function resolveColor(v: string | undefined, dark: boolean): string | undefined {
  if (!v) return undefined;
  const p = PALETTE.find((c) => c.name === v);
  if (p) return dark ? p.dark : p.light;
  return v;
}

export interface NodeColors {
  fill: string;
  stroke: string;
  text: string;
  /** 连到这个节点的连线、二级及以下的下划线 */
  line: string;
}

/** 思维导图节点的颜色：先按配色方案和层级，节点样式优先。boxed 为 false 时节点不画框（纯文字外观），根节点的文字用根节点的颜色 */
export function mindNodeColors(c: SchemeColors, depth: number, branch: number, summary: boolean, style: NodeStyle | undefined, dark: boolean, boxed = true): NodeColors {
  const accent = branch >= 0 && c.branches ? c.branches[branch % c.branches.length] : null;
  let base: NodeColors;
  if (!boxed && depth <= 1 && !summary) base = { fill: "none", stroke: "none", text: depth === 0 ? c.root : c.mainText, line: accent ?? c.line };
  else if (!boxed && summary) base = { fill: "none", stroke: "none", text: c.mainText, line: accent ?? c.line };
  else if (depth === 0) base = { fill: c.root, stroke: "none", text: c.rootText, line: c.line };
  else if (depth === 1 || summary) base = { fill: c.main, stroke: accent ?? c.mainStroke, text: c.mainText, line: accent ?? c.line };
  else base = { fill: "none", stroke: "none", text: c.sub, line: accent ?? c.line };
  return {
    fill: resolveColor(style?.bg, dark) ?? base.fill,
    stroke: resolveColor(style?.border, dark) ?? base.stroke,
    text: resolveColor(style?.color, dark) ?? base.text,
    line: base.line,
  };
}

export function flowNodeColors(c: SchemeColors, diamond: boolean, style: NodeStyle | undefined, dark: boolean): Omit<NodeColors, "line"> {
  return {
    fill: resolveColor(style?.bg, dark) ?? (diamond ? c.soft : c.main),
    stroke: resolveColor(style?.border, dark) ?? c.mainStroke,
    text: resolveColor(style?.color, dark) ?? c.mainText,
  };
}

/** 字号四档相对默认字号的倍数 */
export const SIZE_SCALE = { s: 0.85, m: 1, l: 1.2, xl: 1.45 } as const;

/** 主题间距三档相对标准间距的倍数 */
export const SPACING_SCALE = { compact: 0.6, standard: 1, loose: 1.5 } as const;
