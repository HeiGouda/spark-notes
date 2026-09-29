import { defineStore } from "pinia";
import { computed, reactive, ref, shallowRef } from "vue";
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
import { sendBudget } from "../lib/aiModels";
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
  const running = ref(false);
  const loadError = ref("");
  /** `会话 id/文件名` → data URL（显示与发送共用，避免不同会话的同名图片串掉） */
  const images = reactive(new Map<string, string>());
  const imageKey = (id: string, file: string) => `${id}/${file}`;
  /** 图片是整张的 data URL，切换会话时丢掉其他会话的，再切回来时重新读取 */
  function keepImagesOf(id: string) {
    for (const key of [...images.keys()]) if (!key.startsWith(`${id}/`)) images.delete(key);
  }
  const run = shallowRef<AiRun | null>(null);

  const model = computed(() => current.value?.model || settings.aiModel);
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

  /** 离开一个没存盘的新对话时，删掉它已经保存的附件图片 */
  async function discardUnsaved() {
    const c = current.value;
    if (!c || saved.value) return;
    await api.chatDelete(c.id).catch((e) => notice().report("清理未发送的图片失败", e));
  }

  async function newChat() {
    if (running.value) stop();
    if (current.value && !saved.value && !current.value.messages.length) return;
    await discardUnsaved();
    current.value = emptyConversation(settings.aiModel);
    keepImagesOf(current.value.id);
    saved.value = false;
    draft.value = "";
    pending.value = [];
  }

  async function open(id: string) {
    if (current.value?.id === id) return;
    if (running.value) stop();
    await discardUnsaved();
    try {
      current.value = parseConversation(await api.chatRead(id), settings.aiModel);
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

  async function persist() {
    const c = current.value;
    if (!c) return;
    c.updatedAt = Date.now();
    try {
      await api.chatWrite(c.id, JSON.stringify(c));
      saved.value = true;
      const summary = { id: c.id, title: c.title, updatedAt: c.updatedAt };
      list.value = [summary, ...list.value.filter((s) => s.id !== c.id)];
    } catch (e) {
      notice().report("保存会话失败", e);
    }
  }

  function setModel(name: string) {
    if (!current.value || current.value.model === name) return;
    current.value.model = name;
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
    if (!c || running.value || (!draft.value.trim() && !pending.value.length)) return;
    if (!ai.ensureConfigured()) return;
    const next = draftMessage();
    const p = planContext(c.messages, next, budget.value);
    if (p.overflow) {
      notice().report("无法发送", new Error(`这条消息约 ${p.tokens.toLocaleString("zh-CN")} tokens，超过了当前模型的可发送上限`));
      return;
    }
    if (!c.messages.length) c.title = autoTitle(next.content || next.attachments?.[0]?.name || "");
    c.messages.push(next);
    draft.value = "";
    pending.value = [];
    await persist();
    await answer();
  }

  /** 按当前会话的消息请求回复；每次请求只带本会话的内容 */
  async function answer() {
    const c = current.value;
    if (!c) return;
    const last = c.messages[c.messages.length - 1];
    if (!last || last.role !== "user") return;
    const p = planContext(c.messages.slice(0, -1), last, budget.value);
    const sent = [...p.included, last];
    await loadImages(c);
    const messages = [{ role: "system" as const, content: CHAT_SYSTEM }, ...sent.map((m) => toApiMessage(m, (f) => images.get(imageKey(c.id, f))))];
    const reply: ChatMsg = { id: newId(), role: "assistant", content: "", model: model.value, createdAt: Date.now() };
    c.messages.push(reply);
    const target = c.messages[c.messages.length - 1];
    running.value = true;
    const handle = ai.run(messages, (full) => (target.content = full), model.value);
    run.value = handle;
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
      if (run.value === handle) {
        run.value = null;
        running.value = false;
      }
      if (current.value?.id === c.id) await persist();
      else await api.chatWrite(c.id, JSON.stringify(c)).catch((e) => notice().report("保存会话失败", e));
    }
  }

  /** 停止后保留已收到的内容 */
  function stop() {
    run.value?.cancel();
    run.value = null;
    running.value = false;
  }

  /** 重新生成最后一条回复 */
  async function regenerate() {
    const c = current.value;
    if (!c || running.value) return;
    if (c.messages[c.messages.length - 1]?.role === "assistant") c.messages.pop();
    await answer();
  }

  /* ---------- 会话管理 ---------- */

  async function rename(id: string, title: string) {
    const t = title.trim();
    if (!t) return;
    try {
      const c = current.value?.id === id ? current.value : parseConversation(await api.chatRead(id), settings.aiModel);
      c.title = t;
      await api.chatWrite(id, JSON.stringify(c));
      list.value = list.value.map((s) => (s.id === id ? { ...s, title: t } : s));
    } catch (e) {
      notice().report("重命名会话失败", e);
    }
  }

  async function remove(id: string) {
    try {
      if (current.value?.id === id) {
        stop();
        current.value = null;
      }
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
    loadList, newChat, open, ensureOpen, setModel, addFiles, addPaths, addNote, imageSrc, removePending, send, stop, regenerate, rename, remove,
  };
});
