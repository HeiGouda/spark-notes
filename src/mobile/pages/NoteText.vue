<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../../lib/api";
import Icon from "../Icon.vue";
import { folderLabel } from "../browse";
import { useMobile } from "../store";
import { back } from "../nav";

const props = defineProps<{ path: string }>();
const store = useMobile();
const text = ref("");
const error = ref("");
const title = props.path.slice(props.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

onMounted(async () => {
  if (!store.root) return;
  try {
    text.value = (await api.readNote(store.root, props.path)).content;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});
</script>

<template>
  <div class="page bare">
    <div class="top">
      <button class="ib" @click="back()"><Icon name="back" /></button>
      <h1>{{ title }}<small>{{ folderLabel(path) }}</small></h1>
    </div>
    <div class="scroll">
      <div v-if="error" class="m-empty">{{ error }}</div>
      <pre v-else class="plain">{{ text }}</pre>
    </div>
  </div>
</template>
