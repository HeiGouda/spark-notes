<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import Icon from "./Icon.vue";
import { useAiStore } from "../stores/ai";
import { useUiStore } from "../stores/ui";

const ai = useAiStore();
const ui = useUiStore();

function close() {
  ai.noConfigOpen = false;
}

function openSettings() {
  close();
  ui.settingsSection = "ai";
  ui.settingsOpen = true;
}

function onKey(e: KeyboardEvent) {
  if (!ai.noConfigOpen || e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  close();
}

onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div v-if="ai.noConfigOpen" class="mask" @mousedown.self="close()">
    <div class="pop ai-dlg ai-small" role="dialog" aria-label="尚未配置 AI">
      <div class="keys-head">
        <h3>尚未配置 AI</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="close()"><Icon name="close" sm /></button>
      </div>
      <div class="ai-dlg-body"><p>在设置里填写接口地址、API Key 和模型名后，就可以使用 AI 功能。</p></div>
      <div class="ai-dlg-actions">
        <span class="flex" />
        <button class="fb-txt" type="button" @click="close()">取消</button>
        <button class="btn-primary" type="button" @click="openSettings()">打开设置</button>
      </div>
    </div>
  </div>
</template>
