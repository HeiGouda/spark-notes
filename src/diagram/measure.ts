/** 图里的文字排版：按界面字体测量宽度，超过最大宽度时逐字换行 */

let ctx: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

export const DIAGRAM_FONT = '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif';

export function textWidth(text: string, size: number, weight = 400): number {
  const key = `${weight}|${size}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (!ctx && typeof document !== "undefined") ctx = document.createElement("canvas").getContext("2d");
  let w: number;
  if (ctx) {
    ctx.font = `${weight} ${size}px ${DIAGRAM_FONT}`;
    w = ctx.measureText(text).width;
  } else {
    // 测试环境没有 canvas：中文按一个字号宽，其余按半个
    w = [...text].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? size : size * 0.55), 0);
  }
  if (cache.size > 5000) cache.clear();
  cache.set(key, w);
  return w;
}

/** 按换行分段，每段逐字折行；英文单词尽量不拆开 */
export function wrapText(text: string, size: number, maxWidth: number, weight = 400): string[] {
  if (text.includes("\n")) return text.split("\n").flatMap((part) => wrapLine(part || " ", size, maxWidth, weight));
  return wrapLine(text, size, maxWidth, weight);
}

function wrapLine(text: string, size: number, maxWidth: number, weight: number): string[] {
  if (textWidth(text, size, weight) <= maxWidth) return [text];
  const lines: string[] = [];
  let line = "";
  const tokens = text.match(/[A-Za-z0-9_'-]+|\s+|./gu) ?? [];
  for (const tok of tokens) {
    const next = line + tok;
    if (!line || textWidth(next, size, weight) <= maxWidth) {
      line = next;
      continue;
    }
    if (textWidth(tok, size, weight) > maxWidth) {
      for (const ch of tok) {
        if (textWidth(line + ch, size, weight) > maxWidth && line) {
          lines.push(line);
          line = ch;
        } else line += ch;
      }
      continue;
    }
    lines.push(line.trimEnd());
    line = tok.trimStart();
  }
  if (line) lines.push(line);
  return lines;
}
