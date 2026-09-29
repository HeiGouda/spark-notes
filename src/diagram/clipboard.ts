import type { MindNode } from "./mindmap";
import type { FlowFragment } from "./flowchart";

/**
 * 图的剪贴板（需求文档 5.18）：Spark 里复制粘贴时保留节点的样式、子节点和连线，
 * 同时往系统剪贴板写一份纯文字。粘贴时系统剪贴板里的文字还是这份，就用保留下来的完整内容，否则按外部文字处理。
 */
type Clip = { kind: "mind"; text: string; trees: MindNode[] } | { kind: "flow"; text: string; frag: FlowFragment };

let last: Clip | null = null;

export function remember(clip: Clip) {
  last = structuredClone(clip);
}

/** 系统剪贴板里的文字就是上次在 Spark 里复制的那份时，返回完整内容 */
export function recall<K extends Clip["kind"]>(kind: K, text: string): Extract<Clip, { kind: K }> | null {
  if (!last || last.kind !== kind) return null;
  const norm = (s: string) => s.replace(/\r\n?/g, "\n").trim();
  return norm(last.text) === norm(text) ? (structuredClone(last) as Extract<Clip, { kind: K }>) : null;
}
