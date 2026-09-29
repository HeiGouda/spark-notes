<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import Icon from "./Icon.vue";
import { api, baseName } from "../lib/api";
import { FILE_FILTER_EXTS, formatSize, noteTitleFrom, userText, type ChatMsg } from "../lib/chat";
import { formatTokens } from "../lib/aiModels";
import { fuzzyMatch } from "../lib/fuzzy";
import { renderMarkdown } from "../lib/markdown";
import { insertAtCursor } from "../editor/markdownEdit";
import { useChatStore } from "../stores/chat";
import { useEditorStore } from "../stores/editor";
import { useNoticeStore } from "../stores/notice";
import { useSettingsStore } from "../stores/settings";
import { useTabsStore } from "../stores/tabs";
import { useVaultStore } from "../stores/vault";

const chat = useChatStore();
const settings = useSettingsStore();
const vault = useVaultStore();
const editorStore = useEditorStore();
const tabs = useTabsStore();
const notice = () => useNoticeStore();

const threadEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
const modelOpen = ref(false);

const messages = computed(() => chat.current?.messages ?? []);
const lastIndex = computed(() => messages.value.length - 1);

/** 更早的消息未发送时，分隔线画在第一条会发送的消息前面 */
const dividerAt = computed(() => {
  const p = chat.plan;
  if (!p.omitted) return -1;
  const first = p.included[0];
  const i = first ? messages.value.findIndex((m) => m.id === first.id) : messages.value.length;
  return i < 0 ? -1 : i;
});

const meter = computed(() => {
  const used = chat.plan.tokens;
  const full = chat.plan.omitted > 0 || used >= chat.budget;
  return {
    fill: Math.min(100, (used / Math.max(chat.budget, 1)) * 100),
    full,
    text: `约 ${formatTokens(used)} / ${formatTokens(chat.context.tokens)} tokens${full ? " · 更早的消息不再发送" : ""}`,
  };
});

const models = computed(() => {
  const names = settings.aiModels.map((m) => m.name);
  return names.includes(chat.model) || !chat.model ? names : [chat.model, ...names];
});

const canSend = computed(() => !!chat.draft.trim() || chat.pending.length > 0);

/** 按消息缓存渲染结果：流式输出时每来一段都会重新渲染，只让正在生成的那条重新解析 */
const rendered = new Map<string, { src: string; html: string }>();
function messageHtml(m: ChatMsg): string {
  const hit = rendered.get(m.id);
  if (hit?.src === m.content) return hit.html;
  const html = renderMarkdown(m.content);
  rendered.set(m.id, { src: m.content, html });
  return html;
}
watch(() => chat.current?.id, () => rendered.clear());

/* ---------- 回复操作 ---------- */

async function copy(m: ChatMsg) {
  try {
    await navigator.clipboard.writeText(m.role === "user" ? userText(m) : m.content);
    notice().inform("已复制");
  } catch (e) {
    notice().report("复制失败", e);
  }
}

function insertToNote(m: ChatMsg) {
  const e = editorStore.editor;
  if (!e) return;
  try {
    insertAtCursor(e, m.content);
    notice().inform(`已插入到笔记“${tabs.active?.name ?? ""}”`);
  } catch (err) {
    notice().report("插入到笔记失败", err);
  }
}

async function saveAsNote(m: ChatMsg) {
  const root = vault.root;
  if (!root) return;
  try {
    const rel = await api.createNote(root, vault.targetDir(), noteTitleFrom(m.content));
    await api.writeNote(root, rel, m.content.endsWith("\n") ? m.content : `${m.content}\n`);
    await vault.refresh();
    notice().inform(`已保存为笔记“${baseName(rel).replace(/\.md$/i, "")}”`);
  } catch (e) {
    notice().report("保存为新笔记失败", e);
  }
}

/** 回复里的链接用系统浏览器打开 */
function onThreadClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (/^(https?:|mailto:)/i.test(href)) openUrl(href).catch((err) => notice().report("打开链接失败", err));
}

/* ---------- 输入框 ---------- */

const mention = ref<{ query: string; index: number } | null>(null);
const mentionItems = computed(() => {
  if (!mention.value) return [];
  const q = mention.value.query;
  return vault.notePaths
    .map((path) => {
      const name = baseName(path).replace(/\.md$/i, "");
      return { path, name, dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", hit: fuzzyMatch(q, name) };
    })
    .filter((x) => x.hit)
    .sort((a, b) => b.hit!.score - a.hit!.score)
    .slice(0, 8);
});

function updateMention() {
  const el = inputEl.value;
  if (!el || !vault.root) return (mention.value = null);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(el.value.slice(0, el.selectionStart));
  mention.value = m ? { query: m[1], index: 0 } : null;
}

function pickMention(i = mention.value?.index ?? 0) {
  const item = mentionItems.value[i];
  const el = inputEl.value;
  if (!item || !el) return;
  const caret = el.selectionStart;
  const before = el.value.slice(0, caret).replace(/@[^\s@]*$/, "");
  chat.draft = before + el.value.slice(caret);
  mention.value = null;
  void chat.addNote(item.path);
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(before.length, before.length);
  });
}

