import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { $inputRule, $markSchema, $remark } from "@milkdown/kit/utils";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { toggleMark } from "@milkdown/kit/prose/commands";

/** 高亮 `==文字==`（Typora、Obsidian 的扩展语法）：解析成 highlight 标记，保存时原样写回 */

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

const HIGHLIGHT_RE = /==([^=\n](?:[^\n]*?[^=\n])?)==/g;

export function splitHighlight(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(HIGHLIGHT_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ type: "text", value: value.slice(last, i) });
    out.push({ type: "highlight", children: [{ type: "text", value: m[1] }] });
    last = i + m[0].length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

const remarkHighlight = $remark("ttnote-highlight", () => () => (tree: unknown) => {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && child.value?.includes("==")) return splitHighlight(child.value);
      walk(child);
      return [child];
    });
  };
  walk(tree as MdNode);
});

export const highlightSchema = $markSchema("highlight", () => ({
  parseDOM: [{ tag: "mark" }],
  toDOM: () => ["mark", 0],
  parseMarkdown: {
    match: (node) => node.type === "highlight",
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "highlight",
    runner: (state, mark) => {
      state.withMark(mark, "highlight");
    },
  },
}));

/** 输入完 `==文字==` 时转为高亮 */
const highlightInputRule = $inputRule((ctx) =>
  new InputRule(/==([^=\s](?:[^=]*[^=\s])?)==$/, (state, match, start, end) => {
    const type = highlightSchema.type(ctx);
    return state.tr.replaceWith(start, end, state.schema.text(match[1], [type.create()])).removeStoredMark(type);
  }),
);

interface PhrasingState {
  containerPhrasing: (node: unknown, info: Record<string, unknown>) => string;
}

/** remark-stringify 的处理器 */
export const highlightStringifyHandlers = {
  highlight: (node: unknown, _parent: unknown, state: PhrasingState, info: Record<string, unknown>) =>
    `==${state.containerPhrasing(node, { ...info, before: "=", after: "=" })}==`,
};

export const highlightPlugins = [remarkHighlight, highlightSchema, highlightInputRule].flat();

export function toggleHighlight(editor: Editor): boolean {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    return toggleMark(highlightSchema.type(ctx))(view.state, view.dispatch, view);
  });
}
