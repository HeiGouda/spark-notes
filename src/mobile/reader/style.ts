/** 电子书的阅读主题和排版样式。和 App 的主题分开：阅读页整页（包括菜单和面板）都用这里的颜色 */

export type ReaderTheme = "浅色" | "纸张" | "护眼" | "夜读" | "纯黑";

export interface ReaderPalette {
  bg: string;
  fg: string;
  fg2: string;
  muted: string;
  line: string;
  lineStrong: string;
  chrome: string;
  hover: string;
  accent: string;
  accentSoft: string;
  dark: boolean;
}

/** 配色取自 tokens.css 的五套主题，正文底色和字色沿用以前阅读页的值 */
export const READER_THEMES: Record<ReaderTheme, ReaderPalette> = {
  浅色: { bg: "#ffffff", fg: "#222222", fg2: "#454C5C", muted: "#7A8191", line: "#E1E4EA", lineStrong: "#CDD2DB", chrome: "#F3F4F7", hover: "rgba(30, 35, 48, .06)", accent: "#3446A8", accentSoft: "#E9ECF9", dark: false },
  纸张: { bg: "#f3ead7", fg: "#3a3126", fg2: "#554D42", muted: "#8A8072", line: "#DFD5C3", lineStrong: "#CCBEA7", chrome: "#ECE4D4", hover: "rgba(70, 50, 20, .07)", accent: "#A0452B", accentSoft: "#EFDCCB", dark: false },
  护眼: { bg: "#d7e6cf", fg: "#243024", fg2: "#3F4E43", muted: "#6E7D71", line: "#C2D4BB", lineStrong: "#B7C8B1", chrome: "#CADBC2", hover: "rgba(30, 60, 35, .07)", accent: "#2E6B4A", accentSoft: "#C6DCC6", dark: false },
  夜读: { bg: "#1b1c1e", fg: "#e4e4e4", fg2: "#B3B8C3", muted: "#80868F", line: "#2C2E33", lineStrong: "#3A3D44", chrome: "#232428", hover: "rgba(255, 255, 255, .06)", accent: "#D9A55B", accentSoft: "rgba(217, 165, 91, .14)", dark: true },
  纯黑: { bg: "#000000", fg: "#d0d0d0", fg2: "#B8B8BE", muted: "#7A7A82", line: "#1E1E22", lineStrong: "#2C2C32", chrome: "#0D0D0F", hover: "rgba(255, 255, 255, .06)", accent: "#D9A55B", accentSoft: "rgba(217, 165, 91, .14)", dark: true },
};

export const LEADING = { 紧凑: "1.5", 标准: "1.8", 宽松: "2.2" } as const;

/**
 * 很多安卓手机只自带一套中文黑体，没有宋体、楷体，所以这两种字体打包在安装包里（只含 GB2312 的常用字，
 * 各约 1.6MB，见 src/mobile/fonts）。不在字表里的字落到系统字体。
 */
export const FONT = {
  书籍自带: "",
  宋体: '"Spark Serif", "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", serif',
  楷体: '"Spark Kai", "LXGW WenKai", "Kaiti SC", "KaiTi", serif',
} as const;

export type ReaderFont = keyof typeof FONT;

export function isReaderFont(value: unknown): value is ReaderFont {
  return typeof value === "string" && value in FONT;
}

/** 打包的字体文件地址（绝对地址：书页在 blob: 的 iframe 里，相对地址找不到） */
export interface FontFiles {
  serif: string;
  kai: string;
}

function fontFaces(files: FontFiles): string {
  return [
    `@font-face { font-family: "Spark Serif"; src: url("${files.serif}") format("woff2"); font-display: block; }`,
    `@font-face { font-family: "Spark Kai"; src: url("${files.kai}") format("woff2"); font-display: block; }`,
  ].join("\n");
}

/**
 * 书自带的样式常给段落写死行距和字体，只改 body 不起作用，所以正文元素都带 !important。
 * 底色写在 html 和 body 上，阅读器四周的留白取的是这个颜色。
 */
export function readerCss(o: { palette: ReaderPalette; size: number; leading: keyof typeof LEADING; font: ReaderFont; files?: FontFiles }): string {
  const { bg, fg, accent } = o.palette;
  const text = "p, div, li, blockquote, dd, dt, td, th, span, a, em, strong, i, b, h1, h2, h3, h4, h5, h6";
  const family = FONT[o.font];
  return [
    o.files && family ? fontFaces(o.files) : "",
    `html, body { background: ${bg} !important; color: ${fg} !important; }`,
    `body { font-size: ${o.size}px !important; line-height: ${LEADING[o.leading]} !important; }`,
    `${text} { line-height: ${LEADING[o.leading]} !important; color: inherit !important; background-color: transparent !important; }`,
    `p, li, blockquote { font-size: 1em !important; }`,
    family ? `body, ${text} { font-family: ${family} !important; }` : "",
    `a:any-link { color: ${accent} !important; }`,
    `::selection { background: ${accent}55; }`,
    `img, svg { background: transparent !important; }`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** 目录缩进最多两级，再深在手机上就挤得放不下了 */
export function tocDepth(depth: number): number {
  return Math.min(Math.max(depth, 0), 2);
}
