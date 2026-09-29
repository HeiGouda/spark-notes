<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { readMarkdown } from "../editor/createEditor";
import { insertAtStart } from "../editor/markdownEdit";
import { summaryBlocks, summaryMessages, summaryQuote, tooLongMessage } from "../lib/ai";
import { messagesTokens } from "../lib/aiModels";
import { countWords } from "../lib/wordcount";
import { AiCancelled, useAiStore, type AiRun } from "../stores/ai";
import { useEditorStore } from "../stores/editor";
import { useNoticeStore } from "../stores/notice";
import { useTabsStore } from "../stores/tabs";

const ai = useAiStore();
const editorStore = useEditorStore();
const tabs = useTabsStore();

const title = ref("");
const words = ref(0);
const text = ref("");
const error = ref("");
const running = ref(false);
/** 生成总结时的笔记；插入前核对，弹窗开着时切换了笔记不能插到别的笔记里 */
const notePath = ref<string | null>(null);
let current: AiRun | null = null;

const blocks = computed(() => summaryBlocks(text.value));

function start() {
  current?.cancel();
  text.value = "";
  error.value = "";
  const e = editorStore.editor;
  if (!e) return;
  const md = readMarkdown(e);
  notePath.value = editorStore.path;
  title.value = tabs.active?.name ?? "";
  words.value = countWords(md);
  if (!md.trim()) {
    error.value = "笔记是空的";
    return;
  }
  const messages = summaryMessages(title.value, md);
  const tokens = messagesTokens(messages);
  if (tokens > ai.defaultBudget()) {
    error.value = tooLongMessage(tokens, ai.defaultBudget());
    return;
  }
  const run = ai.run(messages, (full) => (text.value = full));
  current = run;
  running.value = true;
  run.done.then(
    (full) => {
      if (current !== run) return;
      text.value = full;
      if (!full.trim()) error.value = "AI 没有返回内容";
    },
    (err: unknown) => {
      if (current !== run || err instanceof AiCancelled) return;
      error.value = err instanceof Error ? err.message : String(err);
    },
  ).finally(() => {
    if (current === run) running.value = false;
  });
}

function stop() {
  current?.cancel();
  current = null;
  running.value = false;
}

watch(() => ai.summaryOpen, (open) => (open ? start() : stop()));

function close() {
  ai.summaryOpen = false;
}

async function copy() {
  try {
    await navigator.clipboard.writeText(text.value.trim());
    useNoticeStore().inform("已复制总结");
  } catch (e) {
    useNoticeStore().report("复制失败", e);
  }
}

function insert() {
  const e = editorStore.editor;
  if (!e) return;
  if (editorStore.path !== notePath.value) {
    useNoticeStore().inform(`当前笔记已不是“${title.value}”，请切回该笔记再插入，或复制后自行粘贴`);
    return;
  }
  try {
    insertAtStart(e, summaryQuote(text.value));
    useNoticeStore().inform("已插入到笔记开头");
    close();
  } catch (err) {
    useNoticeStore().report("插入总结失败", err);
  }
}

function onKey(e: KeyboardEvent) {
  if (!ai.summaryOpen || e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  close();
}

onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey, true);
  stop();
});
</script>

<template>
  <div v-if="ai.summaryOpen" class="mask" @mousedown.self="close()">
    <div class="pop ai-dlg ai-summary" role="dialog" aria-label="总结当前笔记">
      <div class="keys-head">
        <h3>总结当前笔记</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="close()"><Icon name="close" sm /></button>
      </div>
      <div class="ai-dlg-body">
        <p class="ai-sent">已发送：当前笔记“{{ title }}”，约 {{ words.toLocaleString("zh-CN") }} 字</p>
        <div v-if="text || running" class="ai-result">
          <template v-for="(b, i) in blocks" :key="i">
            <p v-if="b.kind === 'p'">{{ b.text }}</p>
            <ul v-else><li>{{ b.text }}</li></ul>
          </template>
          <p v-if="!text && running" class="ai-wait">正在等待回复…</p>
          <span v-if="running" class="caret" />
        </div>
        <p v-if="error" class="git-error">{{ error }}</p>
      </div>
      <div class="ai-dlg-actions">
        <button v-if="running" class="fb-txt" type="button" @click="stop()">停止</button>
        <button v-else class="fb-txt" type="button" @click="start()">重新生成</button>
        <span class="flex" />
        <button class="fb-txt" type="button" :disabled="running || !text.trim()" @click="copy()">复制</button>
        <button class="btn-primary" type="button" :disabled="running || !text.trim()" @click="insert()">插入到笔记开头</button>
      </div>
    </div>
  </div>
</template>
