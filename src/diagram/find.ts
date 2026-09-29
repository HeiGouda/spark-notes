/** 图里的查找与替换（需求文档 5.18）：在节点文字（流程图另含连线文字）中逐处查找 */

export interface TextItem {
  /** 节点 id，或流程图连线的 `edge:键` */
  id: string;
  text: string;
}

export interface DiagramMatch {
  item: string;
  index: number;
  text: string;
}

export function findInItems(items: TextItem[], pattern: RegExp): DiagramMatch[] {
  const out: DiagramMatch[] = [];
  for (const it of items) {
    pattern.lastIndex = 0;
    for (const m of it.text.matchAll(pattern)) {
      if (m[0]) out.push({ item: it.id, index: m.index ?? 0, text: m[0] });
    }
  }
  return out;
}

/** 正则模式下支持 $1、$& 等引用 */
function replacementFor(m: DiagramMatch, pattern: RegExp, replacement: string, regex: boolean): string {
  if (!regex) return replacement;
  return m.text.replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement);
}

/** 替换同一段文字里的若干处，从后往前替换，前面的位置不受影响 */
export function replaceMatches(text: string, matches: DiagramMatch[], pattern: RegExp, replacement: string, regex: boolean): string {
  let out = text;
  for (const m of [...matches].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, m.index) + replacementFor(m, pattern, replacement, regex) + out.slice(m.index + m.text.length);
  }
  return out;
}

/** 按所在节点分组 */
export function groupMatches(matches: DiagramMatch[]): Map<string, DiagramMatch[]> {
  const out = new Map<string, DiagramMatch[]>();
  for (const m of matches) {
    if (!out.has(m.item)) out.set(m.item, []);
    out.get(m.item)!.push(m);
  }
  return out;
}
