import { editorViewCtx, type Editor } from "@milkdown/kit/core";
import { $inputRule, $nodeSchema, $prose, $remark } from "@milkdown/kit/utils";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { Plugin, PluginKey, type EditorState } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import type { Node as PmNode } from "@milkdown/kit/prose/model";
import { linkDisplay } from "../lib/links";

/**
 * 双向链接 `[[目标]]`、`[[目标|显示文字]]`、`[[目标#标题]]`。
 * Milkdown 默认会把 `[[` 转义成 `\[\[`，所以解析时转成专门的节点，保存时原样写回。
 */

export interface WikiParts {
  target: string;
  heading: string | null;
  alias: string | null;
}

export function parseWiki(value: string): WikiParts {
  const [left, ...aliasParts] = value.split("|");
  const alias = aliasParts.length ? aliasParts.join("|").trim() : null;
  const hash = left.indexOf("#");
  const target = (hash >= 0 ? left.slice(0, hash) : left).trim();
  const heading = hash >= 0 ? left.slice(hash + 1).trim() || null : null;
  return { target, heading, alias: alias || null };
}

export function wikiLabel(value: string): string {
  const { target, heading, alias } = parseWiki(value);
  if (alias) return alias;
  const name = linkDisplay(target.split("/").pop() || target).label;
  return heading ? (name ? `${name} › ${heading}` : heading) : name;
}

/** 链接到思维导图 / 流程图时的类型，用于显示图标 */
export function wikiKind(value: string): "flow" | "mind" | null {
  return linkDisplay(parseWiki(value).target).kind;
}

const WIKI_RE = /\[\[([^[\]\n]+?)\]\]/g;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** 把 mdast 文本节点里的 `[[...]]` 拆成 wikiLink 节点（代码中的不受影响，它们不是 text 节点） */
export function splitWikiText(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(WIKI_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ type: "text", value: value.slice(last, i) });
    out.push({ type: "wikiLink", value: m[1] });
    last = i + m[0].length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

const remarkWiki = $remark("ttnote-wikilink", () => () => (tree: unknown) => {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && child.value?.includes("[[")) return splitWikiText(child.value);
      walk(child);
      return [child];
    });
  };
  walk(tree as MdNode);
});

