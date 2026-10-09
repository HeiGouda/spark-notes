import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { Channel } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import { api, type AiEvent, type ChatMessage, type ChatSummary } from "../lib/api";
import { presetOf } from "../lib/ai";
import { resolveContext, type AiModelEntry, type ModelContext } from "../lib/aiModels";
import { AiCancelled } from "../stores/ai";

let store: Store | null = null;

async function open(): Promise<Store> {
  store ??= await load("mobile.json", { defaults: {}, autoSave: false });
  return store;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function tokens(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

/** 丢掉缺字段或损坏的条目，不让一条坏数据影响整个列表 */
function modelEntry(raw: unknown): AiModelEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = text(m.id);
  const baseUrl = text(m.baseUrl);
  const name = text(m.name);
  if (!id || !baseUrl || !name) return null;
  return {
    id,
    provider: presetOf(text(m.provider)).id,
    baseUrl,
    name,
    label: text(m.label),
    context: tokens(m.context),
    providerContext: tokens(m.providerContext),
  };
}

let seq = 0;

export interface AiRun {
  done: Promise<string>;
  cancel: () => void;
}

/** 手机端的 AI：模型列表存在本机（不和电脑同步），API Key 存在安卓系统密钥库，会话复用桌面的存储 */
export const useMobileAi = defineStore("mobileAi", () => {
  const models = ref<AiModelEntry[]>([]);
  const defaultId = ref("");
  const chats = ref<ChatSummary[]>([]);

  const defaultModel = computed<AiModelEntry | null>(() => models.value.find((m) => m.id === defaultId.value) ?? models.value[0] ?? null);
  const configured = computed(() => !!defaultModel.value);

  function find(ref: string): AiModelEntry | null {
    if (!ref) return null;
    return models.value.find((m) => m.id === ref) ?? models.value.find((m) => m.name === ref) ?? null;
  }

  function contextOf(entry: AiModelEntry | null): ModelContext {
    return resolveContext(entry ?? { name: "", context: null, providerContext: null });
  }

  async function persist() {
    const s = await open();
    await s.set("aiModels", JSON.parse(JSON.stringify(models.value)));
    await s.set("aiDefaultModel", defaultId.value);
    await s.save();
  }

  async function init() {
    const s = await open();
    const raw = await s.get<unknown>("aiModels");
    models.value = Array.isArray(raw) ? raw.flatMap((m) => modelEntry(m) ?? []) : [];
    const saved = await s.get<unknown>("aiDefaultModel");
    defaultId.value = typeof saved === "string" && models.value.some((m) => m.id === saved) ? saved : (models.value[0]?.id ?? "");
  }

  /** 添加或修改一个模型；列表原来为空时它成为默认模型 */
  function upsert(entry: AiModelEntry) {
    const i = models.value.findIndex((m) => m.id === entry.id);
    models.value = i < 0 ? [...models.value, entry] : models.value.map((m) => (m.id === entry.id ? entry : m));
    if (!models.value.some((m) => m.id === defaultId.value)) defaultId.value = models.value[0]?.id ?? "";
    void persist();
  }

  /** 删除模型；删的是默认模型时改用列表第一个 */
  function remove(id: string) {
    models.value = models.value.filter((m) => m.id !== id);
    if (defaultId.value === id || !models.value.some((m) => m.id === defaultId.value)) defaultId.value = models.value[0]?.id ?? "";
    void persist();
  }

  function setDefault(id: string) {
    if (!models.value.some((m) => m.id === id)) return;
    defaultId.value = id;
    void persist();
  }

  async function loadChats() {
    chats.value = await api.chatList();
  }

  /** 流式请求；onText 收到目前为止的全文。不指定模型时用默认模型 */
  function run(messages: ChatMessage[], onText: (full: string) => void, model: AiModelEntry | null = defaultModel.value): AiRun {
    if (!model) return { done: Promise.reject(new Error("还没有添加 AI 模型，请在 我的 → AI 模型 里添加")), cancel: () => {} };
    const id = `ai-${Date.now()}-${++seq}`;
    let cancelled = false;
    let text = "";
    const channel = new Channel<AiEvent>();
    channel.onmessage = (e) => {
      if (cancelled || e.kind !== "delta") return;
      text += e.text;
      onText(text);
    };
    const done = api.aiChat(id, model.baseUrl, model.name, messages, channel).then(
      () => {
        if (cancelled) throw new AiCancelled();
        return text;
      },
      (e: unknown) => {
        if (cancelled) throw new AiCancelled();
        throw e instanceof Error ? e : new Error(String(e));
      },
    );
    return {
      done,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        api.aiCancel(id).catch((e) => console.warn("取消 AI 请求失败", e));
      },
    };
  }

  return { models, defaultModel, configured, chats, init, find, contextOf, upsert, remove, setDefault, loadChats, run };
});
