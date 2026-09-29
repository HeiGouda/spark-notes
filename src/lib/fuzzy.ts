/** 模糊匹配：查询词的字符按顺序出现在文本中即命中；连续、靠前、词首命中得分更高 */
export interface FuzzyResult {
  score: number;
  /** 命中字符在文本中的下标 */
  indices: number[];
}

export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  // 先找连续出现的位置，能找到时得分最高
  const direct = t.indexOf(q);
  if (direct >= 0) {
    return { score: 1000 - direct * 2 - t.length * 0.1, indices: Array.from({ length: q.length }, (_, i) => direct + i) };
  }
  const indices: number[] = [];
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    score += i === prev + 1 ? 8 : 1;
    if (i === 0 || /[\s/_\-.]/.test(t[i - 1])) score += 4;
    indices.push(i);
    prev = i;
    ti = i + 1;
  }
  return { score: score - indices[0] * 0.5 - t.length * 0.1, indices };
}

/** 把文本按命中下标切成片段，供高亮显示 */
export function highlightSegments(text: string, indices: number[]): { text: string; hit: boolean }[] {
  const set = new Set(indices);
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}
