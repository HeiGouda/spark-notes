<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import Icon from "../Icon.vue";
import { formatTokens, modelLabel } from "../../lib/aiModels";
import { presetOf } from "../../lib/ai";
import { renderMarkdown } from "../../lib/markdown";
import type { ChatMsg } from "../../lib/chat";
import { useMobileAi } from "../ai";
import { useMobileChat } from "../chat";
import { toast } from "../nav";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ history: []; fresh: [] }>();

const ai = useMobileAi();
const chat = useMobileChat();
const thread = ref<HTMLElement | null>(null);
const box = ref<HTMLTextAreaElement | null>(null);
const picking = ref(false);

const messages = computed(() => chat.current?.messages ?? []);

/** 更早的消息未发送时，分隔线画在第一条会发送的消息前面 */
const dividerAt = computed(() => {
  const p = chat.plan;
  if (!p.omitted) return -1;
  const first = p.included[0];
  const i = first ? messages.value.findIndex((m) => m.id === first.id) : messages.value.length;
  return i < 0 ? -1 : i;
});

const meter = computed(() => {
  const used = chat.plan.tokens;
  const full = chat.plan.omitted > 0 || used >= chat.budget;
  return {
    fill: Math.min(100, (used / Math.max(chat.budget, 1)) * 100),
    full,
    text: `上下文 约 ${formatTokens(used)} / ${formatTokens(chat.context.tokens)}${full ? " · 更早的消息不再发送" : ""}`,
  };
});

const canSend = computed(() => !!chat.draft.trim() && !chat.running);

const rendered = new Map<string, { src: string; html: string }>();
function messageHtml(m: ChatMsg): string {
  const hit = rendered.get(m.id);
  if (hit?.src === m.content) return hit.html;
  const html = renderMarkdown(m.content);
  rendered.set(m.id, { src: m.content, html });
  return html;
}

async function stickToBottom() {
  await nextTick();
  const el = thread.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch(() => chat.current?.id, () => {
  rendered.clear();
  void stickToBottom();
});
watch(() => messages.value[messages.value.length - 1]?.content, () => void stickToBottom());
watch(() => props.open, (on) => {
  if (on) void stickToBottom();
});

function grow() {
  const el = box.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}
watch(() => chat.draft, () => nextTick(grow));

async function copy(m: ChatMsg) {
  try {
    await navigator.clipboard.writeText(m.content);
    toast("已复制");
  } catch (e) {
    toast(`复制失败：${e instanceof Error ? e.message : e}`);
  }
}

async function send() {
  if (!canSend.value) return;
  try {
    await chat.send();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

function pick(id: string) {
  chat.setModel(id);
  picking.value = false;
}
</script>

<template>
  <div class="chat">
    <div class="chat-head">
      <button class="ib" title="历史对话" @click="emit('history')"><Icon name="menu" /></button>
      <b class="chat-title">{{ chat.current?.title || "新对话" }}</b>
      <button class="ib" title="新对话" @click="emit('fresh')"><Icon name="plus" /></button>
      <slot name="extra"></slot>
    </div>
    <div ref="thread" class="chat-thread">
      <div v-if="!messages.length" class="chat-empty">
        <span class="mark"><Icon name="spark" :size="26" /></span>
        <p>有什么想问的？</p>
      </div>
      <template v-for="(m, i) in messages" :key="m.id">
        <div v-if="i === dividerAt" class="chat-div">更早的 {{ chat.plan.omitted }} 条消息未发送给 AI</div>
        <div class="bubble" :class="m.role">
          <div v-if="m.role === 'assistant'" class="md" v-html="messageHtml(m)"></div>
          <div v-else class="plain">{{ m.content }}</div>
          <div v-if="m.role === 'assistant' && !m.content && !m.error && chat.running && i === messages.length - 1" class="typing"><i></i><i></i><i></i></div>
          <p v-if="m.error" class="err">{{ m.error }}</p>
          <div v-if="m.role === 'assistant' && (m.content || m.error)" class="ops">
            <button @click="copy(m)">复制</button>
            <button v-if="i === messages.length - 1 && !chat.running" @click="chat.regenerate()">重新生成</button>
            <span v-if="m.model" class="who">{{ m.model }}</span>
          </div>
        </div>
      </template>
    </div>
    <div class="composer">
      <div class="ctl">
        <button class="model-chip" :disabled="!ai.models.length" @click="picking = true">
          <span>{{ chat.model ? modelLabel(chat.model) : "还没有模型" }}</span><Icon name="down" :size="16" />
        </button>
      </div>
      <div class="in">
        <textarea ref="box" v-model="chat.draft" rows="1" placeholder="输入消息" @input="grow"></textarea>
        <button v-if="chat.running" class="send" title="停止" @click="chat.stop()"><Icon name="stop" :size="20" /></button>
        <button v-else class="send" :class="{ off: !canSend }" :disabled="!canSend" title="发送" @click="send"><Icon name="up" :size="20" /></button>
      </div>
      <div class="use" :class="{ full: meter.full }">
        <span class="meter"><i :style="{ width: meter.fill + '%' }"></i></span>{{ meter.text }}
      </div>
    </div>
    <div v-if="picking" class="m-ovl">
      <div class="mask" @click="picking = false"></div>
      <div class="sheet">
        <div class="grab"></div>
        <h2>选择模型</h2>
        <button v-for="m in ai.models" :key="m.id" class="row" @click="pick(m.id)">
          <span class="main">
            <div class="name">{{ modelLabel(m) }}</div>
            <div class="sub">{{ presetOf(m.provider).label }} · 上下文 {{ formatTokens(ai.contextOf(m).tokens) }}</div>
          </span>
          <Icon v-if="m.id === chat.model?.id" name="check" :size="18" />
        </button>
      </div>
    </div>
  </div>
</template>
