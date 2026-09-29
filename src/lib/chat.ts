import type { ChatContentPart, ChatMessage, ChatSummary } from "./api";
import { messageTokens } from "./aiModels";

/** AI 对话的数据结构（需求文档 5.17），整份存成 JSON */
export interface ChatAttachment {
  kind: "image" | "file" | "note";
  name: string;
  /** 图片在会话文件夹里的文件名 */
  file?: string;
  /** 文本文件或笔记的内容（发送时附在消息里） */
  text?: string;
  /** 引用的笔记路径 */
  path?: string;
  size?: number;
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ChatAttachment[];
  /** 回复所用的模型 */
  model?: string;
  /** 请求失败的原因；失败的回复不会发给 AI */
  error?: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMsg[];
}

export const CHAT_SYSTEM = "你是 Spark 里的 AI 助手。用简体中文回答，使用 Markdown 排版。";
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];
const TEXT_EXTS = [
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "xml", "html", "css", "log",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "vue", "py", "rs", "go", "java", "kt", "c", "h", "cpp", "hpp", "cs",
  "rb", "php", "swift", "sh", "ps1", "bat", "sql", "lua", "dart", "scala", "r",
];

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
export const isImageName = (name: string) => IMAGE_EXTS.includes(extOf(name));
export const isTextName = (name: string) => TEXT_EXTS.includes(extOf(name));
export const FILE_FILTER_EXTS = [...IMAGE_EXTS, ...TEXT_EXTS];

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyConversation(model: string, now = Date.now()): Conversation {
  return { id: newId(), title: "新对话", model, createdAt: now, updatedAt: now, messages: [] };
}

/** 读取存盘的会话，缺失的字段补默认值 */
export function parseConversation(json: string, fallbackModel: string): Conversation {
  const v = JSON.parse(json) as Partial<Conversation>;
  if (!v || typeof v.id !== "string") throw new Error("会话数据格式错误");
  return {
    id: v.id,
    title: typeof v.title === "string" ? v.title : "新对话",
    model: typeof v.model === "string" && v.model ? v.model : fallbackModel,
    createdAt: Number(v.createdAt) || 0,
    updatedAt: Number(v.updatedAt) || 0,
    messages: Array.isArray(v.messages) ? v.messages.filter((m) => m && (m.role === "user" || m.role === "assistant")) : [],
  };
}

/** 用户消息连同文本附件、引用笔记的全文 */
export function userText(m: ChatMsg): string {
  let out = m.content;
  for (const a of m.attachments ?? []) {
    if (a.kind === "image" || a.text === undefined) continue;
    const label = a.kind === "note" ? "引用的笔记" : "附件";
    out += `\n\n${label}《${a.name}》：\n\`\`\`\n${a.text}\n\`\`\``;
  }
  return out;
}

export const hasImages = (m: ChatMsg) => !!m.attachments?.some((a) => a.kind === "image");

/** 转成请求格式；图片以 data URL 发送，imageUrl 取不到时跳过该图片 */
export function toApiMessage(m: ChatMsg, imageUrl: (file: string) => string | undefined): ChatMessage {
  if (m.role === "assistant") return { role: "assistant", content: m.content };
  const text = userText(m);
  const images = (m.attachments ?? []).filter((a) => a.kind === "image" && a.file);
  if (!images.length) return { role: "user", content: text };
  const parts: ChatContentPart[] = [{ type: "text", text }];
  for (const a of images) {
    const url = imageUrl(a.file!);
    if (url) parts.push({ type: "image_url", image_url: { url } });
  }
  return { role: "user", content: parts };
}

export interface ContextPlan {
  /** 本次会发送的历史消息（不含失败的回复） */
  included: ChatMsg[];
  /** 因超出上限而不发送的历史消息数 */
  omitted: number;
  /** 估算的总 token 数：系统提示词 + 历史 + 本条消息 */
  tokens: number;
  /** 本条消息本身就超出上限 */
  overflow: boolean;
}

const noImages = () => undefined;

/**
 * 从最近往前挑历史消息，总量不超过 budget（需求文档 5.17）。
 * 每个会话只带本会话的消息；next 为即将发送的用户消息（重新生成时为 null）。
 */
export function planContext(history: ChatMsg[], next: ChatMsg | null, budget: number): ContextPlan {
  const usable = history.filter((m) => !m.error && (m.content || m.attachments?.length));
  const fixed = messageTokens({ role: "system", content: CHAT_SYSTEM }) + (next ? messageTokens(toApiMessage(next, noImages)) : 0);
  if (fixed > budget) return { included: [], omitted: usable.length, tokens: fixed, overflow: true };
  let tokens = fixed;
  let start = usable.length;
  while (start > 0) {
    const cost = messageTokens(toApiMessage(usable[start - 1], noImages));
    if (tokens + cost > budget) break;
    tokens += cost;
    start--;
  }
  return { included: usable.slice(start), omitted: start, tokens, overflow: false };
}

/** 用第一条消息自动命名 */
export function autoTitle(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (!line) return "新对话";
  return line.length > 30 ? `${line.slice(0, 30)}…` : line;
}

/** 回复保存为笔记时的笔记名：第一行去掉 Markdown 标记与文件名不允许的字符 */
export function noteTitleFrom(markdown: string): string {
  const line = markdown.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const plain = line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+>]\s+|^\d+[.)]\s+/, "")
    .replace(/[*_`~[\]]/g, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!plain) return "AI 回复";
  return plain.length > 40 ? plain.slice(0, 40).trim() : plain;
}

export interface ChatGroup {
  label: string;
  items: ChatSummary[];
}

/** 会话按“今天 / 昨天 / 更早”分组，列表已按更新时间倒序 */
export function groupByDay(list: ChatSummary[], now = new Date()): ChatGroup[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86_400_000;
  const groups: ChatGroup[] = [
    { label: "今天", items: [] },
    { label: "昨天", items: [] },
    { label: "更早", items: [] },
  ];
  for (const c of list) groups[c.updatedAt >= today ? 0 : c.updatedAt >= yesterday ? 1 : 2].items.push(c);
  return groups.filter((g) => g.items.length);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
