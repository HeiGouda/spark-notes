<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { api, type NoteRef, type TagCount } from "../lib/api";
import { useVaultStore } from "../stores/vault";
import { useTabsStore } from "../stores/tabs";
import { useSearchStore } from "../stores/search";
import { useNoticeStore } from "../stores/notice";

interface TagNode {
  name: string;
  full: string;
  count: number;
  children: TagNode[];
}

const vault = useVaultStore();
const tabs = useTabsStore();
const search = useSearchStore();
const tags = ref<TagCount[]>([]);
const expanded = ref(new Set<string>());
const notes = ref<Record<string, NoteRef[]>>({});

async function load() {
  if (!vault.root || !search.ready) return;
  try {
    tags.value = await api.tags(vault.root);
    for (const t of expanded.value) await loadNotes(t);
  } catch (e) {
    useNoticeStore().report("读取标签失败", e);
  }
}
watch(() => [search.version, search.ready], load, { immediate: true });

/** 按 `/` 组成层级；数量为直接带该标签的笔记数，展开后列出含子标签在内的全部笔记 */
const treeData = computed(() => {
  const roots: TagNode[] = [];
  const map = new Map<string, TagNode>();
  for (const { tag, count } of tags.value) {
    const parts = tag.split("/").filter(Boolean);
    let level = roots;
    let full = "";
    for (const [i, part] of parts.entries()) {
      full = full ? `${full}/${part}` : part;
      let node = map.get(full.toLowerCase());
      if (!node) {
        node = { name: part, full, count: 0, children: [] };
        map.set(full.toLowerCase(), node);
        level.push(node);
      }
      if (i === parts.length - 1) node.count += count;
      level = node.children;
    }
  }
  return roots;
});

const rows = computed(() => {
  const out: { node: TagNode; depth: number }[] = [];
  const walk = (list: TagNode[], depth: number) => {
    for (const n of list) {
      out.push({ node: n, depth });
      if (expanded.value.has(n.full)) walk(n.children, depth + 1);
    }
  };
  walk(treeData.value, 0);
  return out;
});

async function loadNotes(tag: string) {
  if (!vault.root) return;
  notes.value = { ...notes.value, [tag]: await api.tagNotes(vault.root, tag) };
}

async function toggle(tag: string) {
  const next = new Set(expanded.value);
  if (next.has(tag)) {
    next.delete(tag);
  } else {
    next.add(tag);
    try {
      await loadNotes(tag);
    } catch (e) {
      useNoticeStore().report("读取标签下的笔记失败", e);
    }
  }
  expanded.value = next;
}
</script>

<template>
  <div class="side-view">
    <ul class="tree">
      <template v-for="{ node, depth } in rows" :key="node.full">
        <li class="row" :style="{ '--d': depth }" tabindex="0" @click="toggle(node.full)" @keydown.enter="toggle(node.full)">
          <Icon class="chev" :name="expanded.has(node.full) ? 'down' : 'right'" />
          <Icon name="tag" />
          <span class="name">{{ node.name }}</span>
          <span class="row-count">{{ node.count || "" }}</span>
        </li>
        <template v-if="expanded.has(node.full)">
          <li
            v-for="n in notes[node.full] ?? []"
            :key="node.full + n.path"
            class="row"
            :class="{ 'is-active': n.path === tabs.activePath }"
            :style="{ '--d': depth + 1 }"
            tabindex="0"
            :title="n.path"
            @click="tabs.open(n.path, { preview: true })"
            @dblclick="tabs.open(n.path)"
          >
            <span class="spacer" />
            <Icon name="file" />
            <span class="name">{{ n.title }}</span>
          </li>
        </template>
      </template>
    </ul>
    <div v-if="search.ready && !tags.length" class="side-empty">还没有标签。点笔记标题下方的“+ 标签”，或在正文里写 #标签</div>
    <div v-if="!search.ready" class="side-hint">正在建立索引…</div>
  </div>
</template>
