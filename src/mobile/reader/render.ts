import MarkdownIt, { type RendererRule, type StateCore, type StateInline, type Token } from "markdown-it";
import { refractor } from "refractor";
import { dirOf } from "../../lib/api";
import { parseMeta, splitFrontMatter } from "../../lib/frontmatter";
import { resolveLink } from "../../lib/links";
import { inlineTags } from "../../lib/tags";

/** 手机端只读渲染：不渲染笔记里的 HTML；链接都不带 href，由阅读页接管点击，WebView 不会被带走 */

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export interface Rendered {
  html: string;
  headings: Heading[];
  tags: string[];
}

export interface RenderOptions {
  /** 当前笔记，笔记库相对路径 */
  path: string;
  /** 笔记库里所有笔记的相对路径，用来解析双向链接 */
  notes: string[];
  /** 笔记库相对路径 → 可以显示的图片地址 */
  resolveAsset: (rel: string) => string;
}

interface Env {
  opts: RenderOptions;
  headings: Heading[];
}

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function hastToHtml(nodes: HastNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return esc(n.value ?? "");
      if (n.type !== "element") return "";
      const cls = n.properties?.className?.join(" ");
      return `<span${cls ? ` class="${esc(cls)}"` : ""}>${hastToHtml(n.children ?? [])}</span>`;
    })
    .join("");
}

function normalizeRel(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** 笔记里的相对地址 → 笔记库相对路径；网址等带协议的地址返回 null */
function vaultPath(src: string, notePath: string): string | null {
  if (!src || HAS_SCHEME.test(src) || src.startsWith("//")) return null;
  let decoded = src;
  try {
    decoded = decodeURI(src);
  } catch {
    // 不是合法的 URI 编码时按原文处理
  }
  const dir = dirOf(notePath);
  return normalizeRel(dir ? `${dir}/${decoded}` : decoded);
}

function parseWiki(value: string) {
  const [left, ...aliasParts] = value.split("|");
  const alias = aliasParts.join("|").trim() || null;
  const hash = left.indexOf("#");
  const target = (hash >= 0 ? left.slice(0, hash) : left).trim();
  const heading = hash >= 0 ? left.slice(hash + 1).trim() || null : null;
  return { target, heading, alias };
}

function wikiLabel(target: string, heading: string | null, alias: string | null): string {
  if (alias) return alias;
  const name = target.split("/").pop() || target;
  return heading ? (name ? `${name} › ${heading}` : heading) : name;
}

/** `[[目标]]`、`[[目标|显示文字]]`、`[[目标#标题]]` */
function wikiRule(state: StateInline, silent: boolean): boolean {
  const { src, pos } = state;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner.trim() || /[[\]\n]/.test(inner)) return false;
  if (!silent) state.push("wikilink", "", 0).content = inner;
  state.pos = end + 2;
  return true;
}

const renderWiki: RendererRule = (tokens, idx, _o, env: Env) => {
  const { target, heading, alias } = parseWiki(tokens[idx].content);
  const label = esc(wikiLabel(target, heading, alias));
  const { path, notes } = env.opts;
  const found = target ? resolveLink(target, path, notes) : path;
  if (!found) return `<a class="wl miss" data-missing="${esc(target)}">${label}</a>`;
  return `<a class="wl" data-note="${esc(found)}"${heading ? ` data-heading="${esc(heading)}"` : ""}>${label}</a>`;
};

const EXTERNAL = /^(https?|mailto):/i;

