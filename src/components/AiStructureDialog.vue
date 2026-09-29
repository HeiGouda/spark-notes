<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { readMarkdown } from "../editor/createEditor";
import { replaceAll } from "../editor/markdownEdit";
import { api } from "../lib/api";
import { checkProtected, describeIssue, protectedSummary, structureMessages, tooLongMessage, unwrapFence } from "../lib/ai";
import { estimateTokens, messagesTokens } from "../lib/aiModels";
import { diffLines } from "../lib/diff";
import { shortcutOf } from "../lib/commands";
import { displayShortcut } from "../lib/shortcut";
import { countWords } from "../lib/wordcount";
import { AiCancelled, useAiStore, type AiRun } from "../stores/ai";
import { useEditorStore } from "../stores/editor";
import { useNoticeStore } from "../stores/notice";
import { useTabsStore } from "../stores/tabs";
import { useVaultStore } from "../stores/vault";

const ai = useAiStore();
const editorStore = useEditorStore();
const tabs = useTabsStore();
const vault = useVaultStore();

const original = ref("");
const path = ref<string | null>(null);
const result = ref("");
const error = ref("");
const running = ref(false);
const replacing = ref(false);
let current: AiRun | null = null;

const finished = computed(() => !running.value && !error.value && !!result.value.trim());
const cleaned = computed(() => unwrapFence(result.value));
const diff = computed(() => (finished.value ? diffLines(original.value, cleaned.value) : []));
const left = computed(() => diff.value.filter((l) => l.kind !== "add"));
const right = computed(() => diff.value.filter((l) => l.kind !== "del"));
const issues = computed(() => (finished.value ? checkProtected(original.value, cleaned.value) : []));
const words = computed(() => countWords(original.value));
const undoKey = computed(() => displayShortcut(shortcutOf("edit.undo")));

function start() {
  current?.cancel();
  result.value = "";
  error.value = "";
  const e = editorStore.editor;
  if (!e) return;
  original.value = readMarkdown(e);
  path.value = editorStore.path;
  if (!original.value.trim()) {
    error.value = "笔记是空的";
    return;
  }
  const messages = structureMessages(original.value);
  // 整理结果与原文差不多长，回复也要装得下
  const tokens = messagesTokens(messages) + estimateTokens(original.value);
  if (tokens > ai.defaultBudget()) {
    error.value = `${tooLongMessage(tokens, ai.defaultBudget())}，不能整理`;
    return;
  }
  const run = ai.run(messages, (full) => (result.value = full));
  current = run;
  running.value = true;
  run.done.then(
    (full) => {
      if (current !== run) return;
      result.value = full;
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
  if (running.value) error.value = "已停止";
  running.value = false;
}

watch(() => ai.structureOpen, (open) => (open ? start() : stop()));

function close() {
  ai.structureOpen = false;
}

/** 先保存并强制存一份历史快照，再整体替换（可撤销） */
async function replace() {
  const e = editorStore.editor;
  const root = vault.root;
  if (!e || !root || !path.value || editorStore.path !== path.value || issues.value.length) return;
  replacing.value = true;
  try {
    await tabs.save(path.value);
    await api.historySnapshot(root, path.value);
    replaceAll(e, cleaned.value);
    useNoticeStore().inform(undoKey.value ? `已替换为整理后的结构，可用 ${undoKey.value} 撤销` : "已替换为整理后的结构");
    close();
  } catch (err) {
    useNoticeStore().report("替换失败", err);
  } finally {
    replacing.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (!ai.structureOpen || e.key !== "Escape") return;
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
  <div v-if="ai.structureOpen" class="mask" @mousedown.self="close()">
    <div class="pop ai-dlg ai-tidy" role="dialog" aria-label="AI 整理结构">
      <div class="keys-head">
        <h3>AI 整理结构</h3>
        <span class="hint">已发送：当前笔记，约 {{ words.toLocaleString("zh-CN") }} 字</span>
        <button class="btn" type="button" title="关闭 (Esc)" @click="close()"><Icon name="close" sm /></button>
      </div>
      <div class="ai-dlg-body">
        <div class="tidy-cols">
          <div class="tidy-col">
            <h4>原文</h4>
            <pre v-if="!finished"><span v-for="(l, i) in original.split('\n')" :key="i" class="ln">{{ l || " " }}</span></pre>
            <pre v-else><span v-for="(l, i) in left" :key="i" class="ln" :class="l.kind">{{ l.text || " " }}</span></pre>
          </div>
          <div class="tidy-col">
            <h4>整理后</h4>
            <pre v-if="!finished"><span class="ln">{{ result || (running ? "正在等待回复…" : "") }}</span><span v-if="running" class="caret" /></pre>
            <pre v-else><span v-for="(l, i) in right" :key="i" class="ln" :class="l.kind">{{ l.text || " " }}</span></pre>
          </div>
        </div>
        <div v-if="finished && !issues.length" class="check ok"><Icon name="check" sm />核对通过：{{ protectedSummary(original) }}</div>
        <div v-if="finished && issues.length" class="check bad">
          <Icon name="alert" sm />核对未通过：{{ issues.map(describeIssue).join("；") }}。不能替换，可以重新生成或放弃。
        </div>
        <p v-if="error" class="git-error">{{ error }}</p>
      </div>
      <div class="ai-dlg-actions">
        <span class="hint">替换前会存一份历史快照<template v-if="undoKey">，替换后可用 {{ undoKey }} 撤销</template></span>
        <span class="flex" />
        <button v-if="running" class="fb-txt" type="button" @click="stop()">停止</button>
        <button class="fb-txt" type="button" @click="close()">放弃</button>
        <button v-if="!running" class="fb-txt" type="button" @click="start()">重新生成</button>
        <button class="btn-primary" type="button" :disabled="!finished || !!issues.length || replacing" @click="replace()">替换</button>
      </div>
    </div>
  </div>
</template>
