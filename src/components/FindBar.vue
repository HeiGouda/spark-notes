<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { editorViewCtx } from "@milkdown/kit/core";
import Icon from "./Icon.vue";
import { buildPattern, clearMatches, currentDoc, findMatches, replaceAll, replaceOne, showMatches, type Match } from "../editor/find";
import { useEditorStore } from "../stores/editor";
import { useDiagramStore } from "../stores/diagram";
import { useTabsStore } from "../stores/tabs";
import { useUiStore } from "../stores/ui";
import { useNoticeStore } from "../stores/notice";

/** 查找与替换（原型 M4 浮层 5）：停靠在编辑区右上角；笔记和图共用（需求文档 5.18） */
const editorStore = useEditorStore();
const diagramStore = useDiagramStore();
const tabs = useTabsStore();
const ui = useUiStore();
const input = ref<HTMLInputElement | null>(null);
const query = ref("");
const replacement = ref("");
const caseSensitive = ref(false);
const regex = ref(false);
const matches = ref<Match[]>([]);
/** 图里的命中数（图的命中由图自己记录） */
const diagramCount = ref(0);
const current = ref(0);
const replacedInfo = ref("");

/** 当前标签页是图时，在图上查找 */
const diagram = computed(() => (tabs.active && tabs.active.kind !== "note" ? diagramStore.handle?.find ?? null : null));
const total = computed(() => (diagram.value ? diagramCount.value : matches.value.length));
const canReplace = computed(() => total.value > 0 && !diagram.value?.readonly());

const pattern = computed(() => buildPattern(query.value, { caseSensitive: caseSensitive.value, regex: regex.value }));
const invalid = computed(() => !!query.value && regex.value && !pattern.value);

function refresh(select: boolean) {
  if (!ui.findOpen) return;
  const p = pattern.value;
  const d = diagram.value;
  if (d) {
    diagramCount.value = d.search(p, current.value, false);
    if (current.value >= diagramCount.value) current.value = Math.max(diagramCount.value - 1, 0);
    if (select && diagramCount.value) d.search(p, current.value, true);
    return;
  }
  const e = editorStore.editor;
  if (!e) return;
  matches.value = p ? findMatches(currentDoc(e), p) : [];
  if (current.value >= matches.value.length) current.value = Math.max(matches.value.length - 1, 0);
  showMatches(e, matches.value, current.value, select && matches.value.length > 0);
}

watch([query, caseSensitive, regex], () => {
  current.value = 0;
  replacedInfo.value = "";
  refresh(true);
});
watch(() => editorStore.docVersion, () => refresh(false));
watch(() => editorStore.editor, () => refresh(false));
watch(() => diagramStore.version, () => refresh(false));
watch(diagram, () => refresh(false));

watch(
  () => ui.findFocus,
  async () => {
    if (ui.findSeed) {
      query.value = ui.findSeed;
      ui.findSeed = "";
    }
    await nextTick();
    input.value?.focus();
    input.value?.select();
    refresh(true);
  },
);

function go(delta: number) {
  const n = total.value;
  if (!n) return;
  current.value = (current.value + delta + n) % n;
  const d = diagram.value;
  if (d) {
    d.search(pattern.value, current.value, true);
    return;
  }
  const e = editorStore.editor;
  if (e) showMatches(e, matches.value, current.value, true);
}

function onFindKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    go(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

function onReplaceKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    replaceCurrent();
  } else if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

function replaceCurrent() {
  const p = pattern.value;
  if (!p || !canReplace.value) return;
  try {
    const d = diagram.value;
    if (d) d.replaceOne(current.value, p, replacement.value, regex.value);
    else {
      const e = editorStore.editor;
      const m = matches.value[current.value];
      if (!e || !m) return;
      replaceOne(e, m, p, replacement.value, regex.value);
    }
  } catch (err) {
    useNoticeStore().report("替换失败", err);
  }
  refresh(true);
}

function replaceEverything() {
  const p = pattern.value;
  if (!p || !canReplace.value) return;
  try {
    const d = diagram.value;
    let n = 0;
    if (d) n = d.replaceAll(p, replacement.value, regex.value);
    else if (editorStore.editor) n = replaceAll(editorStore.editor, matches.value, p, replacement.value, regex.value);
    replacedInfo.value = `已替换 ${n} 处`;
  } catch (err) {
    useNoticeStore().report("全部替换失败", err);
  }
  refresh(false);
}

function close() {
  ui.closeFind();
  const d = diagram.value;
  if (d) {
    d.clear();
    d.focus();
    return;
  }
  const e = editorStore.editor;
  if (!e) return;
  clearMatches(e);
  e.action((ctx) => ctx.get(editorViewCtx).focus());
}

const counter = computed(() => {
  if (invalid.value) return "正则无效";
  if (replacedInfo.value) return replacedInfo.value;
  if (!query.value) return "";
  return total.value ? `${current.value + 1} / ${total.value}` : "无结果";
});
</script>

<template>
  <div v-if="ui.findOpen" class="findbar" :class="{ 'is-diagram': diagram }" role="search" @mousedown.stop>
    <button class="btn" :title="ui.findReplace ? '收起替换' : '展开替换'" @click="ui.findReplace = !ui.findReplace">
      <Icon :name="ui.findReplace ? 'down' : 'right'" sm />
    </button>
    <input ref="input" v-model="query" placeholder="查找" spellcheck="false" aria-label="查找" @keydown="onFindKey" />
    <div class="fb-tools">
      <span class="fb-count" :class="{ err: invalid }">{{ counter }}</span>
      <button class="btn fb-opt" :class="{ on: caseSensitive }" title="区分大小写" @click="caseSensitive = !caseSensitive">Aa</button>
      <button class="btn fb-opt" :class="{ on: regex }" title="正则表达式" @click="regex = !regex">.*</button>
      <button class="btn" title="上一个 (Shift+Enter)" :disabled="!total" @click="go(-1)"><Icon name="left" sm /></button>
      <button class="btn" title="下一个 (Enter)" :disabled="!total" @click="go(1)"><Icon name="right" sm /></button>
      <button class="btn" title="关闭 (Esc)" @click="close()"><Icon name="close" sm /></button>
    </div>
    <template v-if="ui.findReplace">
      <span />
      <input v-model="replacement" placeholder="替换为" spellcheck="false" aria-label="替换为" @keydown="onReplaceKey" />
      <div class="fb-tools">
        <button class="fb-txt" :disabled="!canReplace" title="替换当前 (Enter)" @click="replaceCurrent()">替换</button>
        <button class="fb-txt" :disabled="!canReplace" @click="replaceEverything()">全部替换</button>
      </div>
    </template>
  </div>
</template>
