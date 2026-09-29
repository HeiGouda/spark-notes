<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { applyLink, currentLink, focusEditor, linkCoords } from "../editor/link";
import { useEditorStore } from "../stores/editor";
import { useUiStore } from "../stores/ui";
import { useNoticeStore } from "../stores/notice";

/** 插入链接（Ctrl+K）：在选中文字下方弹出地址输入框 */
const editorStore = useEditorStore();
const ui = useUiStore();
const input = ref<HTMLInputElement | null>(null);
const host = ref<HTMLElement | null>(null);
const href = ref("");
const hadLink = ref(false);
const pos = ref<{ left: number; top: number }>({ left: 0, top: 0 });

watch(
  () => ui.linkOpen,
  async (open) => {
    const e = editorStore.editor;
    if (!open) return;
    if (!e) {
      ui.linkOpen = false;
      return;
    }
    const target = currentLink(e);
    href.value = target.href;
    hadLink.value = !!target.href;
    const c = linkCoords(e, target.pos);
    pos.value = { left: Math.min(c.left, window.innerWidth - 470), top: c.bottom + 8 };
    await nextTick();
    input.value?.focus();
    input.value?.select();
  },
);

function close(refocus = true) {
  ui.linkOpen = false;
  if (refocus && editorStore.editor) focusEditor(editorStore.editor);
}

function confirm() {
  const e = editorStore.editor;
  if (!e) return close(false);
  try {
    applyLink(e, href.value);
  } catch (err) {
    useNoticeStore().report("设置链接失败", err);
  }
  ui.linkOpen = false;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    confirm();
  } else if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

function onDocDown(e: MouseEvent) {
  if (ui.linkOpen && host.value && !host.value.contains(e.target as Node)) close(false);
}
onMounted(() => document.addEventListener("mousedown", onDocDown, true));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocDown, true));
</script>

<template>
  <div v-if="ui.linkOpen" ref="host" class="pop linkpop" :style="{ left: `${pos.left}px`, top: `${pos.top}px` }" role="dialog" aria-label="链接">
    <input ref="input" v-model="href" placeholder="链接地址，如 https://…" spellcheck="false" aria-label="链接地址" @keydown="onKey" />
    <button class="btn-primary" @mousedown.prevent @click="confirm()">{{ hadLink && !href.trim() ? "移除" : "确定" }}</button>
    <span class="hint">{{ hadLink ? "清空地址即移除链接" : "Enter 确定 · Esc 取消" }}</span>
  </div>
</template>
