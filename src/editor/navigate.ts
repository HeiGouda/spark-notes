import { editorViewCtx, type Editor } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { Node } from "@milkdown/kit/prose/model";

export interface Heading {
  level: number;
  text: string;
  /** 标题节点在文档中的位置 */
  pos: number;
}

export function headingsOf(doc: Node): Heading[] {
  const out: Heading[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      out.push({ level: node.attrs.level as number, text: node.textContent, pos });
      return false;
    }
    return node.isBlock && !node.isTextblock;
  });
  return out;
}

/** 光标所在章节：光标之前最后一个标题 */
export function currentHeadingIndex(headings: Heading[], cursor: number): number {
  let idx = -1;
  for (let i = 0; i < headings.length && headings[i].pos <= cursor; i++) idx = i;
  return idx;
}

/** 把光标放到 pos 处的块内，并把该块滚动到可视区域顶部 */
export function goTo(editor: Editor, pos: number, to?: number): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { doc } = view.state;
    const from = Math.min(pos, doc.content.size);
    const sel =
      to !== undefined
        ? TextSelection.create(doc, from, Math.min(to, doc.content.size))
        : TextSelection.near(doc.resolve(Math.min(from + 1, doc.content.size)));
    view.dispatch(view.state.tr.setSelection(sel));
    view.focus();
    const dom = view.domAtPos(sel.from).node;
    const el = dom instanceof HTMLElement ? dom : dom.parentElement;
    el?.closest("h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,table")?.scrollIntoView({ block: "start" });
  });
}

/** 按标题文字定位（忽略大小写和首尾空白） */
export function goToHeading(editor: Editor, text: string): boolean {
  const want = text.trim().toLowerCase();
  const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
  const h = headingsOf(doc).find((x) => x.text.trim().toLowerCase() === want);
  if (!h) return false;
  goTo(editor, h.pos);
  return true;
}

/** 选中正文里第一次出现的文字（忽略大小写） */
export function goToText(editor: Editor, text: string): boolean {
  const want = text.toLowerCase();
  if (!want) return false;
  const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
  let found: [number, number] | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    const t = node.textBetween(0, node.content.size, undefined, "\uFFFC").toLowerCase();
    const i = t.indexOf(want);
    if (i >= 0) found = [pos + 1 + i, pos + 1 + i + want.length];
    return false;
  });
  if (!found) return false;
  goTo(editor, found[0], found[1]);
  return true;
}
