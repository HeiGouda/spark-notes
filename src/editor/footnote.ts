import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";

/** 插入脚注：光标处放引用 `[^n]`，文末追加定义 `[^n]: `，并把光标移到定义里 */
export function insertFootnote(editor: Editor): boolean {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const refType = state.schema.nodes.footnote_reference;
    const defType = state.schema.nodes.footnote_definition;
    if (!refType || !defType) return false;
    let max = 0;
    state.doc.descendants((n) => {
      if (n.type === refType || n.type === defType) {
        const v = Number.parseInt(n.attrs.label as string, 10);
        if (!Number.isNaN(v)) max = Math.max(max, v);
      }
    });
    const label = String(max + 1);
    let tr = state.tr.replaceSelectionWith(refType.create({ label }), false);
    const end = tr.doc.content.size;
    tr = tr.insert(end, defType.create({ label }, state.schema.nodes.paragraph.create()));
    tr = tr.setSelection(TextSelection.create(tr.doc, end + 2));
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  });
}