export const wikiSchema = $nodeSchema("wikilink", () => ({
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  attrs: { value: { default: "", validate: "string" } },
  parseDOM: [
    {
      tag: "span[data-wikilink]",
      getAttrs: (dom) => ({ value: (dom as HTMLElement).dataset.wikilink ?? "" }),
    },
  ],
  toDOM: (node) => [
    "span",
    {
      class: wikiKind(node.attrs.value as string) ? `wikilink wikilink-${wikiKind(node.attrs.value as string)}` : "wikilink",
      "data-wikilink": node.attrs.value,
      title: `[[${node.attrs.value}]]`,
    },
    wikiLabel(node.attrs.value as string),
  ],
  parseMarkdown: {
    match: (node) => node.type === "wikiLink",
    runner: (state, node, type) => {
      state.addNode(type, { value: String(node.value ?? "") });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "wikilink",
    runner: (state, node) => {
      state.addNode("wikiLink", undefined, node.attrs.value as string);
    },
  },
}));

/** 输入完 `]]` 时把 `[[...]]` 转成链接节点 */
const wikiInputRule = $inputRule((ctx) =>
  new InputRule(/\[\[([^[\]\n]+)\]\]$/, (state, match, start, end) =>
    state.tr.replaceWith(start, end, wikiSchema.type(ctx).create({ value: match[1].trim() })),
  ),
);

/* ---------- 补全 ---------- */

export interface LinkCandidate {
  /** 列表显示的名称 */
  label: string;
  /** 所在文件夹，用于区分同名笔记 */
  detail: string;
  /** 写入 [[ ]] 的内容 */
  value: string;
  /** 笔记库相对路径，用于去掉标题匹配和正文匹配中重复的笔记 */
  path?: string;
  /** 正文匹配时的片段 */
  snippet?: { text: string; hit: boolean }[];
}

export interface WikiHost {
  candidates: (query: string) => LinkCandidate[];
  /** 按正文搜索笔记，最多返回 limit 条 */
  search?: (query: string, limit: number) => Promise<LinkCandidate[]>;
  open: (value: string) => void;
}

/** 列表最多显示的条数（标题匹配与正文匹配合计） */
export const SUGGEST_LIMIT = 200;
const CONTENT_LIMIT = 50;
/** 搜索索引按两个字切词，少于两个字时不搜正文 */
const CONTENT_MIN_CHARS = 2;
const CONTENT_DELAY = 150;

interface Pending {
  from: number;
  to: number;
  query: string;
}

/** 光标前是 `[[查询词` 时返回其范围 */
function pendingAt(state: EditorState): Pending | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\uFFFC");
  const m = /\[\[([^[\]|#\n\uFFFC]*)$/.exec(before);
  if (!m) return null;
  const from = $from.pos - m[0].length;
  return { from, to: $from.pos, query: m[1] };
}

function textEl(tag: string, className: string, text: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

class Suggest {
  el: HTMLElement;
  titleItems: LinkCandidate[] = [];
  /** 标题匹配超过上限，需要继续输入缩小范围 */
  titleMore = false;
  contentItems: LinkCandidate[] = [];
  contentError: string | null = null;
  index = 0;
  pending: Pending | null = null;
  rows: HTMLElement[] = [];
  searchTimer = 0;
  searchSeq = 0;

  constructor(private view: EditorView, private host: WikiHost) {
    this.el = document.createElement("div");
    this.el.className = "menu wiki-suggest";
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.append(this.el);
    this.hide();
  }

  get items(): LinkCandidate[] {
    return [...this.titleItems, ...this.contentItems];
  }

  update(view: EditorView) {
    this.view = view;
    const p = pendingAt(view.state);
    if (!p || !view.hasFocus()) return this.hide();
    const changed = !this.pending || this.pending.query !== p.query;
    this.pending = p;
    if (changed) {
      const all = this.host.candidates(p.query);
      this.titleItems = all.slice(0, SUGGEST_LIMIT);
      this.titleMore = all.length > SUGGEST_LIMIT;
      this.contentItems = [];
      this.contentError = null;
      this.index = Math.min(this.index, Math.max(this.titleItems.length - 1, 0));
      this.render();
      this.scheduleSearch(p.query);
    }
    const at = view.coordsAtPos(p.from);
    this.el.style.left = `${Math.min(at.left, window.innerWidth - 300)}px`;
    this.el.style.top = `${at.bottom + 4}px`;
    this.el.style.display = "block";
  }

  scheduleSearch(query: string) {
    clearTimeout(this.searchTimer);
    const seq = ++this.searchSeq;
    const room = Math.min(CONTENT_LIMIT, SUGGEST_LIMIT - this.titleItems.length);
    const search = this.host.search;
    if (!search || room <= 0 || [...query.trim()].length < CONTENT_MIN_CHARS) return;
    this.searchTimer = window.setTimeout(async () => {
      let hits: LinkCandidate[];
      try {
        // 多取一些：排在前面的往往是标题已经匹配过的笔记
        hits = await search(query, room + this.titleItems.length);
      } catch (e) {
        if (seq !== this.searchSeq) return;
        this.contentError = `正文搜索失败：${e instanceof Error ? e.message : String(e)}`;
        this.render();
        return;
      }
      if (seq !== this.searchSeq || this.pending?.query !== query) return;
      const seen = new Set(this.titleItems.map((t) => t.path ?? t.value));
      this.contentItems = hits.filter((h) => !seen.has(h.path ?? h.value)).slice(0, room);
      this.render();
    }, CONTENT_DELAY);
  }

  row(item: LinkCandidate, i: number): HTMLElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "menu-item" + (i === this.index ? " is-open" : "");
    const line = [textEl("span", "label", item.label), textEl("span", "hint", item.detail)];
    if (item.snippet) {
      row.classList.add("wiki-hit");
      const head = document.createElement("span");
      head.className = "wiki-hit-line";
      head.append(...line);
      const snip = document.createElement("span");
      snip.className = "wiki-snip";
      for (const s of item.snippet) snip.append(s.hit ? textEl("mark", "", s.text) : document.createTextNode(s.text));
      row.append(head, snip);
    } else {
      row.append(...line);
    }
    row.addEventListener("click", () => this.choose(i));
    return row;
  }

  render() {
    this.el.replaceChildren();
    this.rows = [];
    if (!this.items.length && !this.contentError) {
      this.el.append(textEl("div", "wiki-suggest-empty", this.pending?.query ? "没有匹配的笔记，输入 ]] 创建链接" : "输入笔记名"));
      return;
    }
    this.titleItems.forEach((item, i) => this.rows.push(this.row(item, i)));
    this.el.append(...this.rows);
    if (this.contentItems.length || this.contentError) {
      this.el.append(textEl("div", "menu-title", "正文匹配"));
      if (this.contentError) this.el.append(textEl("div", "wiki-suggest-empty", this.contentError));
      const base = this.titleItems.length;
      const content = this.contentItems.map((item, i) => this.row(item, base + i));
      this.rows.push(...content);
      this.el.append(...content);
    }
    if (this.titleMore) this.el.append(textEl("div", "wiki-suggest-empty", "继续输入以缩小范围"));
  }

  get visible() {
    return this.el.style.display !== "none";
  }

  hide() {
    this.el.style.display = "none";
    this.pending = null;
    this.index = 0;
    clearTimeout(this.searchTimer);
    this.searchSeq++;
  }

  move(delta: number) {
    const n = this.rows.length;
    if (!n) return;
    this.rows[this.index]?.classList.remove("is-open");
    this.index = (this.index + delta + n) % n;
    const row = this.rows[this.index];
    row.classList.add("is-open");
    row.scrollIntoView({ block: "nearest" });
  }

  choose(i = this.index) {
    const item = this.items[i];
    const p = this.pending;
    if (!item || !p) return;
    const { state } = this.view;
    const node = state.schema.nodes.wikilink.create({ value: item.value });
    // 如果光标后紧跟着自动补上的 ]]，一并替换
    const after = state.doc.textBetween(p.to, Math.min(p.to + 2, state.selection.$from.end()));
    const to = after === "]]" ? p.to + 2 : p.to;
    this.view.dispatch(state.tr.replaceWith(p.from, to, node).scrollIntoView());
    this.hide();
    this.view.focus();
  }

  destroy() {
    this.hide();
    this.el.remove();
  }
}

function suggestPlugin(host: WikiHost) {
  let suggest: Suggest | null = null;
  return $prose(() => new Plugin({
    key: new PluginKey("ttnote-wiki-suggest"),
    view: (view) => {
      suggest = new Suggest(view, host);
      return { update: (v) => suggest?.update(v), destroy: () => suggest?.destroy() };
    },
    props: {
      handleKeyDown: (_view, e) => {
        if (!suggest?.visible) return false;
        if (e.key === "ArrowDown") suggest.move(1);
        else if (e.key === "ArrowUp") suggest.move(-1);
        else if ((e.key === "Enter" || e.key === "Tab") && suggest.items.length) suggest.choose();
        else if (e.key === "Escape") suggest.hide();
        else return false;
        e.preventDefault();
        return true;
      },
      handleDOMEvents: { blur: () => (suggest?.hide(), false) },
    },
  }));
}

/** 补全弹窗打开时，这些键交给补全处理；供外层的按键映射先行判断 */
export function suggestHandlesKey(state: EditorState, e: KeyboardEvent): boolean {
  return !!pendingAt(state) && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key);
}

/* ---------- 正文 #标签 高亮 ---------- */

/** 与 Rust 端抽取规则一致：`#` 前是行首或空白，标签不能全是数字 */
export const TAG_RE = /(^|\s)#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

function tagDecorations(doc: PmNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    node.forEach((child, offset) => {
      if (!child.isText || child.marks.some((m) => m.type.spec.code)) return;
      const text = child.text ?? "";
      for (const m of text.matchAll(TAG_RE)) {
        const start = pos + 1 + offset + (m.index ?? 0) + m[1].length;
        decos.push(Decoration.inline(start, start + 1 + m[2].length, { class: "tag-inline" }));
      }
    });
    return false;
  });
  return DecorationSet.create(doc, decos);
}

const tagHighlight = $prose(() => new Plugin({
  state: {
    init: (_, { doc }) => tagDecorations(doc),
    apply: (tr, old) => (tr.docChanged ? tagDecorations(tr.doc) : old),
  },
  props: { decorations(state) { return this.getState(state); } },
}));

/* ---------- 组装 ---------- */

interface SafeInfo {
  before: string;
  after: string;
}

interface SafeState {
  safe: (value: string, info: SafeInfo) => string;
}

/**
 * remark-stringify 会把行首的 `#` 一律转义成 `\#`，行首的 `#标签` 因此不再被识别为标签。
 * `#` 后紧跟非空白字符时不可能是 ATX 标题，去掉这个转义；成对的 `\\` 是用户输入的反斜杠，保持不动。
 */
export function unescapeTagHash(md: string): string {
  return md.replace(/(^|[^\\])((?:\\\\)*)\\#(?=[\p{L}\p{N}_\-/])/gu, "$1$2#");
}

/** remark-stringify 的处理器：原样输出，不做转义 */
export const wikiStringifyHandlers = {
  wikiLink: (node: { value?: string }) => `[[${node.value ?? ""}]]`,
  text: (node: { value?: string }, _parent: unknown, state: SafeState, info: SafeInfo) =>
    unescapeTagHash(state.safe(node.value ?? "", info)),
};

export function wikiPlugins(host?: WikiHost) {
  const list = [remarkWiki, wikiSchema, wikiInputRule, tagHighlight].flat();
  return host ? [...list, suggestPlugin(host)].flat() : list;
}

/** 点击链接节点时跳转 */
export function wikiClick(host: WikiHost | undefined) {
  return (_view: EditorView, _pos: number, node: PmNode): boolean => {
    if (!host || node.type.name !== "wikilink") return false;
    host.open(node.attrs.value as string);
    return true;
  };
}

/** 工具栏“双向链接”：在光标处输入 [[ 并弹出补全 */
export function startWikiLink(editor: Editor): boolean {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.insertText("[["));
    view.focus();
    return true;
  });
}
