<script setup lang="ts">
import { computed } from "vue";
import Icon from "../Icon.vue";
import { back } from "../nav";
import { DOC_TAG, docKind } from "../../lib/doctype";
import type { IconName } from "../icons";
import { folderLabel, recentOpened, timeLabel } from "../browse";
import { useMobile } from "../store";
import { openDoc as open } from "../nav";
import { isBookPath } from "../../lib/book";

const store = useMobile();
const notes = computed(() => recentOpened(store.tree, store.currentId ? (store.recent[store.currentId] ?? []) : []));

function iconOf(path: string): IconName {
  if (isBookPath(path)) return "book";
  const k = docKind(path);
  return !k || k === "note" ? "note" : k;
}
</script>

<template>
  <div class="page">
    <div class="top">
      <button class="ib" @click="back()"><Icon name="back" /></button>
      <h1>最近打开<small>打开过的 · {{ store.current?.name }}</small></h1>
    </div>
    <div class="scroll">
      <button v-for="r in notes" :key="r.node.path" class="row" @click="open(r.node.path)">
        <span class="ic"><Icon :name="iconOf(r.node.path)" :size="20" /></span>
        <span class="main">
          <div class="name">{{ r.node.name }}<span v-if="DOC_TAG[docKind(r.node.path) ?? 'note']" class="badge">{{ DOC_TAG[docKind(r.node.path) ?? 'note'] }}</span></div>
          <div class="sub">{{ folderLabel(r.node.path) }} · {{ timeLabel(r.openedAt) }}</div>
        </span>
      </button>
      <div v-if="!notes.length" class="m-empty"><Icon name="recent" :size="40" /><p>还没有打开过的文件</p></div>
    </div>
  </div>
</template>
