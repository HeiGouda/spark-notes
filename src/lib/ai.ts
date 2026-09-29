import type { ChatMessage } from "./api";
import { formatTokens } from "./aiModels";

/** 服务商预设，只负责填好接口地址（需求文档 5.16） */
export const AI_PRESETS = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { id: "qwen", label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "kimi", label: "Kimi", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "zhipu", label: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "siliconflow", label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "ollama", label: "Ollama（本机）", baseUrl: "http://localhost:11434/v1" },
  { id: "lmstudio", label: "LM Studio（本机）", baseUrl: "http://localhost:1234/v1" },
  { id: "custom", label: "自定义", baseUrl: "" },
] as const;

export type AiPresetId = (typeof AI_PRESETS)[number]["id"];

/** 请求超过默认模型可发送上限时的提示 */
export function tooLongMessage(tokens: number, budget: number): string {
  return `笔记过长（约 ${formatTokens(tokens)} tokens，当前模型最多可发送约 ${formatTokens(budget)} tokens）`;
}

/** 差异内容的字符上限：按每个字符 1 token 保守换算，并限制传输体积 */
export function diffCharLimit(budget: number): number {
  return Math.max(2000, Math.min(budget - 2000, 400_000));
}

const SYSTEM = "你是 Spark 的写作助手。用简体中文回答，输出 Markdown，不要用代码块包裹整个回答，不要解释你做了什么。";

export function instructionMessages(instruction: string, note: string | null): ChatMessage[] {
  const user = note === null
    ? `${instruction}\n\n只输出要写进笔记的内容。`
    : `${instruction}\n\n下面是当前笔记的全文，供参考：\n<note>\n${note}\n</note>\n\n只输出要写进笔记的内容，不要重复笔记原文。`;
  return [{ role: "system", content: SYSTEM }, { role: "user", content: user }];
}

export function summaryMessages(title: string, note: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `请总结下面这篇笔记。先用一两句话概括，再列出 3 到 5 条要点，每条单独一行、以“- ”开头。只输出总结本身。\n\n笔记标题：${title}\n<note>\n${note}\n</note>`,
    },
  ];
}

export function structureMessages(note: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: [
        "请整理下面这篇 Markdown 笔记的结构：可以调整标题层级、拆分或合并段落、把并列的内容改成列表。必须遵守：",
        "1. 不增删任何观点和信息，不改变句子的意思；",
        "2. [[双向链接]]、图片、附件链接和代码块必须原样保留，一个字符都不能改；",
        "3. 只输出整理后的完整 Markdown。",
        "",
        `<note>\n${note}\n</note>`,
      ].join("\n"),
    },
  ];
}

export function commitMessages(files: string[], diff: string, truncated: boolean): ChatMessage[] {
  const note = truncated ? "\n（改动较多，下面只包含每个文件的部分差异）" : "";
  return [
    {
      role: "system",
      content: "你负责为笔记仓库写 Git 提交说明。用简体中文，只输出一行说明，不超过 50 个字，不要引号、前缀或解释。",
    },
    { role: "user", content: `改动的文件：\n${files.join("\n")}${note}\n\n差异：\n${diff}` },
  ];
}

/** 去掉模型偶尔加上的整段代码块包裹 */
export function unwrapFence(text: string): string {
  const m = /^\s*```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return m ? m[1] : text.trim();
}

/** 提交说明只取第一行，去掉引号 */
export function cleanCommitMessage(text: string): string {
  const line = unwrapFence(text).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.replace(/^["'“”「」]+|["'“”「」]+$/g, "").trim();
}

/* ---------- 总结结果的显示与插入 ---------- */

export interface SummaryBlock {
  kind: "p" | "li";
  text: string;
}

export function summaryBlocks(text: string): SummaryBlock[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const li = /^(?:[-*•]|\d+[.)、])\s+(.*)$/.exec(l);
      const body = (li ? li[1] : l).replace(/\*\*(.+?)\*\*/g, "$1");
      return { kind: li ? "li" : "p", text: body };
    });
}

/** 插入到笔记开头的引用块 */
export function summaryQuote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => (l.trim() ? `> ${l.trimEnd()}` : ">"))
    .join("\n");
}

/* ---------- AI 整理结构：不允许改动的内容 ---------- */

export interface ProtectedIssue {
  label: string;
  before: number;
  after: number;
  missing: string[];
  extra: string[];
}

const CODE_BLOCK = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm;

function extract(md: string) {
  const codeBlocks = md.match(CODE_BLOCK) ?? [];
  const text = md.replace(CODE_BLOCK, "").replace(/`[^`\n]*`/g, "");
  const wikilinks = text.match(/\[\[[^\]\n]+\]\]/g) ?? [];
  const images: string[] = [];
  const attachments: string[] = [];
  for (const m of text.matchAll(/(!?)\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
    if (m[1]) images.push(m[2]);
    else if (!/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(m[2])) attachments.push(m[2]);
  }
  return { wikilinks, images, attachments, codeBlocks };
}

function multisetDiff(a: string[], b: string[]): string[] {
  const left = [...b];
  const out: string[] = [];
  for (const x of a) {
    const i = left.indexOf(x);
    if (i >= 0) left.splice(i, 1);
    else out.push(x);
  }
  return out;
}

/** 对比原文与整理结果，返回数量或内容不一致的项；空数组表示核对通过 */
export function checkProtected(before: string, after: string): ProtectedIssue[] {
  const a = extract(before);
  const b = extract(after);
  const groups: [string, string[], string[]][] = [
    ["双向链接", a.wikilinks, b.wikilinks],
    ["图片", a.images, b.images],
    ["附件链接", a.attachments, b.attachments],
    ["代码块", a.codeBlocks, b.codeBlocks],
  ];
  return groups
    .map(([label, x, y]) => ({ label, before: x.length, after: y.length, missing: multisetDiff(x, y), extra: multisetDiff(y, x) }))
    .filter((g) => g.missing.length || g.extra.length);
}

/** 核对通过时的说明，例如“2 个双向链接、1 个代码块与原文一致” */
export function protectedSummary(md: string): string {
  const e = extract(md);
  const parts = [
    [e.wikilinks.length, "个双向链接"],
    [e.images.length, "张图片"],
    [e.attachments.length, "个附件链接"],
    [e.codeBlocks.length, "个代码块"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, s]) => `${n} ${s}`);
  return parts.length ? `${parts.join("、")}与原文一致` : "没有需要保护的链接、图片或代码块";
}

export function describeIssue(issue: ProtectedIssue): string {
  const short = (list: string[]) => {
    const shown = list.slice(0, 3).map((s) => (s.length > 40 ? `${s.slice(0, 40)}…` : s)).join("、");
    return list.length > 3 ? `${shown} 等` : shown;
  };
  const parts = [`${issue.label}由 ${issue.before} 个变成 ${issue.after} 个`];
  if (issue.missing.length) parts.push(`缺少 ${short(issue.missing)}`);
  if (issue.extra.length) parts.push(`多出 ${short(issue.extra)}`);
  if (issue.before === issue.after) parts[0] = `${issue.label}内容有改动`;
  return parts.join("，");
}
