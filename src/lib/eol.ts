export type Eol = "\n" | "\r\n";

/** 以文件中第一个换行为准；编辑器内部统一用 LF，保存时换回原文件的换行符 */
export function detectEol(text: string): Eol {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function applyEol(text: string, eol: Eol): string {
  const lf = toLf(text);
  return eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}
