<script setup lang="ts">
import Icon from "../Icon.vue";
import { timeLabel } from "../browse";
import { useMobile } from "../store";
import { close, go, reset, tab } from "../nav";

const store = useMobile();

function status(id: string) {
  const m = store.meta[id];
  return m?.lastSyncMs ? `上次同步 ${timeLabel(m.lastSyncMs)} · ${m.files} 篇笔记` : "尚未下载";
}

async function pick(id: string) {
  reset({ p: "files", path: "" });
  if (id !== store.currentId) await store.selectVault(id);
}
</script>

<template>
  <div class="mask" @click="close()"></div>
  <div class="sheet">
    <div class="grab"></div>
    <h2>切换笔记库</h2>
    <button v-for="v in store.vaults" :key="v.id" class="row" @click="pick(v.id)">
      <span class="ic"><Icon name="cloud" :size="20" /></span>
      <span class="main">
        <div class="name">{{ v.name }}</div>
        <div class="sub">{{ status(v.id) }}</div>
      </span>
      <span class="end" style="color: var(--accent)"><Icon v-if="v.id === store.currentId" name="check" :size="20" /></span>
    </button>
    <button class="row" @click="go({ p: 'form', id: null })">
      <span class="ic"><Icon name="plus" :size="20" /></span>
      <span class="main"><div class="name">添加笔记库</div></span>
    </button>
    <button class="row manage" @click="tab('me')">管理笔记库</button>
  </div>
</template>
