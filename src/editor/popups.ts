import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

/** 浮动格式条与斜杠菜单（原型 M4 浮层 3、4） */
export interface FormatHost {
  /** 执行格式工具（id 同 FORMAT_ACTIONS）或标题级别 `h1`~`h3` */
  run: (actionId: string) => void;
  /** 当前生效的快捷键，用于菜单右侧提示 */
  shortcut: (actionId: string) => string | null;
}

function svgIcon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ico");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function scrollParent(view: EditorView): HTMLElement | null {
  return view.dom.closest(".editor");
}

/* ---------- 浮动格式条 ---------- */

interface BarButton {
  id: string;
  title: string;
  mark: string;
  glyph: () => Node;
}

const glyph = (cls: string, text: string) => () => {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
};

const BAR_BUTTONS: BarButton[] = [
  { id: "strong", title: "加粗", mark: "strong", glyph: glyph("g", "B") },
  { id: "emphasis", title: "斜体", mark: "emphasis", glyph: glyph("g-i", "I") },
  { id: "strike", title: "删除线", mark: "strike_through", glyph: glyph("g g-s", "S") },
  { id: "highlight", title: "高亮", mark: "highlight", glyph: glyph("g g-h", "H") },
  { id: "inlineCode", title: "行内代码", mark: "inlineCode", glyph: () => svgIcon("code") },
  { id: "link", title: "链接", mark: "link", glyph: () => svgIcon("link") },
];

function barVisible(view: EditorView): boolean {
  const sel = view.state.selection;
  if (sel.empty || !(sel instanceof TextSelection) || !view.hasFocus() || !view.editable) return false;
  if (sel.$from.parent.type.spec.code || sel.$to.parent.type.spec.code) return false;
  return view.state.doc.textBetween(sel.from, sel.to).trim().length > 0;
}

class FloatBar {
  el: HTMLElement;
  buttons = new Map<string, HTMLButtonElement>();
  private onScroll = () => this.update(this.view);

