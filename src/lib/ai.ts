import type { ChatMessage } from "./api";
import { formatTokens } from "./aiModels";

export interface AiPresetModel {
  /** 请求里的 model 参数 */
  name: string;
  /** 默认的显示名称 */
  label: string;
}

export interface AiPreset {
  id: string;
  label: string;
  /** OpenAI 兼容接口地址；“自定义”为空 */
  baseUrl: string;
  /** 当前主力对话模型，按 2026-10 各家官方文档；聚合平台和本机服务不预设，用“从服务商读取” */
  models: AiPresetModel[];
  /** 不需要 API Key（本机服务） */
  local?: boolean;
  /** 添加模型时显示的提示 */
  hint?: string;
}

const m = (name: string, label: string): AiPresetModel => ({ name, label });

/** 服务商预设（需求文档 5.16）：填好接口地址，并给出可选的模型 */
export const AI_PRESETS: AiPreset[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", models: [m("gpt-6-astra", "GPT-6 Astra"), m("gpt-6.1-sol", "GPT-6.1 Sol"), m("gpt-6-luna", "GPT-6 Luna")] },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1",
    models: [m("claude-opus-5-5", "Claude Opus 5.5"), m("claude-sonnet-5-5", "Claude Sonnet 5.5"), m("claude-haiku-4-5", "Claude Haiku 4.5"), m("claude-fable-5-1", "Claude Fable 5.1")],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: [m("gemini-3.1-pro-preview", "Gemini 3.1 Pro"), m("gemini-3.8-flash", "Gemini 3.8 Flash"), m("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite")],
  },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", models: [m("mistral-large-4", "Mistral Large 4"), m("mistral-medium-3-5", "Mistral Medium 3.5")] },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", models: [m("deepseek-v4-pro", "DeepSeek V4 Pro"), m("deepseek-flash", "DeepSeek V4.1 Flash")] },
  {
    id: "qwen",
    label: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [m("qwen3.8-max", "Qwen3.8 Max"), m("qwen3.7-plus", "Qwen3.7 Plus"), m("qwen3.8-flash", "Qwen3.8 Flash")],
  },
  { id: "kimi", label: "Kimi", baseUrl: "https://api.moonshot.cn/v1", models: [m("kimi-k3", "Kimi K3"), m("kimi-k2.7-code", "Kimi K2.7 Code"), m("kimi-k2.6", "Kimi K2.6")] },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: [m("glm-5.3", "GLM-5.3"), m("glm-5.3-flash", "GLM-5.3-Flash"), m("glm-4.7-flash", "GLM-4.7-Flash（免费）")],
  },
  {
    id: "doubao",
    label: "豆包（火山方舟）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [
      m("doubao-seed-2-1-pro-260628", "Doubao Seed 2.1 Pro"),
      m("doubao-seed-2-1-turbo-260628", "Doubao Seed 2.1 Turbo"),
      m("doubao-seed-2-0-lite-260428", "Doubao Seed 2.0 Lite"),
    ],
    hint: "豆包的模型名带版本日期、更新频繁，以火山方舟控制台为准。",
  },
  {
    id: "ernie",
    label: "文心（百度千帆）",
    baseUrl: "https://qianfan.baidubce.com/v2",
    models: [m("ernie-5.1", "ERNIE 5.1"), m("ernie-5.0", "ERNIE 5.0"), m("ernie-4.5-turbo-128k", "ERNIE 4.5 Turbo 128K")],
  },
  { id: "hunyuan", label: "腾讯混元", baseUrl: "https://tokenhub.tencentmaas.com/v1", models: [m("hy4-preview", "Hy4 Preview"), m("hy3", "Hy3")] },
  {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    models: [m("MiniMax-M3", "MiniMax-M3"), m("MiniMax-M2.7", "MiniMax-M2.7"), m("MiniMax-M2.7-highspeed", "MiniMax-M2.7 极速版")],
  },
  {
    id: "stepfun",
    label: "阶跃星辰",
    baseUrl: "https://api.stepfun.com/v1",
    models: [m("step-5-preview", "Step 5 Preview"), m("step-3.7-flash", "Step 3.7 Flash"), m("step-3.5-flash", "Step 3.5 Flash")],
  },
  { id: "siliconflow", label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", models: [], hint: "模型很多且常变，点“从服务商读取”选择。" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", models: [], hint: "模型很多且常变，点“从服务商读取”选择。" },
  { id: "ollama", label: "Ollama（本机）", baseUrl: "http://localhost:11434/v1", models: [], local: true, hint: "列出本机已下载的模型：点“从服务商读取”。" },
  { id: "lmstudio", label: "LM Studio（本机）", baseUrl: "http://localhost:1234/v1", models: [], local: true, hint: "列出本机已加载的模型：点“从服务商读取”。" },
  { id: "custom", label: "自定义", baseUrl: "", models: [] },
];

export type AiPresetId = string;

export function presetOf(id: string): AiPreset {
  return AI_PRESETS.find((p) => p.id === id) ?? AI_PRESETS[AI_PRESETS.length - 1];
}

/** 同一个接口地址：忽略首尾空白和末尾的 `/` */
export function sameBaseUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/** 按接口地址认出预设（迁移旧设置时用），认不出时为“自定义” */
export function presetByUrl(baseUrl: string): AiPreset {
  return AI_PRESETS.find((p) => p.baseUrl && sameBaseUrl(p.baseUrl, baseUrl)) ?? presetOf("custom");
}

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

/** 思维导图的输出格式：Mermaid mindmap 的纯文字子集 */
const MIND_FORMAT = [
  "只输出 Mermaid mindmap 代码，不要任何解释。",
  "格式：第一行写 mindmap；之后每行一个节点，用两个空格表示一级缩进；第一个节点是根节点，写主题。",
  "节点只写纯文字，不要使用括号、方括号、花括号、图标或样式写法。",
];

/** 把笔记生成思维导图（需求文档 5.18） */
export function mindMapMessages(title: string, note: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你把用户的笔记整理成思维导图。",
        ...MIND_FORMAT,
        "提炼要点，每个节点不超过 20 个字，不要照抄整段原文；层级不超过 4 层；保留原文中的专有名词。",
      ].join("\n"),
    },
    { role: "user", content: `笔记标题：${title}\n\n${note}` },
  ];
}

/** 按用户的描述（或笔记里选中的文字）生成思维导图（需求文档 5.18） */
export function mindDescMessages(desc: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你根据用户的描述生成一张思维导图：确定主题，把要点分成几个分支，再逐层展开。",
        ...MIND_FORMAT,
        "每个节点不超过 20 个字；层级不超过 4 层；一级分支 3 到 8 个；保留描述中的专有名词，描述里没有提到的内容可以合理补充常识性的要点。",
      ].join("\n"),
    },
    { role: "user", content: desc },
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
