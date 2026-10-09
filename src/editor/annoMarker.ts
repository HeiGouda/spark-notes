import { $nodeSchema, $remark } from "@milkdown/kit/utils";

/** 读书笔记里的 `<!-- spark-anno ... -->`：编辑时不显示，保存时原样写回 */

const MARK = /<!--\s*spark-anno\s+\S+\s+\S+\s+\S+\s*-->/;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

function marker(value: string): MdNode {
  return { type: "annoMarker", value: value.trim() };
}

export function liftAnnoMarkers(node: MdNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "html" && child.value && MARK.test(child.value)) return [marker(child.value)];
    if (child.type === "text" && child.value && MARK.test(child.value.trim()) && child.value.trim() === child.value.trim().match(MARK)?.[0]) {
      return [marker(child.value)];
    }
    liftAnnoMarkers(child);
    return [child];
  });
}

const remarkAnno = $remark("ttnote-anno-marker", () => () => (tree: unknown) => {
  liftAnnoMarkers(tree as MdNode);
});

export const annoMarkerSchema = $nodeSchema("annoMarker", () => ({
  group: "inline",
  inline: true,
  atom: true,
  attrs: { text: { default: "", validate: "string" } },
  parseDOM: [
    {
      tag: "span.anno-marker",
      getAttrs: (dom) => ({ text: (dom as HTMLElement).dataset.anno ?? "" }),
    },
  ],
  toDOM: (node) => ["span", { class: "anno-marker", "data-anno": node.attrs.text, style: "display:none" }],
  parseMarkdown: {
    match: (node) => node.type === "annoMarker",
    runner: (state, node, type) => {
      state.addNode(type, { text: String(node.value ?? "") });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "annoMarker",
    runner: (state, node) => {
      state.addNode("html", undefined, node.attrs.text as string);
    },
  },
}));

export const annoMarkerPlugins = [remarkAnno, annoMarkerSchema].flat();
