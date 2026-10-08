<script setup lang="ts">
import { computed } from "vue";
import { bookOf } from "../lib/book";
import { docKind, docName } from "../lib/doctype";
import { findBook } from "./browse";
import { useMobile } from "./store";
import { switchSheet } from "./nav";

/** 表格簿里的表切换条（只读）：不在表格簿里的文件不显示 */
const props = defineProps<{ path: string }>();
const store = useMobile();

const sheets = computed(() => {
  const book = bookOf(props.path);
  return book ? (findBook(store.tree, book)?.children ?? []) : [];
});

const KIND_MARK = { note: "", mind: "✱ ", flow: "⇢ " } as const;
</script>

<template>
  <div v-if="sheets.length" class="sheet-strip" role="tablist">
    <button
      v-for="s in sheets"
      :key="s.path"
      class="sheet-pill"
      :class="{ on: s.path === path }"
      role="tab"
      :aria-selected="s.path === path"
      @click="s.path !== path && switchSheet(s.path)"
    >{{ KIND_MARK[docKind(s.path) ?? "note"] }}{{ docName(s.path) }}</button>
  </div>
</template>
