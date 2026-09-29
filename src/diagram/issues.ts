/** 图无法显示的原因，逐条列在提示页上 */
export interface DiagramIssue {
  /** 从 1 开始的行号 */
  line: number;
  message: string;
}

export type ParseResult<T> = { ok: true; doc: T } | { ok: false; issues: DiagramIssue[] };

/** 按行拆分；换行统一为 LF 后调用 */
export function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function isComment(trimmed: string): boolean {
  return trimmed.startsWith("%%");
}

const ENTITY = /#(quot|amp|lt|gt|\d+);/g;

/** Mermaid 引号文字里的实体：#quot; #amp; #lt; #gt; #数字; */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY, (_, e: string) => {
    if (e === "quot") return '"';
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    return String.fromCodePoint(Number(e));
  });
}

/** 写成引号文字：原文里恰好像实体的 # 先转义，双引号写成 #quot;，< 写成 #lt;，换行写成 <br> */
export function quoteText(s: string): string {
  const body = s
    .replace(/#(?=(quot|amp|lt|gt|\d+);)/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/\n/g, "<br>");
  return `"${body}"`;
}

/** 读回文字：<br> 还原成换行，再解码实体 */
export function decodeText(s: string): string {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, "\n"));
}
