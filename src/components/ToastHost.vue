<script setup lang="ts">
import Icon from "./Icon.vue";
import { useNoticeStore } from "../stores/notice";

const notice = useNoticeStore();
</script>

<template>
  <div class="toasts" aria-live="polite">
    <div v-for="t in notice.toasts" :key="t.id" class="toast" :class="`is-${t.kind}`" :role="t.kind === 'error' ? 'alert' : 'status'">
      <span class="toast-mark">{{ t.kind === "error" ? "!" : "✓" }}</span>
      <span class="toast-text">{{ t.text }}</span>
      <button class="toast-x" type="button" title="关闭" @click="notice.dismiss(t.id)"><Icon name="close" sm /></button>
    </div>
  </div>
</template>
