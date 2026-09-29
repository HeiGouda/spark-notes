<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import MenuList, { type MenuEntry } from "./MenuList.vue";
import Icon from "./Icon.vue";
import { tipFor } from "../lib/commands";

/** 画布右下角的缩放控件（需求文档 5.18） */
const props = defineProps<{ zoom: number }>();
const emit = defineEmits<{ zoom: [value: number]; step: [dir: 1 | -1]; fit: [] }>();

const PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const menuAt = ref<{ x: number; y: number } | null>(null);

function toggleMenu(e: MouseEvent) {
  if (menuAt.value) {
    menuAt.value = null;
    return;
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menuAt.value = { x: r.left, y: r.top - 8 - (PRESETS.length + 2) * 28 };
}

function onOutside(e: MouseEvent) {
  if (menuAt.value && !(e.target as Element).closest(".menu, .dzoom-v")) menuAt.value = null;
}
onMounted(() => document.addEventListener("mousedown", onOutside, true));
onBeforeUnmount(() => document.removeEventListener("mousedown", onOutside, true));

const items = (): MenuEntry[] => [
  ...PRESETS.map((z): MenuEntry => ({ kind: "item", label: `${Math.round(z * 100)}%`, checked: () => Math.abs(props.zoom - z) < 0.005, action: () => emit("zoom", z) })),
  { kind: "sep" },
  { kind: "item", label: "适应窗口", command: "diagram.zoomFit" },
];
</script>

<template>
  <div class="dzoom-float" @mousedown.stop>
    <button class="dbtn icon" title="缩小" @mousedown.prevent @click="emit('step', -1)">−</button>
    <button class="dbtn dzoom-v" title="缩放比例" @mousedown.prevent @click="toggleMenu">{{ Math.round(zoom * 100) }}%</button>
    <button class="dbtn icon" title="放大" @mousedown.prevent @click="emit('step', 1)">+</button>
    <button class="dbtn icon" :title="tipFor('适应窗口', 'diagram.zoomFit')" @mousedown.prevent @click="emit('fit')"><Icon name="fit" sm /></button>
    <MenuList v-if="menuAt" :items="items()" :at="menuAt" @done="menuAt = null" />
  </div>
</template>
