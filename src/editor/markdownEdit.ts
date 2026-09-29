import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { Slice, type Node } from "@milkdown/kit/prose/model";
import { closeHistory } from "@milkdown/kit/prose/history";

function parse(editor: Editor, markdown: string): Node {
  const doc = editor.action((ctx) => ctx.get(parserCtx)(markdown));
  if (!doc) throw new Error("无法解析 Markdown");
  return doc;
}

/** 把一段 Markdown 插到笔记开头（一步撤销） */
export function insertAtStart(editor: Editor, markdown: string): void {
  const doc = parse(editor, markdown);
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(closeHistory(view.state.tr).insert(0, doc.content).scrollIntoView());
  });
}

/** 把一段 Markdown 插到光标处（有选区时替换选区；一步撤销） */
export function insertAtCursor(editor: Editor, markdown: string): void {
  const doc = parse(editor, markdown);
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(closeHistory(view.state.tr).replaceSelection(new Slice(doc.content, 0, 0)).scrollIntoView());
  });
}

/** 用一段 Markdown 替换整篇笔记（一步撤销） */
export function replaceAll(editor: Editor, markdown: string): void {
  const doc = parse(editor, markdown);
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(closeHistory(view.state.tr).replaceWith(0, view.state.doc.content.size, doc.content));
  });
}
