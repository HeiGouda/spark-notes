<script setup lang="ts">
import { onMounted, ref } from "vue";
import Icon from "../Icon.vue";
import ChatThread from "./ChatThread.vue";
import ChatHistory from "./ChatHistory.vue";
import { useMobileAi } from "../ai";
import { useMobileChat } from "../chat";
import { close, go, tab } from "../nav";

const props = defineProps<{ quote?: string }>();
const ai = useMobileAi();
const chat = useMobileChat();
const history = ref(false);

onMounted(() => {
  if (props.quote) chat.ask(props.quote);
  else void chat.openLatest();
});

/** 关掉弹窗，切到助手标签，停在同一个会话 */
function openInAssistant() {
  close();
  tab("assistant");
}
</script>

<template>
  <div class="mask" @click="close()"></div>
  <div class="ai-sheet">
    <div class="grab"></div>
    <div v-if="!ai.configured" class="m-empty">
      <p>还没有添加 AI 模型</p>
      <p class="sub">先在“我的 → AI 模型”里添加一个模型，填写接口地址和 API Key。</p>
      <p style="margin-top: 14px"><button class="btn pri" @click="close(); go({ p: 'ai-models' })">去添加模型</button></p>
    </div>
    <ChatHistory v-else-if="history" @back="history = false" />
    <ChatThread v-else :open="true" @history="history = true" @fresh="chat.startNew()">
      <template #extra>
        <button class="ib" title="在助手中打开" @click="openInAssistant"><Icon name="expand" /></button>
        <button class="ib" title="关闭" @click="close()"><Icon name="x" /></button>
      </template>
    </ChatThread>
  </div>
</template>
