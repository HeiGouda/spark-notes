<script setup lang="ts">
import { ref, watch } from "vue";
import Icon from "./Icon.vue";
import { api, type Backlink } from "../lib/api";
import { wikiLabel } from "../editor/wikilink";
import { useVaultStore } from "../stores/vault";
import { useTabsStore } from "../stores/tabs";
import { useSearchStore } from "../stores/search";
import { useNoticeStore } from "../stores/notice";

/** 对应设计稿正文底部的“反向链接”：列出引用当前笔记的笔记及所在行 */
const props = defineProps<{ path: string }>();
const vault = useVaultStore();
const tabs = useTabsStore();
const search = useSearchStore();
const items = ref<Backlink[]>([]);
const open = ref(true);

async function load() {
  if (!vault.root || !search.ready) return;
  try {
    items.value = await api.backlinks(vault.root, props.path);
  } catch (e) {
    useNoticeStore().report("读取反向链接失败", e);
  }
}

watch(() => [props.path, search.version, search.ready], load, { immediate: true });

/** 把行里的 [[...]] 显示成链接文字，并标出来 */
function segments(line: string) {
  const out: { text: string; link: boolean }[] = [];
  let last = 0;
  for (const m of line.matchAll(/\[\[([^[\]\n]+?)\]\]/g)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: line.slice(last, i), link: false });
    out.push({ text: wikiLabel(m[1]), link: true });
    last = i + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), link: false });
  return out;
}

function openSource(b: Backlink) {
  // 定位到引用所在的那一行（取行里第一段普通文字）
  const text = segments(b.line).find((s) => !s.link && s.text.trim().length >= 2)?.text.trim();
  void tabs.openAt(b.path, text ? { text } : {}, true);
}
</script>

<template>
  <section class="backlinks" aria-label="反向链接">
    <div class="bl-inner">
      <button class="bl-head" type="button" @click="open = !open">
        <Icon :name="open ? 'down' : 'right'" sm />反向链接<span class="bl-count">{{ items.length }}</span>
      </button>
      <template v-if="open">
        <a v-for="b in items" :key="b.path + b.line" class="bl-item" href="#" @click.prevent="openSource(b)">
          <div class="bl-title">{{ b.title }}</div>
          <div class="bl-snip">
            <template v-for="(s, i) in segments(b.line)" :key="i"><b v-if="s.link">{{ s.text }}</b><template v-else>{{ s.text }}</template></template>
          </div>
        </a>
        <div v-if="!items.length" class="bl-empty">{{ search.ready ? "还没有笔记链接到这里" : "正在建立索引…" }}</div>
      </template>
    </div>
  </section>
</template>
