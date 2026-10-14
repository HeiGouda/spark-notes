import { hintOf, type StyleHint, type StyleOf } from "./cssHints";

/** 一段字。b 粗体，i 斜体；im 是夹在字里的小图（行内图标、生僻字图），这时 t 为空，不占字符 */
export interface NativeRun {
  t: string;
  b?: boolean;
  i?: boolean;
  im?: string;
}

/**
 * 交给原生页的一块：一段文字，或单独占位的图。
 * h 是标题级别 1–6；a 是对齐（c 居中，r 右对齐），不写就是两端对齐加首行缩进；pre 为真时不缩进。
 * img 是书里写的原始地址（mobi 的 recindex 写成 recindex:N），由 withImages 换成能取的图
 */
export type NativeBlock = { h?: number; a?: "c" | "r"; pre?: boolean; runs: NativeRun[] } | { img: string };

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "HEAD", "TITLE"]);
const BLOCK = new Set(["P", "LI", "BLOCKQUOTE", "PRE", "DIV", "SECTION", "ARTICLE", "FIGCAPTION", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "CENTER", "DT", "DD", "HEADER", "FOOTER", "ASIDE", "FIGURE", "TABLE", "UL", "OL", "DL", "HR"]);

/** EPUB、AZW3 按 XHTML 解析，标签名是小写；HTML 文档里才是大写。统一成大写再比 */
function tagOf(el: Element): string {
  return (el.localName || el.tagName).toUpperCase();
}

function blockOf(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const tag = tagOf(p);
    if (tag === "BODY") return null;
    if (BLOCK.has(tag)) return p;
  }
  return null;
}

const textyBlocks = new WeakMap<Element, boolean>();

/**
 * 和字排在同一段里的图（行内图标、生僻字图）。它跟着字走：不单独成块，也不断段，不占字符。
 * 段落里没有字时，图才单独占一块
 */
export function isInlineImage(el: Element): boolean {
  if (tagOf(el) !== "IMG") return false;
  const block = blockOf(el);
  if (!block) return false;
  let texty = textyBlocks.get(block);
  if (texty == null) {
    texty = /\S/.test(block.textContent ?? "");
    textyBlocks.set(block, texty);
  }
  return texty;
}

/** 只是把一张图包起来的 SVG（整页插图、封面常这么写），可以当普通图排 */
export function isImageSvg(svg: Element): boolean {
  let images = 0;
  for (const child of Array.from(svg.children)) {
    const tag = tagOf(child);
    if (tag === "IMAGE") images++;
    else if (tag !== "TITLE" && tag !== "DESC" && tag !== "DEFS" && tag !== "METADATA") return false;
  }
  return images > 0 && !/\S/.test(svg.textContent ?? "");
}

/** 中文书常见的章节标题。一章开头单独一行、又短，就当标题排 */
const CHAPTER_LINE = /^(第[0-9０-９零〇一二三四五六七八九十百千万两]+[章节回部卷集篇幕话]|序[章言幕]?$|序[章言幕]?\s|楔子|引子|前言|后记|尾声|番外|附录|chapter\s*[0-9ivxlc]+|prologue|epilogue)/i;

/** 和浏览器 white-space: normal 一样：换行、空行、连续空白收成一个空格。br 另计。 */
function foldText(text: string, dropLeading: boolean): string {
  let next = text.replace(/[ \t\n\r\f]+/g, " ");
  if (dropLeading) next = next.replace(/^ /, "");
  return next;
}

/** 和 foldText 一样收空白，并记下每个输出字符来自原文的哪个下标 */
function foldMapped(text: string, dropLeading: boolean): { text: string; map: number[] } {
  let i = 0;
  if (dropLeading) {
    while (i < text.length && /[ \t\n\r\f]/.test(text[i] ?? "")) i++;
  }
  let out = "";
  const map: number[] = [];
  while (i < text.length) {
    if (/[ \t\n\r\f]/.test(text[i] ?? "")) {
      const at = i;
      while (i < text.length && /[ \t\n\r\f]/.test(text[i] ?? "")) i++;
      out += " ";
      map.push(at);
      continue;
    }
    out += text[i];
    map.push(i);
    i++;
  }
  return { text: out, map };
}

function preservesSpace(el: Element): boolean {
  if (tagOf(el) === "PRE") return true;
  return /white-space\s*:\s*(pre|pre-wrap|break-spaces)/i.test(el.getAttribute("style") ?? "");
}

function headingLevel(tag: string): number {
  return /^H[1-6]$/.test(tag) ? Number(tag[1]) : 0;
}

