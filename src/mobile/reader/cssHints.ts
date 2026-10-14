/**
 * 原生排版不跑 CSS，这里只从书自带的样式表里读几样会影响版式的东西：
 * 对齐、字号（相对正文的倍数）、粗体。规则按特异度排序后依次覆盖，行内 style 最后。
 */

export interface StyleHint {
  align?: "left" | "center" | "right" | "justify";
  size?: number;
  bold?: boolean;
}

export type StyleOf = (el: Element) => StyleHint | null;

interface Rule {
  selector: string;
  weight: number;
  order: number;
  hint: StyleHint;
}

const SIZE_WORDS: Record<string, number> = {
  "xx-small": 0.6,
  "x-small": 0.75,
  small: 0.89,
  medium: 1,
  large: 1.2,
  "x-large": 1.5,
  "xx-large": 2,
  "xxx-large": 3,
  smaller: 0.83,
  larger: 1.2,
};

/** 字号写法换成相对正文的倍数。px、pt 按正文 16px 估算 */
export function sizeOf(value: string): number | undefined {
  const v = value.trim().toLowerCase().replace(/\s*!important$/, "");
  if (v in SIZE_WORDS) return SIZE_WORDS[v];
  const m = /^(-?[\d.]+)(em|rem|%|px|pt)?$/.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  switch (m[2]) {
    case "%":
      return n / 100;
    case "px":
      return n / 16;
    case "pt":
      return n / 12;
    case undefined:
      return undefined;
    default:
      return n;
  }
}

/** 一段声明里我们关心的几项 */
export function hintOf(decls: string): StyleHint | null {
  const hint: StyleHint = {};
  for (const part of decls.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim().toLowerCase().replace(/\s*!important$/, "");
    if (name === "text-align") {
      if (value === "center" || value === "-webkit-center") hint.align = "center";
      else if (value === "right" || value === "end") hint.align = "right";
      else if (value === "left" || value === "start") hint.align = "left";
      else if (value === "justify") hint.align = "justify";
    } else if (name === "font-size") {
      const size = sizeOf(value);
      if (size) hint.size = size;
    } else if (name === "font-weight") {
      if (value === "bold" || value === "bolder" || Number(value) >= 600) hint.bold = true;
      else if (value === "normal" || value === "lighter" || (Number(value) > 0 && Number(value) < 600)) hint.bold = false;
    } else if (name === "font") {
      if (/\bbold\b|\b[6-9]00\b/.test(value)) hint.bold = true;
      const size = /(?:^|\s)([\d.]+(?:em|rem|%|px|pt)|(?:xx?x?-)?(?:large|small)|medium)(?:\/|\s|$)/.exec(value);
      const n = size ? sizeOf(size[1]!) : undefined;
      if (n) hint.size = n;
    }
  }
  return hint.align || hint.size || hint.bold != null ? hint : null;
}

/** id 记 100，类、属性、伪类记 10，标签记 1。只用来排先后，够用就行 */
function weightOf(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const tags = (selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, " ").match(/[a-z][\w-]*/gi) ?? []).length;
  return ids * 100 + classes * 10 + tags;
}

/** 解析样式表，只留下设了对齐、字号或粗细的规则。@media、@font-face 这类整块跳过 */
export function parseCss(text: string): Rule[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let i = 0;
  let order = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const head = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    const body = src.slice(open + 1, j - 1);
    i = j;
    if (!head || head.startsWith("@")) continue;
    const hint = hintOf(body);
    if (!hint) continue;
    for (const raw of head.split(",")) {
      const selector = raw.trim();
      if (!selector || /::?(before|after|first-line|first-letter|hover|focus|active|visited)/i.test(selector)) continue;
      rules.push({ selector, weight: weightOf(selector), order: order++, hint });
    }
  }
  return rules;
}

/** 按样式表给元素找版式提示。同一元素只算一次 */
export function styleResolver(cssTexts: string[]): StyleOf {
  const rules = cssTexts.flatMap(parseCss).sort((a, b) => a.weight - b.weight || a.order - b.order);
  const cache = new WeakMap<Element, StyleHint | null>();
  return (el: Element) => {
    if (cache.has(el)) return cache.get(el) ?? null;
    const hint: StyleHint = {};
    for (const rule of rules) {
      let hit = false;
      try {
        hit = el.matches(rule.selector);
      } catch {
        hit = false;
      }
      if (hit) Object.assign(hint, rule.hint);
    }
    const inline = el.getAttribute("style");
    if (inline) Object.assign(hint, hintOf(inline) ?? {});
    const out = hint.align || hint.size || hint.bold != null ? hint : null;
    cache.set(el, out);
    return out;
  };
}
