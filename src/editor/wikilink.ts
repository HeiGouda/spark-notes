import { editorViewCtx, type Editor } from "@milkdown/kit/core";
import { $inputRule, $nodeSchema, $prose, $remark } from "@milkdown/kit/utils";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { Plugin, PluginKey, type EditorState } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import type { Node as PmNode } from "@milkdown/kit/prose/model";

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
  const name = target.split("/").pop() || target;
  return heading ? (name ? `${name} › ${heading}` : heading) : name;
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
    { class: "wikilink", "data-wikilink": node.attrs.value, title: `[[${node.attrs.value}]]` },
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
}

export interface WikiHost {
  candidates: (query: string) => LinkCandidate[];
  open: (value: string) => void;
}

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

class Suggest {
  el: HTMLElement;
  items: LinkCandidate[] = [];
  index = 0;
  pending: Pending | null = null;

  constructor(private view: EditorView, private host: WikiHost) {
    this.el = document.createElement("div");
    this.el.className = "menu wiki-suggest";
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.append(this.el);
    this.hide();
  }

  update(view: EditorView) {
    this.view = view;
    const p = pendingAt(view.state);
    if (!p || !view.hasFocus()) return this.hide();
    this.pending = p;
    this.items = this.host.candidates(p.query).slice(0, 12);
    this.index = Math.min(this.index, Math.max(this.items.length - 1, 0));
    this.render();
    const at = view.coordsAtPos(p.from);
    this.el.style.left = `${Math.min(at.left, window.innerWidth - 300)}px`;
    this.el.style.top = `${at.bottom + 4}px`;
    this.el.style.display = "block";
  }

  render() {
    this.el.replaceChildren();
    if (!this.items.length) {
      const empty = document.createElement("div");
      empty.className = "wiki-suggest-empty";
      empty.textContent = this.pending?.query ? "没有匹配的笔记，输入 ]] 创建链接" : "输入笔记名";
      this.el.append(empty);
      return;
    }
    this.items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "menu-item" + (i === this.index ? " is-open" : "");
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = item.label;
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = item.detail;
      row.append(label, hint);
      row.addEventListener("click", () => this.choose(i));
      this.el.append(row);
    });
  }

  get visible() {
    return this.el.style.display !== "none";
  }

  hide() {
    this.el.style.display = "none";
    this.pending = null;
    this.index = 0;
  }

  move(delta: number) {
    if (!this.items.length) return;
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.render();
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