function insertAt() {
  const el = inputEl.value;
  if (!el) return;
  const caret = el.selectionStart;
  const needSpace = caret > 0 && !/\s/.test(el.value[caret - 1]);
  const insert = `${needSpace ? " " : ""}@`;
  chat.draft = el.value.slice(0, caret) + insert + el.value.slice(caret);
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(caret + insert.length, caret + insert.length);
    updateMention();
  });
}

function onKeyDown(e: KeyboardEvent) {
  if (mention.value && mentionItems.value.length) {
    const n = mentionItems.value.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      mention.value.index = (mention.value.index + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pickMention();
      return;
    }
  }
  if (e.key === "Escape" && mention.value) {
    e.preventDefault();
    mention.value = null;
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!chat.running) void chat.send();
  }
}

function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  void chat.addFiles(files);
}

function onDrop(e: DragEvent) {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  void chat.addFiles(files);
}

async function pickFiles() {
  const picked = await open({ multiple: true, title: "添加图片或文件", filters: [{ name: "图片与文本文件", extensions: FILE_FILTER_EXTS }] });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (paths.length) await chat.addPaths(paths);
  inputEl.value?.focus();
}

function pickModel(name: string) {
  modelOpen.value = false;
  chat.setModel(name);
}

function onWindowKey(e: KeyboardEvent) {
  if (e.key === "Escape" && modelOpen.value) {
    e.preventDefault();
    e.stopImmediatePropagation();
    modelOpen.value = false;
  }
}

function onDocDown(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (modelOpen.value && !t.closest(".model-menu, .model-sel")) modelOpen.value = false;
  if (mention.value && !t.closest(".mention, .composer textarea")) mention.value = null;
}

/* ---------- 自动滚动：停留在底部时跟随新内容 ---------- */

let stick = true;
function onScroll() {
  const el = threadEl.value;
  if (el) stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}
watch(
  () => [chat.current?.id, messages.value.length, messages.value[lastIndex.value]?.content.length],
  async ([id], [prevId]) => {
    if (id !== prevId) stick = true;
    if (!stick) return;
    await nextTick();
    threadEl.value?.scrollTo({ top: threadEl.value.scrollHeight });
  },
);

/** 输入框高度随内容增长 */
watch(() => chat.draft, async () => {
  await nextTick();
  const el = inputEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
});

onMounted(() => {
  document.addEventListener("mousedown", onDocDown, true);
  window.addEventListener("keydown", onWindowKey, true);
  inputEl.value?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocDown, true);
  window.removeEventListener("keydown", onWindowKey, true);
});
</script>

