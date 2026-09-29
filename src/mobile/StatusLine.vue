<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import { timeLabel } from "./browse";
import { useMobile } from "./store";
import { go, open } from "./nav";

const store = useMobile();

const view = computed(() => {
  const s = store.sync;
  const last = store.currentId ? store.meta[store.currentId]?.lastSyncMs : 0;
  switch (s.state) {
    case "never":
      return { cls: "", icon: "cloud", text: "尚未下载笔记 · 点击开始" };
    case "running":
      return { cls: "", icon: "sync", text: s.total ? `正在同步 ${s.done}/${s.total}…` : "正在检查更新…" };
    case "fail":
      return { cls: "fail", icon: "warn", text: `同步失败：${s.message} · 点击重试` };
    case "held":
      return { cls: "held", icon: "warn", text: `有 ${s.removals.length} 个删除等待确认 · 点击查看` };
    default:
      return { cls: "", icon: "check", text: `${timeLabel(last ?? null)} 已同步` };
  }
});

function act() {
  const s = store.sync.state;
  if (s === "never" && store.currentId) go({ p: "firstsync", id: store.currentId });
  else if (s === "fail") void store.runSync();
  else if (s === "held") open({ t: "bulk" });
}
</script>

<template>
  <button class="status" :class="view.cls" @click="act">
    <Icon :name="view.icon" :size="14" />
    <span>{{ view.text }}</span>
    <span class="ro">只读</span>
  </button>
</template>
