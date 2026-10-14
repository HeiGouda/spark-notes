/**
 * 竖排专用的标点（︽︾﹁﹂︿﹀ 这类“竖排形式”字符）横着排时是歪的。
 * 从竖排书转来的电子书常把它们直接写在正文和目录里，显示时换成对应的横排标点。
 * 一个字换一个字，长度不变；原文、字符偏移都不改，只用于显示。
 */
const VERTICAL: Record<string, string> = {
  "\uFE10": "，",
  "\uFE11": "、",
  "\uFE12": "。",
  "\uFE13": "：",
  "\uFE14": "；",
  "\uFE15": "！",
  "\uFE16": "？",
  "\uFE17": "〖",
  "\uFE18": "〗",
  "\uFE19": "…",
  "\uFE30": "‥",
  "\uFE31": "—",
  "\uFE32": "–",
  "\uFE33": "_",
  "\uFE34": "_",
  "\uFE35": "（",
  "\uFE36": "）",
  "\uFE37": "｛",
  "\uFE38": "｝",
  "\uFE39": "〔",
  "\uFE3A": "〕",
  "\uFE3B": "【",
  "\uFE3C": "】",
  "\uFE3D": "《",
  "\uFE3E": "》",
  "\uFE3F": "〈",
  "\uFE40": "〉",
  "\uFE41": "「",
  "\uFE42": "」",
  "\uFE43": "『",
  "\uFE44": "』",
  "\uFE47": "［",
  "\uFE48": "］",
};

const PATTERN = /[\uFE10-\uFE19\uFE30-\uFE48]/g;

export function horizontalPunct(text: string): string {
  return text.replace(PATTERN, (ch) => VERTICAL[ch] ?? ch);
}