  constructor(private view: EditorView, private host: FormatHost) {
    this.el = document.createElement("div");
    this.el.className = "pop floatbar";
    this.el.setAttribute("role", "toolbar");
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    BAR_BUTTONS.forEach((b, i) => {
      if (i === BAR_BUTTONS.length - 1) {
        const sep = document.createElement("span");
        sep.className = "sep";
        this.el.append(sep);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.append(b.glyph());
      btn.addEventListener("click", () => this.host.run(b.id));
      this.buttons.set(b.id, btn);
      this.el.append(btn);
    });
    document.body.append(this.el);
    scrollParent(view)?.addEventListener("scroll", this.onScroll, { passive: true });
    this.hide();
  }

  update(view: EditorView) {
    this.view = view;
    if (!barVisible(view)) return this.hide();
    const { state } = view;
    const { from, to } = state.selection;
    for (const b of BAR_BUTTONS) {
      const type = state.schema.marks[b.mark];
      const btn = this.buttons.get(b.id)!;
      btn.classList.toggle("is-active", !!type && state.doc.rangeHasMark(from, to, type));
      const s = this.host.shortcut(b.id);
      btn.title = s ? `${b.title} (${s})` : b.title;
    }
    this.el.style.display = "flex";
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    const width = this.el.offsetWidth;
    const center = start.top === end.top ? (start.left + end.right) / 2 : start.left + width / 2;
    const left = Math.max(8, Math.min(center - width / 2, window.innerWidth - width - 8));
    const top = start.top - this.el.offsetHeight - 8;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top < 8 ? end.bottom + 8 : top}px`;
  }

  hide() {
    this.el.style.display = "none";
  }

  destroy() {
    scrollParent(this.view)?.removeEventListener("scroll", this.onScroll);
    this.el.remove();
  }
}

export function floatBarPlugin(host: FormatHost) {
  let bar: FloatBar | null = null;
  return $prose(() => new Plugin({
    key: new PluginKey("ttnote-floatbar"),
    view: (view) => {
      bar = new FloatBar(view, host);
      return { update: (v) => bar?.update(v), destroy: () => bar?.destroy() };
    },
    props: {
      handleDOMEvents: {
        blur: () => (bar?.hide(), false),
        focus: (view) => (bar?.update(view), false),
      },
    },
  }));
}

/* ---------- 斜杠菜单 ---------- */

export interface SlashItem {
  id: string;
  label: string;
  icon: string;
  /** 用于筛选：英文、拼音首字母等 */
  keys: string[];
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: "h1", label: "标题 1", icon: "H1", keys: ["h1", "heading", "bt", "biaoti"] },
  { id: "h2", label: "标题 2", icon: "H2", keys: ["h2", "heading", "bt", "biaoti"] },
  { id: "h3", label: "标题 3", icon: "H3", keys: ["h3", "heading", "bt", "biaoti"] },
  { id: "bulletList", label: "无序列表", icon: "•", keys: ["ul", "list", "lb", "liebiao", "wx"] },
  { id: "orderedList", label: "有序列表", icon: "1.", keys: ["ol", "list", "lb", "liebiao", "yx"] },
  { id: "taskList", label: "任务列表", icon: "☐", keys: ["todo", "task", "rw", "renwu"] },
  { id: "quote", label: "引用", icon: "❝", keys: ["quote", "yy", "yinyong"] },
  { id: "codeBlock", label: "代码块", icon: "{ }", keys: ["code", "dm", "daima"] },
  { id: "table", label: "表格", icon: "⊞", keys: ["table", "bg", "biaoge"] },
  { id: "image", label: "图片", icon: "▣", keys: ["image", "img", "tp", "tupian"] },
  { id: "hr", label: "分割线", icon: "—", keys: ["hr", "line", "fgx", "fengexian"] },
  { id: "wikilink", label: "双向链接", icon: "[[", keys: ["link", "wiki", "sxlj", "lianjie"] },
  { id: "footnote", label: "脚注", icon: "¹", keys: ["footnote", "jz", "jiaozhu"] },
  { id: "ai", label: "AI 指令", icon: "AI", keys: ["ai", "zl", "zhiling"] },
];

export function filterSlash(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((it) => it.label.toLowerCase().includes(q) || it.keys.some((k) => k.startsWith(q)));
}

interface SlashPending {
  from: number;
  to: number;
  query: string;
}

/** 光标所在段落只有 `/查询词`，且光标在末尾 */
function slashAt(state: EditorState): SlashPending | null {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== "paragraph") return null;
  if ($from.parentOffset !== $from.parent.content.size) return null;
  const m = /^\/([^\s/]*)$/.exec($from.parent.textContent);
  if (!m) return null;
  return { from: $from.start(), to: $from.pos, query: m[1] };
}

class SlashMenu {
  el: HTMLElement;
  items: SlashItem[] = [];
  index = 0;
  pending: SlashPending | null = null;
  /** 按 Esc 关闭时记下位置，同一个 `/` 不再自动弹出 */
  dismissedAt: number | null = null;
  private onScroll = () => this.update(this.view);

  constructor(private view: EditorView, private host: FormatHost) {
    this.el = document.createElement("div");
    this.el.className = "pop slash";
    this.el.setAttribute("role", "listbox");
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.append(this.el);
    scrollParent(view)?.addEventListener("scroll", this.onScroll, { passive: true });
    this.hide();
  }

  get visible() {
    return this.el.style.display !== "none";
  }

  update(view: EditorView) {
    this.view = view;
    const p = slashAt(view.state);
    if (!p) this.dismissedAt = null;
    if (!p || !view.hasFocus() || p.from === this.dismissedAt) return this.hide();
    if (this.pending?.query !== p.query) this.index = 0;
    this.pending = p;
    this.items = filterSlash(p.query);
    if (!this.items.length) return this.hide();
    this.render();
    this.el.style.display = "block";
    const at = view.coordsAtPos(p.from);
    const h = this.el.offsetHeight;
    const top = at.bottom + 4 + h > window.innerHeight ? at.top - h - 4 : at.bottom + 4;
    this.el.style.left = `${Math.min(at.left, window.innerWidth - this.el.offsetWidth - 8)}px`;
    this.el.style.top = `${Math.max(top, 8)}px`;
  }

  render() {
    this.el.replaceChildren();
    this.items.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "pal-row" + (i === this.index ? " on" : "");
      row.setAttribute("role", "option");
      const icon = document.createElement("span");
      icon.className = "ico-box";
      icon.textContent = item.icon;
      const label = document.createElement("span");
      label.textContent = item.label;
      const hint = document.createElement("span");
      hint.className = "pc";
      hint.textContent = this.host.shortcut(item.id) ?? "";
      row.append(icon, label, hint);
      row.addEventListener("mouseenter", () => {
        this.index = i;
        this.render();
      });
      row.addEventListener("click", () => this.choose(i));
      this.el.append(row);
    });
    (this.el.children[this.index] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }

  move(delta: number) {
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.render();
  }

  dismiss() {
    this.dismissedAt = this.pending?.from ?? null;
    this.hide();
  }

  choose(i = this.index) {
    const item = this.items[i];
    const p = this.pending;
    if (!item || !p) return;
    this.hide();
    this.view.dispatch(this.view.state.tr.delete(p.from, p.to));
    this.view.focus();
    this.host.run(item.id);
  }

  hide() {
    this.el.style.display = "none";
    this.pending = null;
  }

  destroy() {
    scrollParent(this.view)?.removeEventListener("scroll", this.onScroll);
    this.el.remove();
  }
}

let activeSlash: SlashMenu | null = null;

export function slashPlugin(host: FormatHost) {
  let menu: SlashMenu | null = null;
  return $prose(() => new Plugin({
    key: new PluginKey("ttnote-slash"),
    view: (view) => {
      menu = new SlashMenu(view, host);
      activeSlash = menu;
      return {
        update: (v) => menu?.update(v),
        destroy: () => {
          menu?.destroy();
          if (activeSlash === menu) activeSlash = null;
        },
      };
    },
    props: {
      handleKeyDown: (_view, e) => {
        if (!menu?.visible) return false;
        if (e.key === "ArrowDown") menu.move(1);
        else if (e.key === "ArrowUp") menu.move(-1);
        else if (e.key === "Enter" || e.key === "Tab") menu.choose();
        else if (e.key === "Escape") menu.dismiss();
        else return false;
        e.preventDefault();
        return true;
      },
      handleDOMEvents: { blur: () => (menu?.hide(), false) },
    },
  }));
}

/** 斜杠菜单打开时，这些键交给菜单处理；供外层按键映射先行判断 */
export function slashHandlesKey(state: EditorState, e: KeyboardEvent): boolean {
  if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) return false;
  return !!activeSlash?.visible && !!slashAt(state);
}
