import { defineStore } from "pinia";
import { ref } from "vue";

export interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
}

const INFO_MS = 4000;
const MAX_TOASTS = 4;

/** 统一的提示：所有失败都要让用户看到，不静默吞掉（需求文档 7.2）。
 *  浮动提示显示在窗口右上角、盖在弹窗之上；状态栏只留最后一条。 */
export const useNoticeStore = defineStore("notice", () => {
  const error = ref<string | null>(null);
  const info = ref<string | null>(null);
  const toasts = ref<Toast[]>([]);
  let seq = 0;

  function push(kind: Toast["kind"], text: string) {
    const id = ++seq;
    toasts.value = [...toasts.value.filter((t) => t.text !== text), { id, kind, text }].slice(-MAX_TOASTS);
    if (kind === "info") window.setTimeout(() => dismiss(id), INFO_MS);
  }

  function dismiss(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function report(context: string, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    info.value = null;
    error.value = `${context}：${msg}`;
    push("error", error.value);
    console.error(context, e);
  }

  function inform(text: string) {
    if (!text) return;
    error.value = null;
    info.value = text;
    push("info", text);
  }

  function clear() {
    error.value = null;
    info.value = null;
  }

  return { error, info, toasts, report, inform, clear, dismiss };
});
