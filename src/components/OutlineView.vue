<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useEditorStore } from "../stores/editor";
import { goTo } from "../editor/navigate";

const editor = useEditorStore();
/** 缩进和字号都以最浅的标题级别为基准 */
const minLevel = computed(() => Math.min(...editor.headings.map((h) => h.level), 6));
const list = ref<HTMLElement | null>(null);

function go(pos: number) {
  if (editor.editor) goTo(editor.editor, pos);
}

/** 当前所在章节随光标变化时，保持它在可见范围内 */
watch(
  () => editor.currentHeading,
  async (i) => {
    await nextTick();
    const row = list.value?.children[i] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  },
);
</script>

<template>
  <div class="side-view">
    <ul ref="list" class="tree">
      <li
        v-for="(h, i) in editor.headings"
        :key="h.pos"
        class="row outline-row"
        :class="[`ol-l${Math.min(h.level - minLevel, 3)}`, { 'is-active': i === editor.currentHeading }]"
        :style="{ '--d': h.level - minLevel }"
        tabindex="0"
        :title="h.text"
        @click="go(h.pos)"
        @keydown.enter="go(h.pos)"
      >
        <span class="name">{{ h.text || "（空标题）" }}</span>
      </li>
    </ul>
    <div v-if="!editor.editor" class="side-empty">打开一篇笔记后显示它的标题层级</div>
    <div v-else-if="!editor.headings.length" class="side-empty">这篇笔记还没有标题</div>
  </div>
</template>
