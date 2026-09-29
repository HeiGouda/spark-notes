<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { api, type SearchHit } from "../../lib/api";
import Icon from "../Icon.vue";
import { folderLabel } from "../browse";
import { useMobile } from "../store";
import { go } from "../nav";

const store = useMobile();
const query = ref("");
const hits = ref<SearchHit[]>([]);
const searched = ref("");
const error = ref("");
const box = ref<HTMLInputElement | null>(null);
let timer = 0;
let seq = 0;

async function run(q: string) {
  const mine = ++seq;
  if (!q || !store.root) {
    hits.value = [];
    searched.value = "";
    return;
  }
  try {
    const found = await api.search(store.root, q, 50);
    if (mine !== seq) return;
    hits.value = found;
    searched.value = q;
    error.value = "";
  } catch (e) {
    if (mine === seq) error.value = e instanceof Error ? e.message : String(e);
  }
}

watch(query, (q) => {
  clearTimeout(timer);
  timer = window.setTimeout(() => run(q.trim()), 200);
});

onMounted(() => box.value?.focus());

function clear() {
  query.value = "";
  box.value?.focus();
}
</script>

<template>
  <div class="page">
    <div class="top" style="padding: 0 12px">
      <div class="inp" style="flex: 1; height: 40px; border-radius: 20px">
        <span style="padding-left: 12px; color: var(--muted); display: grid"><Icon name="search" :size="18" /></span>
        <input ref="box" v-model="query" type="search" :placeholder="`搜索 ${store.current?.name ?? ''}`" style="height: 36px" />
        <button v-if="query" class="ib" style="width: 34px; height: 34px" @click="clear"><Icon name="x" :size="16" /></button>
      </div>
    </div>
    <div class="scroll">
      <div v-if="error" class="m-empty">搜索出错：{{ error }}</div>
      <div v-else-if="!query.trim()" class="m-empty" style="padding-top: 40px">
        <Icon name="search" :size="40" />
        <p>搜索标题和正文，支持 <b>#标签</b></p>
      </div>
      <template v-else-if="hits.length">
        <div class="sec">找到 {{ hits.length }} 条</div>
        <button v-for="h in hits" :key="h.path" class="row tall" @click="go({ p: 'note', path: h.path })">
          <span class="ic"><Icon name="note" :size="20" /></span>
          <span class="main">
            <div class="name">{{ h.title }}</div>
            <div class="snip">
              <template v-for="(s, i) in h.snippet" :key="i"><mark v-if="s.hit">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template>
            </div>
            <div class="sub">{{ folderLabel(h.path) }}</div>
          </span>
        </button>
      </template>
      <div v-else-if="searched" class="m-empty">没有找到“{{ searched }}”</div>
    </div>
  </div>
</template>
