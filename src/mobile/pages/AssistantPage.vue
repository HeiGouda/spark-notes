<script setup lang="ts">
import { onMounted, ref } from "vue";
import ChatThread from "../chat/ChatThread.vue";
import ChatHistory from "../chat/ChatHistory.vue";
import { useMobileAi } from "../ai";
import { useMobileChat } from "../chat";
import { go } from "../nav";

const ai = useMobileAi();
const chat = useMobileChat();
const history = ref(false);
const error = ref("");

onMounted(async () => {
  try {
    await ai.loadChats();
    await chat.openLatest();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});

function fresh() {
  chat.startNew();
  history.value = false;
}
</script>

<template>
  <div class="page">
    <div v-if="error" class="m-empty">打开助手失败：{{ error }}</div>
    <div v-else-if="!ai.configured" class="m-empty">
      <p>还没有添加 AI 模型</p>
      <p style="margin-top: 14px"><button class="btn pri" @click="go({ p: 'ai-models' })">去添加模型</button></p>
    </div>
    <ChatHistory v-else-if="history" @back="history = false" />
    <ChatThread v-else :open="true" @history="history = true" @fresh="fresh" />
  </div>
</template>
