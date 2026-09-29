<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import MenuList from "./MenuList.vue";
import { useContextMenuStore } from "../stores/contextMenu";

const ctx = useContextMenuStore();
const host = ref<HTMLElement | null>(null);

function onDown(e: MouseEvent) {
  if (ctx.menu && host.value && !host.value.contains(e.target as Node)) ctx.hide();
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") ctx.hide();
}
onMounted(() => {
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", ctx.hide);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDown, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", ctx.hide);
});
</script>

<template>
  <div ref="host">
    <MenuList v-if="ctx.menu" :items="ctx.menu.items" :at="{ x: ctx.menu.x, y: ctx.menu.y }" @done="ctx.hide()" />
  </div>
</template>
