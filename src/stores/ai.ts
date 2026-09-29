import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { Channel } from "@tauri-apps/api/core";
import { api, type AiEvent, type ChatMessage } from "../lib/api";
import { useSettingsStore } from "./settings";
import { useNoticeStore } from "./notice";
import { sendBudget } from "../lib/aiModels";

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
  const hasKey = ref(false);
  const summaryOpen = ref(false);
  const structureOpen = ref(false);
  const noConfigOpen = ref(false);

  const configured = computed(() => !!settings.aiBaseUrl.trim() && !!settings.aiModel.trim());

  /** 默认模型本次可发送的 token 数（需求文档 5.16） */
  function defaultBudget(): number {
    return sendBudget(settings.contextOf(settings.aiModel).tokens);
  }

  async function refreshKey() {
    try {
      hasKey.value = await api.aiHasKey();
    } catch (e) {
      useNoticeStore().report("读取 API Key 失败", e);
    }
  }

  /** 未配置时弹出提示并返回 false */
  function ensureConfigured(): boolean {
    if (configured.value) return true;
    noConfigOpen.value = true;
    return false;
  }

  /** 流式请求；onText 收到目前为止的全文。不指定模型时用默认模型 */
  function run(messages: ChatMessage[], onText: (full: string) => void, model = settings.aiModel): AiRun {
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
      .aiChat(id, settings.aiBaseUrl, model, messages, channel)
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

  return { hasKey, configured, summaryOpen, structureOpen, noConfigOpen, refreshKey, ensureConfigured, run, defaultBudget };
});