/** 书里直接写在标签上的对齐：align 属性、center 标签、行内 text-align */
function ownAlign(el: Element, tag: string, hint: StyleHint | null): StyleHint["align"] {
  if (tag === "CENTER") return "center";
  const attr = (el.getAttribute("align") ?? "").toLowerCase();
  if (attr === "center" || attr === "middle") return "center";
  if (attr === "right") return "right";
  if (attr === "left" || attr === "justify") return attr;
  return hint?.align;
}

/** 字号相对正文的倍数换成标题级别。差不多大的不算标题 */
function levelOfSize(size: number): number {
  if (size >= 1.6) return 1;
  if (size >= 1.35) return 2;
  if (size >= 1.15) return 3;
  return 0;
}

/** 类名、id 像标题的元素（calibre、多看常见的写法） */
function titleClass(el: Element): boolean {
  const name = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`;
  return /(^|[\s_-])(title|heading|head|subtitle|biaoti)(\d*)($|[\s_-])/i.test(name);
}

/**
 * 按阅读顺序抽出段落和图片。图片单独成块，不按 CSS 环绕。
 * 粗体、斜体留在字上；标题级别、居中和右对齐按标签、align 属性和书自带的样式表（styleOf）判断。
 * 只改版式，不增删字，字符偏移和 plainOf、offsetOfAnchor 一致。
 */
export function blocksFrom(doc: Document, styleOf?: StyleOf): NativeBlock[] {
  const out: NativeBlock[] = [];
  let runs: NativeRun[] = [];
  let level = 0;
  let sized = 1;
  let titled = false;
  let align: StyleHint["align"];
  let preBlock = false;
  let dropLeading = true;
  let textBlocks = 0;

  function flush() {
    const next: NativeRun[] = [];
    for (const run of runs) {
      if (!run.t && !run.im) continue;
      const item: NativeRun = { t: run.t };
      if (run.b) item.b = true;
      if (run.i) item.i = true;
      if (run.im) item.im = run.im;
      next.push(item);
    }
    const last = next[next.length - 1];
    if (last && !last.im && !last.t.includes("\n")) last.t = last.t.replace(/ +$/, "");
    if (last && !last.t && !last.im) next.pop();
    if (next.some((run) => run.t.trim())) {
      const text = next.map((run) => run.t).join("").trim();
      const short = text.length <= 40 && !text.includes("\n");
      let h = level;
      if (!h && short && !preBlock) {
        h = levelOfSize(sized);
        if (!h && titled && (align === "center" || next.every((run) => run.b))) h = 3;
        if (!h && textBlocks === 0 && text.length <= 30 && CHAPTER_LINE.test(text)) h = 2;
      }
      const block: NativeBlock = { runs: next };
      if (h) {
        block.h = h;
        for (const run of next) run.b = true;
      }
      if (align === "center") block.a = "c";
      else if (align === "right") block.a = "r";
      if (preBlock) block.pre = true;
      out.push(block);
      textBlocks++;
    }
    runs = [];
    level = 0;
    sized = 1;
    titled = false;
    align = undefined;
    preBlock = false;
    dropLeading = true;
  }

  type Ctx = { bold: boolean; italic: boolean; level: number; pre: boolean; align: StyleHint["align"]; size: number; titled: boolean };

  function pushText(text: string, ctx: Ctx) {
    const t = ctx.pre ? text : foldText(text, dropLeading);
    dropLeading = false;
    if (!t) return;
    if (!runs.length || !runs.some((run) => run.t.trim())) {
      align = ctx.align;
      sized = ctx.size;
      titled = ctx.titled;
    }
    if (ctx.level && (!level || ctx.level < level)) level = ctx.level;
    const item: NativeRun = { t };
    if (ctx.bold) item.b = true;
    if (ctx.italic) item.i = true;
    if (ctx.pre) preBlock = true;
    runs.push(item);
  }

  function walk(node: Node, ctx: Ctx) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? "";
      if (t) pushText(t, ctx);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = tagOf(el);
    if (SKIP.has(tag)) return;
    if (tag === "IMG" || tag === "IMAGE") {
      const src = el.getAttribute("src") ?? el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
      const rec = el.getAttribute("recindex");
      const raw = src || (rec ? `recindex:${rec}` : "");
      if (isInlineImage(el)) {
        if (raw) runs.push({ t: "", im: raw });
        return;
      }
      flush();
      if (raw) out.push({ img: raw });
      return;
    }
    if (tag === "BR") {
      runs.push({ t: "\n" });
      dropLeading = true;
      return;
    }
    const block = BLOCK.has(tag);
    if (block && runs.length) flush();
    if (block) dropLeading = true;
    if (preservesSpace(el)) preBlock = true;
    const inline = el.getAttribute("style");
    const hint = styleOf ? styleOf(el) : inline ? hintOf(inline) : null;
    const own = ownAlign(el, tag, hint);
    const tagLevel = headingLevel(tag);
    const next: Ctx = {
      bold: hint?.bold ?? (ctx.bold || tag === "B" || tag === "STRONG" || tagLevel > 0),
      italic: ctx.italic || tag === "I" || tag === "EM",
      level: ctx.level || tagLevel,
      pre: ctx.pre || preservesSpace(el),
      align: own ?? ctx.align,
      size: hint?.size ? ctx.size * hint.size : ctx.size,
      titled: ctx.titled || (block && titleClass(el)),
    };
    for (const child of el.childNodes) walk(child, next);
    if (block) flush();
  }

  if (doc.body) walk(doc.body, { bold: false, italic: false, level: 0, pre: false, align: undefined, size: 1, titled: false });
  flush();
  return out;
}

/** 图的原始地址换成能取的地址；取不到返回 null，这张图就不放 */
export type ImageResolver = (raw: string) => Promise<string | null> | string | null;

/** 单独成块的图最宽 720 像素；夹在字里的小图只有一个字高，96 像素够了 */
const BLOCK_IMAGE_PX = 720;
const INLINE_IMAGE_PX = 96;

/**
 * 把图缩小转码，避免整章原图塞进原生接口。失败的图丢掉，正文照旧。
 * 同一张图（一章里常有几十个相同的行内图标）只取一次、缩一次
 */
export async function withImages(blocks: NativeBlock[], resolve?: ImageResolver): Promise<NativeBlock[]> {
  const cache = new Map<string, Promise<string | null>>();
  const load = (raw: string, max: number) => {
    const key = `${max}|${raw}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = (async () => {
        if (raw.startsWith("data:") && max === BLOCK_IMAGE_PX) return raw;
        let src: string | null = raw;
        try {
          src = resolve && !raw.startsWith("data:") ? await resolve(raw) : raw;
        } catch {
          src = null;
        }
        return src ? shrinkImage(src, max) : null;
      })();
      cache.set(key, hit);
    }
    return hit;
  };
  const out: NativeBlock[] = [];
  for (const block of blocks) {
    if ("img" in block) {
      const data = await load(block.img, BLOCK_IMAGE_PX);
      if (data) out.push({ img: data });
      continue;
    }
    if (!block.runs.some((run) => run.im)) {
      out.push(block);
      continue;
    }
    const runs: NativeRun[] = [];
    for (const run of block.runs) {
      if (!run.im) {
        runs.push(run);
        continue;
      }
      const data = await load(run.im, INLINE_IMAGE_PX);
      if (data) runs.push({ ...run, im: data });
      else if (run.t) runs.push({ t: run.t, ...(run.b ? { b: true } : {}), ...(run.i ? { i: true } : {}) });
    }
    out.push({ ...block, runs });
  }
  return out;
}

