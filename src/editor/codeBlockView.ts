import { $view } from "@milkdown/kit/utils";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import type { Node } from "@milkdown/kit/prose/model";
import type { NodeView } from "@milkdown/kit/prose/view";
import { refractor } from "refractor";

/** 与 @milkdown/plugin-prism 使用同一个 refractor 实例，列表里只出现能高亮的语言 */
const LANGUAGES = ["", ...refractor.listLanguages().sort()];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ico ico-sm");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Typora 风格代码框：顶部语言选择与复制按钮，左侧行号（设计稿风格 A） */
export const codeBlockView = $view(codeBlockSchema.node, () => (initial, view, getPos): NodeView => {
  let node: Node = initial;
  let menu: HTMLElement | null = null;
  let copyTimer = 0;
  let lineCount = 0;

  const dom = el("div", "codeblock");
  const head = el("div", "cb-head");
  head.contentEditable = "false";
  const langBtn = el("button", "lang");
  langBtn.type = "button";
  langBtn.title = "选择语言";
  const langLabel = el("span");
  langBtn.append(langLabel, icon("down"));
  const copyBtn = el("button", "copy");
  copyBtn.type = "button";
  copyBtn.title = "复制代码";
  const copyLabel = el("span");
  copyLabel.textContent = "复制";
  copyBtn.append(icon("copy"), copyLabel);
  head.append(langBtn, copyBtn);

  const body = el("div", "cb-body");
  const gutter = el("div", "cb-gutter");
  gutter.contentEditable = "false";
  const pre = el("pre");
  const code = el("code");
  pre.append(code);
  body.append(gutter, pre);
  dom.append(head, body);

  function render() {
    const lang = (node.attrs.language as string) || "";
    langLabel.textContent = lang || "text";
    code.dataset.language = lang;
    const lines = node.textContent.split("\n").length;
    if (lines !== lineCount) {
      lineCount = lines;
      gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
    }
  }

  function setLanguage(language: string) {
    const pos = getPos();
    if (pos == null) return;
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language }));
    closeMenu();
    view.focus();
  }

  function onOutside(e: MouseEvent) {
    if (menu && !menu.contains(e.target as globalThis.Node) && !langBtn.contains(e.target as globalThis.Node)) closeMenu();
  }

  function closeMenu() {
    menu?.remove();
    menu = null;
    document.removeEventListener("mousedown", onOutside, true);
  }

  function openMenu() {
    if (menu) return closeMenu();
    const current = (node.attrs.language as string) || "";
    menu = el("div", "menu lang-menu");
    menu.contentEditable = "false";
    const input = el("input");
    input.placeholder = "搜索语言";
    input.spellcheck = false;
    const list = el("div", "lang-list");
    const fill = (q: string) => {
      list.replaceChildren();
      const query = q.trim().toLowerCase();
      for (const lang of LANGUAGES) {
        const label = lang || "text";
        if (query && !label.includes(query)) continue;
        const item = el("button", "menu-item" + (lang === current ? " is-current" : ""));
        item.type = "button";
        item.textContent = label;
        item.addEventListener("click", () => setLanguage(lang));
        list.append(item);
      }
    };
    input.addEventListener("input", () => fill(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeMenu();
        view.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        (list.firstElementChild as HTMLButtonElement | null)?.click();
      }
    });
    fill("");
    menu.append(input, list);
    dom.append(menu);
    document.addEventListener("mousedown", onOutside, true);
    input.focus();
  }

  langBtn.addEventListener("click", openMenu);
  copyBtn.addEventListener("click", async () => {
    clearTimeout(copyTimer);
    try {
      await navigator.clipboard.writeText(node.textContent);
      copyLabel.textContent = "已复制";
    } catch (e) {
      console.error("复制代码失败", e);
      copyLabel.textContent = "复制失败";
    }
    copyTimer = window.setTimeout(() => (copyLabel.textContent = "复制"), 1500);
  });

  render();

  return {
    dom,
    contentDOM: code,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      render();
      return true;
    },
    stopEvent(e) {
      const t = e.target as globalThis.Node | null;
      return !!t && (head.contains(t) || !!menu?.contains(t));
    },
    ignoreMutation(m) {
      return !code.contains(m.target);
    },
    destroy() {
      closeMenu();
      clearTimeout(copyTimer);
    },
  };
});
