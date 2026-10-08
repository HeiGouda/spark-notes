import type { ChatMessage } from "./api";
import { presetByUrl, presetOf } from "./ai";

/** 设置里的一个模型：自带服务商、接口地址；API Key 按接口地址存在系统凭据库 */
export interface AiModelEntry {
  /** 本机生成的标识，默认模型和 AI 对话记的是它 */
  id: string;
  /** 服务商预设 id（见 AI_PRESETS），自定义为 "custom" */
  provider: string;
  baseUrl: string;
  /** 请求里的 model 参数 */
  name: string;
  /** 显示名称，空字符串表示用模型名 */
  label: string;
  /** 手动填写的上下文长度（tokens），null 表示自动 */
  context: number | null;
  /** “从服务商读取”得到的上下文长度 */
  providerContext: number | null;
}

export function modelLabel(entry: Pick<AiModelEntry, "label" | "name">): string {
  return entry.label.trim() || entry.name;
}

export function newModelId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
  [/^qwen3\.[6-9]/, 1_000_000],
  [/^qwen-long/, 10_000_000],
  [/^qwen-turbo/, 1_000_000],
  [/^qwen-plus/, 131_072],
  [/^qwen-max/, 32_768],
  [/^qwen-vl/, 32_768],
  [/^qwen3?-coder-plus/, 1_000_000],
  [/^deepseek-/, 128_000],
  [/^moonshot-v1-8k/, 8_192],
  [/^moonshot-v1-32k/, 32_768],
  [/^moonshot-v1-128k/, 131_072],
  [/^kimi-k3/, 1_000_000],
  [/^kimi-k2\.[6-9]/, 262_144],
  [/^kimi-k2/, 131_072],
  [/^glm-5\.[2-9]/, 1_000_000],
  [/^glm-5/, 200_000],
  [/^glm-4\.[67]/, 200_000],
  [/^glm-4-long/, 1_000_000],
  [/^glm-4/, 128_000],
  [/^ernie-5/, 128_000],
  [/^minimax-m3/, 1_000_000],
  [/^minimax-m2/, 204_800],
  [/^step-5/, 1_000_000],
  [/^hy4/, 1_000_000],
  [/^hy3/, 262_144],
  [/^mistral-large-4/, 1_000_000],
  [/^mistral-medium-3-5/, 262_144],
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
export function resolveContext(entry: Pick<AiModelEntry, "name" | "context" | "providerContext">): ModelContext {
  if (entry.context && entry.context > 0) return { tokens: entry.context, source: "manual" };
  if (entry.providerContext && entry.providerContext > 0) return { tokens: entry.providerContext, source: "provider" };
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

/** 旧版本的 AI 设置：一套接口地址，模型只有名称和手动上下文，服务商返回的上下文按模型名另存 */
export interface LegacyAiSettings {
  baseUrl?: unknown;
  /** 更早版本的单个模型名 */
  model?: unknown;
  providerContexts?: unknown;
}

export interface NormalizedModels {
  models: AiModelEntry[];
  /** 读到的是旧格式，需要写回新格式并迁移 API Key */
  migrated: boolean;
  /** 旧格式的接口地址（迁移 API Key 用） */
  legacyBaseUrl: string | null;
}

function tokens(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

const text = (raw: unknown) => (typeof raw === "string" ? raw.trim() : "");

/**
 * 读取模型列表设置，去掉空名和重复（同一接口地址的同一模型名）。
 * 旧格式（没有 baseUrl 的条目、或只有单个模型名）按旧的接口地址转换成新格式。
 */
export function normalizeModels(raw: unknown, legacy: LegacyAiSettings = {}): NormalizedModels {
  const out: AiModelEntry[] = [];
  const legacyUrl = text(legacy.baseUrl);
  const legacyContexts = legacy.providerContexts && typeof legacy.providerContexts === "object" ? (legacy.providerContexts as Record<string, unknown>) : {};
  let migrated = false;
  const push = (m: Partial<Record<keyof AiModelEntry, unknown>>) => {
    const name = text(m.name);
    let baseUrl = text(m.baseUrl);
    let provider = text(m.provider);
    if (!m.baseUrl) {
      migrated = true;
      baseUrl = legacyUrl;
      provider = presetByUrl(legacyUrl).id;
    }
    if (!name || !baseUrl || out.some((x) => x.name === name && x.baseUrl === baseUrl)) return;
    out.push({
      id: text(m.id) || newModelId(),
      provider: presetOf(provider).id,
      baseUrl,
      name,
      label: text(m.label),
      context: tokens(m.context),
      providerContext: tokens(m.providerContext) ?? (m.baseUrl ? null : tokens(legacyContexts[name])),
    });
  };
  if (Array.isArray(raw)) for (const m of raw) if (m && typeof m === "object") push(m);
  if (!out.length && text(legacy.model)) push({ name: legacy.model });
  return { models: out, migrated, legacyBaseUrl: migrated ? legacyUrl || null : null };
}
