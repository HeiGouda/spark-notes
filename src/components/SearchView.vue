<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { api, dirOf, type SearchHit } from "../lib/api";
import { useVaultStore } from "../stores/vault";
import { useTabsStore } from "../stores/tabs";
import { useSearchStore } from "../stores/search";
import { useUiStore } from "../stores/ui";
import { useNoticeStore } from "../stores/notice";

const vault = useVaultStore();
const tabs = useTabsStore();
const search = useSearchStore();
const ui = useUiStore();
const input = ref<HTMLInputElement | null>(null);
const hits = ref<SearchHit[]>([]);
const searched = ref(false);
let timer = 0;
let seq = 0;

async function run() {
  const q = ui.query.trim();
  const root = vault.root;
  const mine = ++seq;
  if (!q || !root) {
    hits.value = [];
    searched.value = false;
    return;
  }
  try {
    const result = await api.search(root, q, 50);
    if (mine === seq) {
      hits.value = result;
      searched.value = true;
    }
  } catch (e) {
    useNoticeStore().report("搜索失败", e);
  }
}

watch(() => ui.query, () => {
  clearTimeout(timer);
  timer = window.setTimeout(run, 150);
});
// 索引更新后刷新结果
watch(() => search.version, run);

async function focus() {
  await nextTick();
  input.value?.focus();
  input.value?.select();
}
watch(() => ui.focusSearch, focus);
onMounted(() => {
  void focus();
  void run();
});
onBeforeUnmount(() => clearTimeout(timer));

/** 用于打开后定位：取查询里的第一个普通词 */
function firstTerm(): string | undefined {
  return ui.query.split(/\s+/).find((t) => t && !t.startsWith("#") && !t.startsWith("path:"));
}

function open(hit: SearchHit, pin = false) {
  const term = firstTerm();
  void tabs.openAt(hit.path, term ? { text: term } : {}, !pin);
}
</script>

<template>
  <div class="side-view">
    <div class="side-search">
      <Icon name="search" sm />
      <input
        ref="input"
        v-model="ui.query"
        type="search"
        placeholder="搜索笔记"
        spellcheck="false"
        @keydown.enter.prevent="hits[0] && open(hits[0])"
        @keydown.esc="ui.query = ''"
      />
    </div>
    <div class="side-hint">空格分隔多个词；#标签 按标签过滤；path:文件夹 按文件夹过滤</div>
    <div v-if="!search.ready" class="side-hint">正在建立索引…</div>
    <ul class="tree result-list">
      <li
        v-for="h in hits"
        :key="h.path"
        class="result"
        :class="{ 'is-active': h.path === tabs.activePath }"
        tabindex="0"
        :title="h.path"
        @click="open(h)"
        @dblclick="open(h, true)"
        @keydown.enter="open(h)"
      >
        <div class="result-title"><Icon name="file" sm />{{ h.title }}<span class="result-dir">{{ dirOf(h.path) }}</span></div>
        <div class="result-snip">
          <template v-for="(s, i) in h.snippet" :key="i"><mark v-if="s.hit">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template>
        </div>
      </li>
    </ul>
    <div v-if="searched && !hits.length" class="side-empty">没有找到匹配的笔记</div>
  </div>
</template>
