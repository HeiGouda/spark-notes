<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import Icon from "./Icon.vue";
import TrashList from "./TrashList.vue";
import { useUiStore } from "../stores/ui";

const ui = useUiStore();

function close() {
  ui.trashOpen = false;
}

function onKey(e: KeyboardEvent) {
  if (!ui.trashOpen || e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  close();
}

onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div v-if="ui.trashOpen" class="mask" @mousedown.self="close()">
    <div class="pop trash" role="dialog" aria-label="回收站">
      <div class="keys-head">
        <h3>回收站</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="close()"><Icon name="close" sm /></button>
      </div>
      <TrashList />
    </div>
  </div>
</template>
