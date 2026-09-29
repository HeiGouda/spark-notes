import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node } from "@milkdown/kit/prose/model";

/** 查找与替换（需求文档 5.1）：在各文本块内查找，不跨段落 */

export interface FindOptions {
  caseSensitive: boolean;
  regex: boolean;
}

export interface Match {
  from: number;
  to: number;
  /** 命中的原文，用于正则替换时展开 $1 等引用 */
  text: string;
}

export function buildPattern(query: string, opts: FindOptions): RegExp | null {
  if (!query) return null;
  const flags = opts.caseSensitive ? "gu" : "giu";
  try {
    return new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch {
    return null;
  }
}

/** 文本块内每个字符与文档位置一一对应：文字按字符计，行内原子节点（如双向链接）计为一个占位符 */
export function findMatches(doc: Node, pattern: RegExp): Match[] {
  const out: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, undefined, "\uFFFC");
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      if (!m[0]) continue;
      const from = pos + 1 + (m.index ?? 0);
      out.push({ from, to: from + m[0].length, text: m[0] });
    }
    return false;
  });
  return out;
}

interface FindState {
  matches: Match[];
  current: number;
}

const findKey = new PluginKey<DecorationSet>("ttnote-find");

export const findPlugin = $prose(() => new Plugin({
  key: findKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, old) {
      const meta = tr.getMeta(findKey) as FindState | undefined;
      if (meta) {
        return DecorationSet.create(
          tr.doc,
          meta.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === meta.current ? "find-hit find-cur" : "find-hit" })),
        );
      }
      return old.map(tr.mapping, tr.doc);
    },
  },
  props: { decorations(state) { return findKey.getState(state); } },
}));

function view(editor: Editor) {
  return editor.action((ctx) => ctx.get(editorViewCtx));
}

export function showMatches(editor: Editor, matches: Match[], current: number, select: boolean): void {
  const v = view(editor);
  let tr = v.state.tr.setMeta(findKey, { matches, current } satisfies FindState);
  const m = matches[current];
  if (select && m) tr = tr.setSelection(TextSelection.create(tr.doc, m.from, m.to));
  v.dispatch(tr);
  if (select && m) {
    const dom = v.domAtPos(m.from).node;
    const el = dom instanceof HTMLElement ? dom : dom.parentElement;
    el?.scrollIntoView({ block: "center" });
  }
}

export function clearMatches(editor: Editor): void {
  const v = view(editor);
  v.dispatch(v.state.tr.setMeta(findKey, { matches: [], current: -1 } satisfies FindState));
}

/** 替换文字：正则模式下支持 $1、$& 等引用 */
function replacementFor(m: Match, pattern: RegExp, replacement: string, regex: boolean): string {
  if (!regex) return replacement;
  const single = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  return m.text.replace(single, replacement);
}

export function replaceOne(editor: Editor, m: Match, pattern: RegExp, replacement: string, regex: boolean): void {
  const v = view(editor);
  const text = replacementFor(m, pattern, replacement, regex);
  const tr = text ? v.state.tr.insertText(text, m.from, m.to) : v.state.tr.delete(m.from, m.to);
  v.dispatch(tr);
}

/** 从后往前替换，前面的位置不受影响；作为一次操作，可以一次撤销 */
export function replaceAll(editor: Editor, matches: Match[], pattern: RegExp, replacement: string, regex: boolean): number {
  const v = view(editor);
  let tr = v.state.tr;
  for (const m of [...matches].reverse()) {
    const text = replacementFor(m, pattern, replacement, regex);
    tr = text ? tr.insertText(text, m.from, m.to) : tr.delete(m.from, m.to);
  }
  v.dispatch(tr);
  return matches.length;
}

export function currentDoc(editor: Editor): Node {
  return view(editor).state.doc;
}

export function selectionText(editor: Editor): string {
  const v = view(editor);
  const { from, to, empty } = v.state.selection;
  return empty ? "" : v.state.doc.textBetween(from, to, " ");
}