async function shrinkImage(src: string, max = BLOCK_IMAGE_PX): Promise<string | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height, 1));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    // 透明底的图转 JPEG 会变黑底，能用 WebP 就用 WebP
    const webp = canvas.toDataURL("image/webp", 0.8);
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}

function hashOf(href: string): string {
  const filepos = /^filepos:(\d+)$/i.exec(href);
  if (filepos) return `filepos${filepos[1]}`;
  const mark = href.indexOf("#");
  if (mark < 0 || mark >= href.length - 1) return "";
  const raw = href.slice(mark + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function escapeCss(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

/** XHTML 当 XML 解析时 getElementById 经常是空的，再按 id / name 属性找 */
export function findFragment(doc: Document, id: string): Element | null {
  if (!id) return null;
  return doc.getElementById(id) ?? doc.querySelector(`[id="${escapeCss(id)}"]`) ?? doc.querySelector(`[name="${escapeCss(id)}"]`);
}

/**
 * 目录 href 或阅读器锚点在原生正文里的字符位置。
 * 锚点函数对不上时，用地址里的片段再找一次。
 */
export function locateAnchor(doc: Document, href: string, anchor?: (doc: Document) => unknown): number {
  const el = findFragment(doc, hashOf(href));
  const fromEl = el ? offsetOfAnchor(doc, () => el) : 0;
  if (typeof anchor !== "function") return fromEl;
  let frag: unknown = null;
  try {
    frag = anchor(doc);
  } catch {
    return fromEl;
  }
  if (frag == null || typeof frag === "number" || frag === doc.body || frag === doc.documentElement) return fromEl;
  const fromFn = offsetOfAnchor(doc, () => frag);
  if (el && fromFn === 0 && fromEl > 0) return fromEl;
  return fromFn;
}

/**
 * 目录或书签锚点在原生正文字符串里的位置。
 * 计数和 blocksFrom 一致：每段末尾补一个换行，图不占字符。对不上就回到章首。
 */
export function offsetOfAnchor(doc: Document, anchor: (doc: Document) => unknown): number {
  let target: Node | null = null;
  let rawOffset = 0;
  try {
    const frag = anchor(doc);
    if (frag == null || typeof frag === "number") return 0;
    if (frag instanceof Range) {
      target = frag.startContainer;
      rawOffset = frag.startOffset;
    } else if (frag instanceof Node) target = frag;
  } catch {
    return 0;
  }
  if (!target || target === doc.body || target === doc.documentElement) return 0;

  let count = 0;
  let runs: string[] = [];
  let found = -1;
  let dropLeading = true;

  function piece(): string {
    return runs.join("");
  }

  function flush() {
    const text = piece().replace(/ +$/, "");
    if (text.trim()) count += text.endsWith("\n") ? text.length : text.length + 1;
    runs = [];
    dropLeading = true;
  }

  function walk(node: Node, pre: boolean): boolean {
    if (node === target) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = tagOf(node as Element);
        if (BLOCK.has(tag) || ((tag === "IMG" || tag === "IMAGE") && !isInlineImage(node as Element))) flush();
      }
      const raw = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "").slice(0, rawOffset) : "";
      const extra = node.nodeType === Node.TEXT_NODE ? (pre ? raw.length : foldText(raw, dropLeading).length) : 0;
      found = count + piece().length + extra;
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? "";
      const folded = pre ? t : foldText(t, dropLeading);
      dropLeading = false;
      if (folded) runs.push(folded);
      return false;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const el = node as Element;
    const tag = tagOf(el);
    if (SKIP.has(tag)) return false;
    if (tag === "IMG" || tag === "IMAGE") {
      if (!isInlineImage(el)) flush();
      return false;
    }
    if (tag === "BR") {
      runs.push("\n");
      dropLeading = true;
      return false;
    }
    if (BLOCK.has(tag) && runs.length) flush();
    if (BLOCK.has(tag)) dropLeading = true;
    const childPre = pre || preservesSpace(el);
    for (const child of el.childNodes) {
      if (walk(child, childPre)) return true;
    }
    if (BLOCK.has(tag)) flush();
    return false;
  }

  if (doc.body) walk(doc.body, false);
  return found < 0 ? 0 : found;
}

/** 和 offsetOfAnchor 同一套计数，供书内搜索跳到字符偏移 */
export function plainOf(doc: Document): string {
  if (!doc.body) return "";
  let runs: string[] = [];
  let dropLeading = true;
  let out = "";

  function flush() {
    const text = runs.join("").replace(/ +$/, "");
    if (text.trim()) out += text.endsWith("\n") ? text : `${text}\n`;
    runs = [];
    dropLeading = true;
  }

  function walk(node: Node, pre: boolean) {
    if (node.nodeType === Node.TEXT_NODE) {
      const folded = pre ? (node.textContent ?? "") : foldText(node.textContent ?? "", dropLeading);
      dropLeading = false;
      if (folded) runs.push(folded);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = tagOf(el);
    if (SKIP.has(tag)) return;
    if (tag === "IMG" || tag === "IMAGE") {
      if (!isInlineImage(el)) flush();
      return;
    }
    if (tag === "BR") {
      runs.push("\n");
      dropLeading = true;
      return;
    }
    if (BLOCK.has(tag) && runs.length) flush();
    if (BLOCK.has(tag)) dropLeading = true;
    const childPre = pre || preservesSpace(el);
    for (const child of el.childNodes) walk(child, childPre);
    if (BLOCK.has(tag)) flush();
  }

  walk(doc.body, false);
  flush();
  return out;
}

export interface PlainHit {
  offset: number;
  excerpt: string;
}

/**
 * 在一章正文里找词。大小写不敏感，但只在长度不变时折叠，避免偏移错位。
 * folded 是事先转好的小写正文，反复搜同一章时不用每次再转
 */
export function findInPlain(plain: string, query: string, limit = 20, folded = plain.toLowerCase()): PlainHit[] {
  const q = query.trim();
  if (!q || limit <= 0) return [];
  const foldedQ = q.toLowerCase();
  const useFold = folded.length === plain.length && foldedQ.length === q.length;
  const hay = useFold ? folded : plain;
  const needle = useFold ? foldedQ : q;
  const out: PlainHit[] = [];
  let from = 0;
  while (out.length < limit) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    const start = Math.max(0, at - 12);
    const end = Math.min(plain.length, at + needle.length + 18);
    let excerpt = plain.slice(start, end).replace(/\s+/g, " ").trim();
    if (start > 0) excerpt = `…${excerpt}`;
    if (end < plain.length) excerpt += "…";
    out.push({ offset: at, excerpt });
    from = at + Math.max(needle.length, 1);
  }
  return out;
}

type PlainSpot = { node: Node; dom: number; ch: string };

/**
 * 原生正文里的字符偏移还原成文档里的一个位置。
 * 计数和 offsetOfAnchor 相同，用来写回阅读位置，而不是用全书百分比去猜页。
 */
export function rangeAtOffset(doc: Document, offset: number): Range | null {
  if (!doc.body || !Number.isFinite(offset) || offset < 0) return null;
  let count = 0;
  let chars: PlainSpot[] = [];
  let dropLeading = true;
  const found: { spot: PlainSpot | null } = { spot: null };

  function flush() {
    let end = chars.length;
    while (end > 0 && chars[end - 1]?.ch === " ") end--;
    const kept = chars.slice(0, end);
    const text = kept.map((item) => item.ch).join("");
    if (text.trim()) {
      const extra = text.endsWith("\n") ? 0 : 1;
      if (!found.spot && offset < count + text.length) {
        found.spot = kept[offset - count] ?? null;
      } else if (!found.spot && extra === 1 && offset === count + text.length) {
        const last = kept[kept.length - 1];
        if (last?.node.nodeType === Node.TEXT_NODE) found.spot = { node: last.node, dom: last.dom + 1, ch: "" };
      }
      count += text.length + extra;
    }
    chars = [];
    dropLeading = true;
  }

  function pushText(node: Text, text: string, pre: boolean) {
    if (pre) {
      for (let i = 0; i < text.length; i++) chars.push({ node, dom: i, ch: text[i] ?? "" });
      dropLeading = false;
      return;
    }
    const folded = foldMapped(text, dropLeading);
    dropLeading = false;
    for (let i = 0; i < folded.text.length; i++) {
      chars.push({ node, dom: folded.map[i] ?? 0, ch: folded.text[i] ?? "" });
    }
  }

  function walk(node: Node, pre: boolean) {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node as Text, node.textContent ?? "", pre);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = tagOf(el);
    if (SKIP.has(tag)) return;
    if (tag === "IMG" || tag === "IMAGE") {
      if (!isInlineImage(el)) flush();
      return;
    }
    if (tag === "BR") {
      chars.push({ node: el, dom: -1, ch: "\n" });
      dropLeading = true;
      return;
    }
    if (BLOCK.has(tag) && chars.length) flush();
    if (BLOCK.has(tag)) dropLeading = true;
    const childPre = pre || preservesSpace(el);
    for (const child of el.childNodes) walk(child, childPre);
    if (BLOCK.has(tag)) flush();
  }

  walk(doc.body, false);
  flush();
  const hit = found.spot;
  if (!hit) return null;
  const range = doc.createRange();
  if (hit.node.nodeType === Node.TEXT_NODE) {
    const len = hit.node.textContent?.length ?? 0;
    range.setStart(hit.node, Math.min(Math.max(hit.dom, 0), len));
    range.collapse(true);
    return range;
  }
  range.setStartBefore(hit.node);
  range.collapse(true);
  return range;
}

/** 在文档里找第 nth 次出现的句子（空白不计入），用来还原划线的 Range */
export function rangeOfOccurrence(doc: Document, sentence: string, nth: number): Range | null {
  const needle = sentence.replace(/\s+/g, "");
  if (!needle || !doc.body) return null;
  const map: { node: Text; offset: number }[] = [];
  let compact = "";
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i] ?? "")) continue;
      map.push({ node: node as Text, offset: i });
      compact += text[i];
    }
    node = walker.nextNode();
  }
  let from = 0;
  let seen = 0;
  while (from <= compact.length) {
    const at = compact.indexOf(needle, from);
    if (at < 0 || at + needle.length > map.length) return null;
    if (seen === nth) {
      const a = map[at];
      const b = map[at + needle.length - 1];
      if (!a || !b) return null;
      const range = doc.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset + 1);
      return range;
    }
    seen++;
    from = at + Math.max(needle.length, 1);
  }
  return null;
}
