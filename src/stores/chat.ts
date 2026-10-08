import { defineStore } from "pinia";
import { computed, reactive, ref } from "vue";
import { api, baseName, type ChatSummary } from "../lib/api";
import {
  CHAT_SYSTEM,
  MAX_IMAGE_BYTES,
  MAX_TEXT_FILE_BYTES,
  autoTitle,
  emptyConversation,
  formatSize,
  hasImages,
  isImageName,
  isTextName,
  newId,
  parseConversation,
  planContext,
  toApiMessage,
  type ChatAttachment,
  type ChatMsg,
  type Conversation,
} from "../lib/chat";
import { modelLabel, sendBudget, type AiModelEntry } from "../lib/aiModels";
import { splitFrontMatter } from "../lib/frontmatter";
import { AiCancelled, useAiStore, type AiRun } from "./ai";
import { useSettingsStore } from "./settings";
import { useNoticeStore } from "./notice";
import { useVaultStore } from "./vault";

/** 输入框里待发送的附件；图片已存进会话文件夹，文本与笔记已读出内容 */
export type PendingAttachment = ChatAttachment & { key: string };

const IMAGE_HINT = "当前模型可能不支持图片，可以切换到支持识图的模型后重新生成";

/** AI 对话（需求文档 5.17）：会话只存本机，每个会话的上下文互不共享 */
export const useChatStore = defineStore("chat", () => {
  const settings = useSettingsStore();
  const ai = useAiStore();
  const notice = () => useNoticeStore();

  const list = ref<ChatSummary[]>([]);
  const current = ref<Conversation | null>(null);
  /** 当前会话是否已存盘（新对话在发送第一条消息后才存） */
  const saved = ref(false);
  const draft = ref("");
  const pending = ref<PendingAttachment[]>([]);
  const loadError = ref("");
  /** 正在生成回复的会话。切换会话不取消请求，每个会话各自一份 */
  const runs = new Map<string, AiRun>();
  const runningIds = ref(new Set<string>());
  /** 生成中的会话对象：切回来时用它，避免从磁盘读到还没写完的内容 */
  const live = new Map<string, Conversation>();
  /** 生成过程中被删除的会话，结束后不再写回 */
  const dropped = new Set<string>();
  /** 当前打开的会话是否正在生成 */
  const running = computed(() => {
    const id = current.value?.id;
    return !!id && runningIds.value.has(id);
  });
  /** `会话 id/文件名` → data URL（显示与发送共用，避免不同会话的同名图片串掉） */
  const images = reactive(new Map<string, string>());
  const imageKey = (id: string, file: string) => `${id}/${file}`;
  /** 图片是整张的 data URL，切换会话时丢掉其他会话的，再切回来时重新读取 */
  function keepImagesOf(id: string) {
    for (const key of [...images.keys()]) if (!key.startsWith(`${id}/`)) images.delete(key);
  }
  function setRun(id: string, handle: AiRun | null) {
    if (handle) runs.set(id, handle);
    else runs.delete(id);
    runningIds.value = new Set(runs.keys());
  }

  function isRunning(id: string): boolean {
    return runningIds.value.has(id);
  }

  /** 会话用的模型：会话里记的是模型 id（旧会话是模型名），已从设置里删掉时用默认模型 */
  function modelOf(c: Conversation | null): AiModelEntry | null {
    return (c?.model ? settings.findModel(c.model) : null) ?? settings.defaultModel;
  }

  const model = computed(() => modelOf(current.value));
  const context = computed(() => settings.contextOf(model.value));
  const budget = computed(() => sendBudget(context.value.tokens));

  /** 下一条消息（输入框内容）发送时的上下文情况，用于进度条和分隔线 */
  const plan = computed(() => {
    const history = current.value?.messages ?? [];
    const next = draft.value.trim() || pending.value.length ? draftMessage() : null;
    return planContext(history, next, budget.value);
  });

  function draftMessage(): ChatMsg {
    return {
      id: newId(),
      role: "user",
      content: draft.value.trim(),
      attachments: pending.value.map(({ key: _key, ...a }) => a),
      createdAt: Date.now(),
    };
  }

  async function loadList() {
    try {
      list.value = await api.chatList();
      loadError.value = "";
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e);
    }
  }

  /** 离开一个没存盘的新对话时，删掉它已经保存的附件图片。正在生成的会话不删 */
  async function discardUnsaved() {
    const c = current.value;
    if (!c || saved.value || runs.has(c.id)) return;
    await api.chatDelete(c.id).catch((e) => notice().report("清理未发送的图片失败", e));
  }

  async function newChat() {
    if (current.value && !saved.value && !current.value.messages.length) return;
    await discardUnsaved();
    current.value = emptyConversation(settings.defaultModel?.id ?? "");
    keepImagesOf(current.value.id);
    saved.value = false;
    draft.value = "";
    pending.value = [];
  }

  async function open(id: string) {
    if (current.value?.id === id) return;
    await discardUnsaved();
    const generating = live.get(id);
    if (generating) {
      current.value = generating;
      keepImagesOf(id);
      saved.value = true;
      draft.value = "";
      pending.value = [];
      void loadImages(generating);
      return;
    }
    try {
      current.value = parseConversation(await api.chatRead(id), settings.defaultModel?.id ?? "");
      keepImagesOf(current.value.id);
      saved.value = true;
      draft.value = "";
      pending.value = [];
      void loadImages(current.value);
    } catch (e) {
      notice().report("打开会话失败", e);
    }
  }

  /** 打开 AI 对话时：有会话就打开最近的一个，否则新建 */
  async function ensureOpen() {
    if (current.value) return;
    await loadList();
    if (list.value.length) await open(list.value[0].id);
    else await newChat();
  }

  async function loadImages(c: Conversation) {
    for (const m of c.messages) {
      for (const a of m.attachments ?? []) {
        if (a.kind !== "image" || !a.file || images.has(imageKey(c.id, a.file))) continue;
        try {
          images.set(imageKey(c.id, a.file), await api.chatImageData(c.id, a.file));
        } catch (e) {
          notice().report(`读取图片失败 ${a.name}`, e);
        }
      }
    }
  }

  /** 写入会话文件并更新列表。当前打开的会话另把 saved 标上 */
  async function writeConversation(c: Conversation) {
    c.updatedAt = Date.now();
    await api.chatWrite(c.id, JSON.stringify(c));
    const summary = { id: c.id, title: c.title, updatedAt: c.updatedAt };
    list.value = [summary, ...list.value.filter((s) => s.id !== c.id)];
    if (current.value?.id === c.id) saved.value = true;
  }

  async function persist() {
    const c = current.value;
    if (!c) return;
    try {
      await writeConversation(c);
    } catch (e) {
      notice().report("保存会话失败", e);
    }
  }

  /** id 为设置里模型的 id */
  function setModel(id: string) {
    if (!current.value || current.value.model === id) return;
    current.value.model = id;
    if (saved.value) void persist();
  }

  /* ---------- 附件 ---------- */

  function addPending(a: ChatAttachment) {
    pending.value = [...pending.value, { ...a, key: newId() }];
  }

  async function addImageBytes(name: string, bytes: Uint8Array) {
    const c = current.value;
    if (!c) return;
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`图片太大：${name}（上限 ${formatSize(MAX_IMAGE_BYTES)}）`);
    const file = await api.chatSaveImage(c.id, name, bytes);
    images.set(imageKey(c.id, file), await api.chatImageData(c.id, file));
    addPending({ kind: "image", name, file, size: bytes.length });
  }

  function addText(name: string, text: string, size: number) {
    if (size > MAX_TEXT_FILE_BYTES) throw new Error(`文件太大：${name}（上限 ${formatSize(MAX_TEXT_FILE_BYTES)}）`);
    addPending({ kind: "file", name, text, size });
  }

  /** 粘贴或拖入的文件 */
  async function addFiles(files: File[]) {
    for (const f of files) {
      const name = f.name || "粘贴的图片.png";
      try {
        if (f.type.startsWith("image/") || isImageName(name)) await addImageBytes(isImageName(name) ? name : `${name}.png`, new Uint8Array(await f.arrayBuffer()));
        else if (isTextName(name) || f.type.startsWith("text/")) addText(name, await f.text(), f.size);
        else throw new Error(`不支持的文件：${name}（支持图片与文本类文件）`);
      } catch (e) {
        notice().report("添加附件失败", e);
      }
    }
  }

  /** 通过对话框选择的文件 */
  async function addPaths(paths: string[]) {
    const c = current.value;
    if (!c) return;
    for (const p of paths) {
      const name = baseName(p);
      try {
        if (isImageName(name)) {
          const file = await api.chatImportImage(c.id, p);
          images.set(imageKey(c.id, file), await api.chatImageData(c.id, file));
          addPending({ kind: "image", name, file });
        } else {
          const text = await api.readTextFile(p);
          addText(name, text, new TextEncoder().encode(text).length);
        }
      } catch (e) {
        notice().report("添加附件失败", e);
      }
    }
  }

  /** 引用笔记：立即读出正文，计入上下文用量 */
  async function addNote(path: string) {
    const root = useVaultStore().root;
    if (!root || pending.value.some((a) => a.kind === "note" && a.path === path)) return;
    try {
      const file = await api.readNote(root, path);
      addPending({ kind: "note", name: baseName(path).replace(/\.md$/i, ""), path, text: splitFrontMatter(file.content).body });
    } catch (e) {
      notice().report("引用笔记失败", e);
    }
  }

  function imageSrc(file?: string): string | undefined {
    const id = current.value?.id;
    if (!id || !file) return undefined;
    return images.get(imageKey(id, file));
  }

  async function removePending(key: string) {
    const removed = pending.value.find((a) => a.key === key);
    pending.value = pending.value.filter((a) => a.key !== key);
    const c = current.value;
    if (!c || removed?.kind !== "image" || !removed.file) return;
    images.delete(imageKey(c.id, removed.file));
    await api.chatDeleteImage(c.id, removed.file).catch((e) => notice().report("删除图片失败", e));
  }

  /* ---------- 发送 ---------- */

  async function send() {
    const c = current.value;
    if (!c || runs.has(c.id) || (!draft.value.trim() && !pending.value.length)) return;
    if (!ai.ensureConfigured()) return;
    const next = draftMessage();
    const p = planContext(c.messages, next, budget.value);
    if (p.overflow) {
      notice().report("无法发送", new Error(`这条消息约 ${p.tokens.toLocaleString("zh-CN")} tokens，超过了当前模型的可发送上限`));
      return;
    }
    if (!c.messages.length) c.title = autoTitle(next.content || next.attachments?.[0]?.name || "");
    c.messages.push(next);
    live.set(c.id, c);
    draft.value = "";
    pending.value = [];
    try {
      await writeConversation(c);
    } catch (e) {
      notice().report("保存会话失败", e);
    }
    await answer(c);
  }

  /** 按这个会话的消息请求回复；切换到别的会话后，回复仍然写回这个会话 */
  async function answer(c: Conversation) {
    live.set(c.id, c);
    const last = c.messages[c.messages.length - 1];
    if (!last || last.role !== "user") {
      if (!runs.has(c.id)) live.delete(c.id);
      return;
    }
    const p = planContext(c.messages.slice(0, -1), last, budget.value);
    const sent = [...p.included, last];
    await loadImages(c);
    const messages = [{ role: "system" as const, content: CHAT_SYSTEM }, ...sent.map((m) => toApiMessage(m, (f) => images.get(imageKey(c.id, f))))];
    const using = modelOf(c);
    const reply: ChatMsg = { id: newId(), role: "assistant", content: "", model: using ? modelLabel(using) : "", createdAt: Date.now() };
    c.messages.push(reply);
    const target = c.messages[c.messages.length - 1];
    const handle = ai.run(messages, (full) => (target.content = full), using);
    setRun(c.id, handle);
    live.set(c.id, c);
    try {
      target.content = await handle.done;
      if (!target.content.trim()) target.error = "AI 没有返回内容";
    } catch (e) {
      if (!(e instanceof AiCancelled)) {
        const reason = e instanceof Error ? e.message : String(e);
        target.error = sent.some(hasImages) ? `${reason}。${IMAGE_HINT}` : reason;
      } else if (!target.content) {
        c.messages.splice(c.messages.indexOf(target), 1);
      }
    } finally {
      if (runs.get(c.id) === handle) setRun(c.id, null);
      if (dropped.delete(c.id)) {
        live.delete(c.id);
      } else {
        try {
          await writeConversation(c);
        } catch (e) {
          notice().report("保存会话失败", e);
        }
        if (!runs.has(c.id)) live.delete(c.id);
      }
    }
  }

  /** 停止当前会话的生成，保留已收到的内容。其他会话的生成不受影响 */
  function stop() {
    const id = current.value?.id;
    if (!id) return;
    const handle = runs.get(id);
    if (!handle) return;
    setRun(id, null);
    handle.cancel();
  }

  /** 重新生成最后一条回复 */
  async function regenerate() {
    const c = current.value;
    if (!c || runs.has(c.id)) return;
    if (c.messages[c.messages.length - 1]?.role === "assistant") c.messages.pop();
    await answer(c);
  }

  /* ---------- 会话管理 ---------- */

  async function rename(id: string, title: string) {
    const t = title.trim();
    if (!t) return;
    try {
      const c = current.value?.id === id ? current.value : live.get(id) ?? parseConversation(await api.chatRead(id), settings.defaultModel?.id ?? "");
      c.title = t;
      await api.chatWrite(id, JSON.stringify(c));
      list.value = list.value.map((s) => (s.id === id ? { ...s, title: t } : s));
    } catch (e) {
      notice().report("重命名会话失败", e);
    }
  }

  async function remove(id: string) {
    try {
      const handle = runs.get(id);
      if (handle) {
        dropped.add(id);
        setRun(id, null);
        live.delete(id);
        handle.cancel();
      }
      if (current.value?.id === id) current.value = null;
      await api.chatDelete(id);
      list.value = list.value.filter((s) => s.id !== id);
      if (!current.value) {
        if (list.value.length) await open(list.value[0].id);
        else await newChat();
      }
    } catch (e) {
      notice().report("删除会话失败", e);
    }
  }

  return {
    list, current, saved, draft, pending, running, loadError, images, model, context, budget, plan,
    loadList, newChat, open, ensureOpen, setModel, addFiles, addPaths, addNote, imageSrc, removePending, send, stop, isRunning, regenerate, rename, remove,
  };
});
