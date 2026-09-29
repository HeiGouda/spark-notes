/** 与 Rust 端 notes.rs 的规则一致：`#` 前是行首或空白，至少含一个非数字字符；跳过代码 */
const INLINE_TAG = /(^|\s)#([\p{L}\p{N}_\-/]+)/gu;

export function inlineTags(body: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const t = line.trimStart();
    if (fence) {
      if (t.startsWith(fence)) fence = null;
      continue;
    }
    if (t.startsWith("```") || t.startsWith("~~~")) {
      fence = t.slice(0, 3);
      continue;
    }
    const clean = line.replace(/`[^`]*`?/g, (m) => " ".repeat(m.length));
    for (const m of clean.matchAll(INLINE_TAG)) {
      const tag = m[2].replace(/\/+$/, "");
      if (tag && /\D/.test(tag)) out.push(tag);
    }
  }
  return out;
}

/** 解析“添加标签”输入框：空格或逗号分隔，可带开头的 #；不合规则的另外返回 */
export function parseTagInput(input: string): { tags: string[]; invalid: string[] } {
  const tags: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[\s,，、]+/)) {
    const t = raw.replace(/^#+/, "").replace(/\/+$/, "");
    if (!t) continue;
    if (/^[\p{L}\p{N}_\-/]+$/u.test(t) && /\D/.test(t)) tags.push(t);
    else invalid.push(raw);
  }
  return { tags, invalid };
}

/** 合并并按不区分大小写去重，保持首次出现的顺序 */
export function mergeTags(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of lists.flat()) {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}
