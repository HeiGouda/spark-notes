<script setup lang="ts">
import { computed } from "vue";
import Icon from "../Icon.vue";
import { folderLabel, recentNotes, timeLabel } from "../browse";
import { useMobile } from "../store";
import { go } from "../nav";

const store = useMobile();
const notes = computed(() => recentNotes(store.tree));
</script>

<template>
  <div class="page">
    <div class="top pad">
      <h1>最近<small>按修改时间 · {{ store.current?.name }}</small></h1>
    </div>
    <div class="scroll">
      <button v-for="n in notes" :key="n.path" class="row" @click="go({ p: 'note', path: n.path })">
        <span class="ic"><Icon name="note" :size="20" /></span>
        <span class="main">
          <div class="name">{{ n.name }}</div>
          <div class="sub">{{ folderLabel(n.path) }} · {{ timeLabel(n.modifiedMs) }}</div>
        </span>
      </button>
      <div v-if="!notes.length" class="m-empty"><Icon name="recent" :size="40" /><p>还没有笔记</p></div>
    </div>
  </div>
</template>
