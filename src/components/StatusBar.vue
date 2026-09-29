<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import { useEditorStore } from "../stores/editor";
import { useTabsStore } from "../stores/tabs";
import { useNoticeStore } from "../stores/notice";

const editorStore = useEditorStore();
const tabs = useTabsStore();
const notice = useNoticeStore();

function hhmm(ms: number) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const saveText = computed(() => {
  const t = tabs.active;
  if (!t) return "";
  switch (t.status) {
    case "saving": return "保存中…";
    case "dirty": return "未保存";
    case "error": return "保存失败";
    default: return t.savedAt ? `已保存 ${hhmm(t.savedAt)}` : "已保存";
  }
});
</script>

<template>
  <footer class="statusbar">
    <template v-if="tabs.active">
      <span class="sb">字数 {{ editorStore.words.toLocaleString("zh-CN") }}</span>
      <span class="sb">行 {{ editorStore.line }}，列 {{ editorStore.col }}</span>
    </template>
    <span class="sb-flex" />
    <span v-if="notice.error" class="sb err" :title="notice.error" @click="notice.clear()">{{ notice.error }}</span>
    <span v-else-if="notice.info" class="sb info" :title="notice.info" @click="notice.clear()">{{ notice.info }}</span>
    <template v-if="tabs.active">
      <span class="sb" :class="{ err: tabs.active.status === 'error' }">
        <Icon v-if="tabs.active.status === 'saved'" class="ok" name="check" sm />{{ saveText }}
      </span>
    </template>
  </footer>
</template>
