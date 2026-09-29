import type { ChatMessage } from "./api";

/** 设置里的一个模型；context 为手动填写的上下文长度（tokens），null 表示自动 */
export interface AiModelEntry {
  name: string;
  context: number | null;
}

export type ContextSource = "manual" | "provider" | "builtin" | "default";

export interface ModelContext {
  tokens: number;
  source: ContextSource;
}

export const DEFAULT_CONTEXT = 128_000;

export const SOURCE_LABELS: Record<ContextSource, string> = {
  manual: "手动填写",
  provider: "服务商",
  builtin: "内置",
  default: "未知，按 128K",
};

/**
 * 常见模型的上下文长度（tokens）。按名称前缀匹配，越靠前越优先；
 * 数值以各服务商公开文档为准，可能随版本变化，所以允许服务商返回值和手动填写覆盖。
 */
const BUILTIN: [RegExp, number][] = [
  [/^qwen-long/, 10_000_000],
  [/^qwen-turbo/, 1_000_000],
  [/^qwen-plus/, 131_072],
  [/^qwen-max/, 32_768],
  [/^qwen-vl/, 32_768],
  [/^qwen3?-coder-plus/, 1_000_000],
  [/^deepseek-(chat|reasoner)/, 128_000],
  [/^moonshot-v1-8k/, 8_192],
  [/^moonshot-v1-32k/, 32_768],
  [/^moonshot-v1-128k/, 131_072],
  [/^kimi-k2/, 131_072],
  [/^glm-4-long/, 1_000_000],
  [/^glm-4/, 128_000],
  [/^gpt-4\.1/, 1_047_576],
  [/^gpt-4o/, 128_000],
  [/^o[134](-mini)?/, 200_000],
  [/^claude-/, 200_000],
  [/^gemini-1\.5-pro/, 2_000_000],
  [/^gemini-/, 1_048_576],
];

/** 名称里带 -32k、-128k、-1m 之类后缀时按后缀计算 */
function fromSuffix(name: string): number | null {
  const m = /-(\d+)([km])$/i.exec(name);
  if (!m) return null;
  return Number(m[1]) * (m[2].toLowerCase() === "k" ? 1024 : 1_000_000);
}

export function builtinContext(name: string): number | null {
  // OpenRouter、硅基流动等会加厂商前缀，如 qwen/qwen-plus、Qwen/Qwen2.5-72B-Instruct
  const bare = name.trim().toLowerCase().split("/").pop() ?? "";
  for (const [re, tokens] of BUILTIN) if (re.test(bare)) return tokens;
  return fromSuffix(bare);
}

/** 优先级：手动填写 > 服务商返回 > 内置表 > 默认 128K */
export function resolveContext(entry: AiModelEntry, provider: Record<string, number>): ModelContext {
  if (entry.context && entry.context > 0) return { tokens: entry.context, source: "manual" };
  const fromProvider = provider[entry.name];
  if (fromProvider && fromProvider > 0) return { tokens: fromProvider, source: "provider" };
  const builtin = builtinContext(entry.name);
  if (builtin) return { tokens: builtin, source: "builtin" };
  return { tokens: DEFAULT_CONTEXT, source: "default" };
}

/** 可发送的 token 数 = 上下文长度 − 给回复预留的部分（8K 与 10% 取较小者） */
export function sendBudget(contextTokens: number): number {
  return Math.max(0, contextTokens - Math.min(8192, Math.floor(contextTokens * 0.1)));
}

const CJK = /[\u2e80-\u2fdf\u3040-\u30ff\u3100-\u312f\u3200-\u32ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

/** 本地估算 token 数：中文约 1 字 1 token，其他文字约 4 个字符 1 token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** 每条消息的固定开销（角色标记等） */
const MESSAGE_OVERHEAD = 4;

export function messageTokens(m: ChatMessage): number {
  const text = typeof m.content === "string"
    ? m.content
    : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  return estimateTokens(text) + MESSAGE_OVERHEAD;
}

export function messagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + messageTokens(m), 0);
}

/** 显示用：12.3K、1M、131K */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return String(n);
}

/** 读取旧版本的单个模型名或新的模型列表，去掉空名和重复 */
export function normalizeModels(raw: unknown, legacy?: unknown): AiModelEntry[] {
  const out: AiModelEntry[] = [];
  const push = (name: unknown, context: unknown) => {
    if (typeof name !== "string" || !name.trim() || out.some((m) => m.name === name.trim())) return;
    const n = Number(context);
    out.push({ name: name.trim(), context: Number.isFinite(n) && n > 0 ? Math.round(n) : null });
  };
  if (Array.isArray(raw)) for (const m of raw) push(m?.name, m?.context);
  if (!out.length && typeof legacy === "string") push(legacy, null);
  return out;
}
