<script setup lang="ts">
import { computed } from "vue";
import { useEditorStore } from "../stores/editor";
import { goTo } from "../editor/navigate";

const editor = useEditorStore();
/** 缩进以最浅的标题级别为基准 */
const minLevel = computed(() => Math.min(...editor.headings.map((h) => h.level), 6));

function go(pos: number) {
  if (editor.editor) goTo(editor.editor, pos);
}
</script>

<template>
  <div class="side-view">
    <ul class="tree">
      <li
        v-for="(h, i) in editor.headings"
        :key="h.pos"
        class="row outline-row"
        :class="{ 'is-active': i === editor.currentHeading }"
        :style="{ '--d': h.level - minLevel }"
        tabindex="0"
        :title="h.text"
        @click="go(h.pos)"
        @keydown.enter="go(h.pos)"
      >
        <span class="outline-level">H{{ h.level }}</span>
        <span class="name">{{ h.text || "（空标题）" }}</span>
      </li>
    </ul>
    <div v-if="!editor.editor" class="side-empty">打开一篇笔记后显示它的标题层级</div>
    <div v-else-if="!editor.headings.length" class="side-empty">这篇笔记还没有标题</div>
  </div>
</template>
