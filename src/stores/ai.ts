import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { Channel } from "@tauri-apps/api/core";
import { api, type AiEvent, type ChatMessage } from "../lib/api";
import { useSettingsStore } from "./settings";
import { useNoticeStore } from "./notice";
import { sendBudget, type AiModelEntry } from "../lib/aiModels";

/** 用户取消了请求 */
export class AiCancelled extends Error {
  constructor() {
    super("已取消");
  }
}

export interface AiRun {
  /** 完成时给出全文；取消时以 AiCancelled 拒绝 */
  done: Promise<string>;
  cancel: () => void;
}

let seq = 0;

/** AI 功能（需求文档 5.16）：只在用户主动点击时调用 */
export const useAiStore = defineStore("ai", () => {
  const settings = useSettingsStore();
  const summaryOpen = ref(false);
  const structureOpen = ref(false);
  const noConfigOpen = ref(false);

  const configured = computed(() => !!settings.defaultModel);

  /** 默认模型本次可发送的 token 数（需求文档 5.16） */
  function defaultBudget(): number {
    return sendBudget(settings.contextOf(settings.defaultModel).tokens);
  }

  /** 还没有添加模型时弹出提示并返回 false */
  function ensureConfigured(): boolean {
    if (configured.value) return true;
    noConfigOpen.value = true;
    return false;
  }

  /** 流式请求；onText 收到目前为止的全文。不指定模型时用默认模型 */
  function run(messages: ChatMessage[], onText: (full: string) => void, model: AiModelEntry | null = settings.defaultModel): AiRun {
    if (!model) return { done: Promise.reject(new Error("还没有添加 AI 模型，请在 设置 → AI 里添加")), cancel: () => {} };
    const id = `ai-${Date.now()}-${++seq}`;
    let cancelled = false;
    let text = "";
    const channel = new Channel<AiEvent>();
    channel.onmessage = (e) => {
      if (cancelled || e.kind !== "delta") return;
      text += e.text;
      onText(text);
    };
    const done = api
      .aiChat(id, model.baseUrl, model.name, messages, channel)
      .then(
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
        api.aiCancel(id).catch((e) => useNoticeStore().report("取消 AI 请求失败", e));
      },
    };
  }

  return { configured, summaryOpen, structureOpen, noConfigOpen, ensureConfigured, run, defaultBudget };
});
