const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD = /[\p{L}\p{N}_'’-]+/gu;

/** 字数：每个中日韩字符计 1，其余按连续字母数字计为 1 个词 */
export function countWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, " ").match(WORD)?.length ?? 0;
  return cjk + words;
}