/** 非法的百分号编码保持原文，避免整篇笔记渲染失败 */
function decodeHash(hash: string): string {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

/** 与双向链接同一套后缀：`.flow` / `.mind` 指向图，`.md` 指向笔记 */
function findNote(rel: string, from: string, notes: string[]): string | null {
  return resolveLink(rel, from, notes);
}

const renderLinkOpen: RendererRule = (tokens, idx, options, env: Env, self) => {
  const token = tokens[idx];
  const href = token.attrGet("href") ?? "";
  token.attrs = (token.attrs ?? []).filter(([name]) => name !== "href");
  if (EXTERNAL.test(href)) {
    token.attrSet("data-external", href);
  } else {
    const [file, hash] = href.split("#", 2);
    const rel = file ? vaultPath(file, env.opts.path) : env.opts.path;
    const note = rel ? findNote(rel, env.opts.path, env.opts.notes) : null;
    if (note) {
      token.attrSet("data-note", note);
      if (hash) token.attrSet("data-heading", decodeHash(hash));
    } else {
      token.attrJoin("class", "miss");
    }
  }
  return self.renderToken(tokens, idx, options);
};

function imageRule(fallback: RendererRule): RendererRule {
  return (tokens, idx, options, env: Env, self) => {
    const token = tokens[idx];
    const rel = vaultPath(token.attrGet("src") ?? "", env.opts.path);
    if (rel) token.attrSet("src", env.opts.resolveAsset(rel));
    token.attrSet("loading", "lazy");
    return fallback(tokens, idx, options, env, self);
  };
}

const TAG = /(^|\s)#([\p{L}\p{N}_\-/]+)/gu;

/** 把文字里的 #标签 拆成单独的节点；规则与 lib/tags.ts 一致 */
function splitTags(state: StateCore, text: Token): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of text.content.matchAll(TAG)) {
    const tag = m[2].replace(/\/+$/, "");
    if (!tag || !/\D/.test(tag)) continue;
    const start = (m.index ?? 0) + m[1].length;
    if (start > last) out.push(Object.assign(new state.Token("text", "", 0), { content: text.content.slice(last, start) }));
    out.push(Object.assign(new state.Token("tag", "", 0), { content: tag }));
    last = start + 1 + tag.length;
  }
  if (!out.length) return [text];
  if (last < text.content.length) out.push(Object.assign(new state.Token("text", "", 0), { content: text.content.slice(last) }));
  return out;
}

function plainText(children: Token[]): string {
  return children
    .map((t) => {
      if (t.type === "text" || t.type === "code_inline") return t.content;
      if (t.type === "tag") return `#${t.content}`;
      if (t.type === "softbreak" || t.type === "hardbreak") return " ";
      if (t.type === "wikilink") {
        const { target, heading, alias } = parseWiki(t.content);
        return wikiLabel(target, heading, alias);
      }
      return "";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

const TASK = /^\[([ xX])\][ \t]+/;

function decorate(state: StateCore) {
  const env = state.env as Env;
  const { tokens } = state;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "inline" || !token.children) continue;
    token.children = token.children.flatMap((c) => (c.type === "text" ? splitTags(state, c) : [c]));
    const first = token.children[0];
    if (tokens[i - 1]?.type === "paragraph_open" && tokens[i - 2]?.type === "list_item_open" && first?.type === "text") {
      const m = TASK.exec(first.content);
      if (m) {
        first.content = first.content.slice(m[0].length);
        const box = new state.Token("task", "", 0);
        box.meta = { checked: m[1] !== " " };
        token.children.unshift(box);
        tokens[i - 2].attrJoin("class", "task");
      }
    }
    const open = tokens[i - 1];
    if (open?.type === "heading_open") {
      const id = `h-${env.headings.length}`;
      open.attrSet("id", id);
      env.headings.push({ level: Number(open.tag.slice(1)), text: plainText(token.children), id });
    }
  }
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  highlight(code, lang) {
    const name = lang.trim().toLowerCase();
    let body = esc(code);
    if (name && refractor.registered(name)) {
      try {
        body = hastToHtml(refractor.highlight(code, name).children as HastNode[]);
      } catch {
        // 高亮失败时按纯文本显示
      }
    }
    const label = name ? `<span class="md-lang">${esc(name)}</span>` : "";
    return `<pre class="md-code">${label}<code>${body}</code></pre>`;
  },
});

md.inline.ruler.before("link", "wikilink", wikiRule);
md.core.ruler.after("text_join", "spark_decorate", decorate);
md.renderer.rules.wikilink = renderWiki;
md.renderer.rules.tag = (tokens, idx) => `<span class="tag">#${esc(tokens[idx].content)}</span>`;
md.renderer.rules.task = (tokens, idx) =>
  `<input type="checkbox" disabled${tokens[idx].meta?.checked ? " checked" : ""}> `;
md.renderer.rules.link_open = renderLinkOpen;
md.renderer.rules.image = imageRule(md.renderer.rules.image!);

export function renderNote(source: string, opts: RenderOptions): Rendered {
  const { frontMatter, body } = splitFrontMatter(source);
  const env: Env = { opts, headings: [] };
  const html = md.render(body, env);
  const tags = [...new Set([...parseMeta(frontMatter).tags, ...inlineTags(body)])];
  return { html, headings: env.headings, tags };
}