<template>
  <section class="chat" @dragover.prevent @drop="onDrop">
    <div class="chat-head"><span class="chat-title">{{ chat.current?.title ?? "AI 对话" }}</span></div>

    <div v-if="messages.length" ref="threadEl" class="chat-scroll" @scroll="onScroll" @click="onThreadClick">
      <div class="chat-inner">
        <template v-for="(m, i) in messages" :key="m.id">
          <div v-if="i === dividerAt" class="ctx-divider">更早的 {{ chat.plan.omitted }} 条消息未发送给 AI（超出上下文上限）</div>
          <div v-if="m.role === 'user'" class="msg-user">
            <div v-if="m.attachments?.length" class="msg-atts">
              <template v-for="(a, j) in m.attachments" :key="j">
                <img v-if="a.kind === 'image'" class="att-img" :src="chat.imageSrc(a.file)" :alt="a.name" :title="a.name" />
                <span v-else class="att-chip" :class="{ note: a.kind === 'note' }" :title="a.path ?? a.name">
                  <Icon name="file" sm />{{ a.name }}<small v-if="a.size">{{ formatSize(a.size) }}</small>
                </span>
              </template>
            </div>
            <div v-if="m.content" class="bubble">{{ m.content }}</div>
          </div>
          <div v-else class="msg-ai">
            <span class="avatar"><Icon name="sparkle" sm /></span>
            <div class="main-col">
              <!-- markdown-it 已关闭 HTML，回复中的标签按文字显示 -->
              <div v-if="m.content" class="msg-body" v-html="messageHtml(m)" />
              <p v-else-if="chat.running && i === lastIndex" class="msg-wait">正在等待回复…</p>
              <span v-if="chat.running && i === lastIndex" class="caret" />
              <div v-if="m.error" class="msg-err">
                <span>{{ m.error }}</span>
                <button v-if="i === lastIndex && !chat.running" class="fb-txt" type="button" @click="chat.regenerate()">重新生成</button>
              </div>
              <div v-if="m.content && !(chat.running && i === lastIndex)" class="msg-acts">
                <button class="btn" type="button" title="复制" @click="copy(m)"><Icon name="copy" sm />复制</button>
                <button class="btn" type="button" :disabled="!editorStore.editor" :title="editorStore.editor ? `插入到“${tabs.active?.name ?? ''}”的光标处` : '没有打开的笔记'" @click="insertToNote(m)"><Icon name="insert" sm />插入到笔记</button>
                <button class="btn" type="button" :disabled="!vault.root" :title="vault.root ? '在当前文件夹新建一篇笔记' : '尚未打开笔记库'" @click="saveAsNote(m)"><Icon name="file-plus" sm />保存为新笔记</button>
                <button v-if="i === lastIndex && !chat.running" class="btn" type="button" title="重新生成这条回复" @click="chat.regenerate()"><Icon name="sync" sm />重新生成</button>
                <span v-if="i === lastIndex && m.model" class="msg-model">{{ m.model }}</span>
              </div>
            </div>
          </div>
        </template>
        <div v-if="dividerAt === messages.length" class="ctx-divider">更早的 {{ chat.plan.omitted }} 条消息未发送给 AI（超出上下文上限）</div>
      </div>
    </div>
    <div v-else class="chat-empty">
      <h2>有什么可以帮你的？</h2>
      <p>只在你点击发送时，才把消息和附件发给 设置 → AI 里配置的服务商</p>
    </div>

    <div class="composer-wrap">
      <div v-if="modelOpen" class="menu model-menu" role="menu">
        <button v-for="name in models" :key="name" class="menu-item" role="menuitemradio" :aria-checked="name === chat.model" @click="pickModel(name)">
          <span class="mark"><Icon v-if="name === chat.model" name="check" sm /></span>
          <span class="label">{{ name }}</span>
          <span class="hint">{{ formatTokens(settings.contextOf(name).tokens) }}</span>
        </button>
        <div class="menu-sep" />
        <div class="model-foot">只影响这个对话；可选模型在 设置 → AI 里填写</div>
      </div>
      <div v-if="mention && mentionItems.length" class="menu mention" role="listbox">
        <div class="menu-title">引用笔记</div>
        <button
          v-for="(item, i) in mentionItems"
          :key="item.path"
          class="menu-item"
          :class="{ 'is-open': i === mention.index }"
          role="option"
          @mousedown.prevent
          @mouseenter="mention.index = i"
          @click="pickMention(i)"
        >
          <span class="mark"><Icon name="file" sm /></span><span class="label">{{ item.name }}</span><span class="hint">{{ item.dir }}</span>
        </button>
      </div>
      <div class="composer">
        <div v-if="chat.pending.length" class="comp-atts">
          <span v-for="a in chat.pending" :key="a.key" class="comp-att">
            <img v-if="a.kind === 'image'" class="att-img" :src="chat.imageSrc(a.file)" :alt="a.name" :title="a.name" />
            <span v-else class="att-chip" :class="{ note: a.kind === 'note' }" :title="a.path ?? a.name"><Icon name="file" sm />{{ a.name }}<small v-if="a.size">{{ formatSize(a.size) }}</small></span>
            <button class="x" type="button" title="移除" @click="chat.removePending(a.key)"><Icon name="close" sm /></button>
          </span>
        </div>
        <textarea
          ref="inputEl"
          v-model="chat.draft"
          rows="2"
          placeholder="给 AI 发消息，输入 @ 引用笔记，可以粘贴或拖入图片和文件"
          @keydown="onKeyDown"
          @input="updateMention"
          @click="updateMention"
          @paste="onPaste"
        />
        <div class="comp-bar">
          <button class="btn" type="button" title="添加图片或文件" @click="pickFiles()"><Icon name="clip" /></button>
          <button class="btn" type="button" title="引用笔记（@）" :disabled="!vault.root" @click="insertAt()"><span class="at">@</span></button>
          <span class="hint">Enter 发送 · Shift+Enter 换行</span>
          <button class="model-sel" :class="{ 'is-open': modelOpen }" type="button" title="本次对话使用的模型" @click="modelOpen = !modelOpen">
            {{ chat.model || "未设置模型" }}<Icon name="down" sm />
          </button>
          <button v-if="chat.running" class="send" type="button" title="停止生成" @click="chat.stop()"><Icon name="stop" /></button>
          <button v-else class="send" type="button" title="发送 (Enter)" :disabled="!canSend" @click="chat.send()"><Icon name="send" /></button>
        </div>
      </div>
      <div class="ctx-meter" :class="{ full: meter.full }">
        <span>上下文</span><span class="ctx-bar"><span :style="{ width: `${meter.fill}%` }" /></span><span>{{ meter.text }}</span>
        <span class="flex" /><span>按字数估算，图片不计入</span>
      </div>
    </div>
  </section>
</template>
