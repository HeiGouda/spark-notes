import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "../lib/api";
import {
  CHAT_SYSTEM,
  autoTitle,
  emptyConversation,
  parseConversation,
  planContext,
  toApiMessage,
  type ChatMsg,
  type Conversation,
} from "../lib/chat";
import { modelLabel, sendBudget } from "../lib/aiModels";
import { AiCancelled } from "../stores/ai";
import { useMobileAi, type AiRun } from "./ai";

function newId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 手机端的 AI 对话。会话存在本机（和桌面同一套存储），不随笔记库同步，也不附带书或笔记的内容 */
export const useMobileChat = defineStore("mobileChat", () => {
  const ai = useMobileAi();

  const current = ref<Conversation | null>(null);
  /** 当前会话是否已存盘（新对话在发送第一条消息后才存） */
  const saved = ref(false);
  const draft = ref("");

  const runs = new Map<string, AiRun>();
  const runningIds = ref(new Set<string>());
  /** 生成中的会话：切回来时用它，避免读到还没写完的内容 */
  const live = new Map<string, Conversation>();
  /** 生成过程中被删除的会话，结束后不再写回 */
  const dropped = new Set<string>();

  const running = computed(() => {
    const id = current.value?.id;
    return !!id && runningIds.value.has(id);
  });

  function setRun(id: string, handle: AiRun | null) {
    if (handle) runs.set(id, handle);
    else runs.delete(id);
    runningIds.value = new Set(runs.keys());
  }

  function isRunning(id: string): boolean {
    return runningIds.value.has(id);
  }

  const model = computed(() => (current.value?.model ? ai.find(current.value.model) : null) ?? ai.defaultModel);
  const context = computed(() => ai.contextOf(model.value));
  const budget = computed(() => sendBudget(context.value.tokens));

  /** 下一条消息（输入框内容）发送时的上下文情况 */
  const plan = computed(() => {
    const history = current.value?.messages ?? [];
    const next = draft.value.trim() ? draftMessage() : null;
    return planContext(history, next, budget.value);
  });

  function draftMessage(): ChatMsg {
    return { id: newId(), role: "user", content: draft.value.trim(), createdAt: Date.now() };
  }

  function startNew() {
    current.value = emptyConversation(ai.defaultModel?.id ?? "");
    saved.value = false;
    draft.value = "";
  }

  /** 打开助手时：有会话就打开最近的一个，否则新建 */
  async function openLatest() {
    if (current.value) return;
    await ai.loadChats();
    if (ai.chats.length) await open(ai.chats[0].id);
    else startNew();
  }

  async function open(id: string) {
    if (current.value?.id === id) return;
    const generating = live.get(id);
    if (generating) {
      current.value = generating;
      saved.value = true;
      draft.value = "";
      return;
    }
    current.value = parseConversation(await api.chatRead(id), ai.defaultModel?.id ?? "");
    saved.value = true;
    draft.value = "";
  }

  /** 选字后的“问 AI”：新建一个对话，把选中的文字作为引用填进输入框，不发送 */
  function ask(text: string) {
    startNew();
    const quoted = text.trim().split("\n").map((l) => `> ${l}`).join("\n");
    draft.value = `${quoted}\n\n`;
  }

  async function writeConversation(c: Conversation) {
    c.updatedAt = Date.now();
    await api.chatWrite(c.id, JSON.stringify(c));
    if (current.value?.id === c.id) saved.value = true;
    await ai.loadChats();
  }

  function setModel(id: string) {
    if (!current.value || current.value.model === id) return;
    current.value.model = id;
    if (saved.value) void writeConversation(current.value);
  }

  /** 按这个会话的消息请求回复；切换会话后回复仍然写回这个会话 */
  async function answer(c: Conversation) {
    live.set(c.id, c);
    const last = c.messages[c.messages.length - 1];
    if (!last || last.role !== "user") {
      if (!runs.has(c.id)) live.delete(c.id);
      return;
    }
    const using = (c.model ? ai.find(c.model) : null) ?? ai.defaultModel;
    const p = planContext(c.messages.slice(0, -1), last, sendBudget(ai.contextOf(using).tokens));
    const sent = [...p.included, last];
    const messages = [{ role: "system" as const, content: CHAT_SYSTEM }, ...sent.map((m) => toApiMessage(m, () => undefined))];
    const reply: ChatMsg = { id: newId(), role: "assistant", content: "", model: using ? modelLabel(using) : "", createdAt: Date.now() };
    c.messages.push(reply);
    const target = c.messages[c.messages.length - 1];
    const handle = ai.run(messages, (full) => (target.content = full), using);
    setRun(c.id, handle);
    try {
      target.content = await handle.done;
      if (!target.content.trim()) target.error = "AI 没有返回内容";
    } catch (e) {
      if (!(e instanceof AiCancelled)) target.error = e instanceof Error ? e.message : String(e);
      else if (!target.content) c.messages.splice(c.messages.indexOf(target), 1);
    } finally {
      if (runs.get(c.id) === handle) setRun(c.id, null);
      if (dropped.delete(c.id)) {
        live.delete(c.id);
      } else {
        await writeConversation(c);
        if (!runs.has(c.id)) live.delete(c.id);
      }
    }
  }

  async function send() {
    const c = current.value;
    if (!c || runs.has(c.id) || !draft.value.trim()) return;
    if (!ai.configured) throw new Error("还没有添加 AI 模型");
    const next = draftMessage();
    const p = planContext(c.messages, next, budget.value);
    if (p.overflow) throw new Error(`这条消息约 ${p.tokens.toLocaleString("zh-CN")} tokens，超过了当前模型的可发送上限`);
    if (!c.messages.length) c.title = autoTitle(next.content);
    c.messages.push(next);
    live.set(c.id, c);
    draft.value = "";
    await writeConversation(c);
    void answer(c);
  }

  function stop() {
    const id = current.value?.id;
    if (!id) return;
    const handle = runs.get(id);
    if (!handle) return;
    setRun(id, null);
    handle.cancel();
  }

  async function regenerate() {
    const c = current.value;
    if (!c || runs.has(c.id)) return;
    if (c.messages[c.messages.length - 1]?.role === "assistant") c.messages.pop();
    await answer(c);
  }

  async function rename(id: string, title: string) {
    const t = title.trim();
    if (!t) return;
    const c = current.value?.id === id ? current.value : live.get(id) ?? parseConversation(await api.chatRead(id), ai.defaultModel?.id ?? "");
    c.title = t;
    await writeConversation(c);
  }

  async function remove(id: string) {
    const handle = runs.get(id);
    if (handle) {
      dropped.add(id);
      setRun(id, null);
      live.delete(id);
      handle.cancel();
    }
    if (current.value?.id === id) current.value = null;
    await api.chatDelete(id);
    await ai.loadChats();
    if (!current.value) {
      if (ai.chats.length) await open(ai.chats[0].id);
      else startNew();
    }
  }

  return {
    current, saved, draft, running, model, context, budget, plan,
    openLatest, startNew, open, ask, setModel, send, stop, isRunning, regenerate, rename, remove,
  };
});
