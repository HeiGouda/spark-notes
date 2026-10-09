<script setup lang="ts">
import { computed, ref } from "vue";
import Icon from "../Icon.vue";
import type { ChatSummary } from "../../lib/api";
import { useMobileAi } from "../ai";
import { useMobileChat } from "../chat";
import { toast } from "../nav";
import { ask } from "../dialog";

const emit = defineEmits<{ back: [] }>();
const ai = useMobileAi();
const chat = useMobileChat();
const menuFor = ref<string | null>(null);
const renaming = ref<ChatSummary | null>(null);
const newTitle = ref("");

const DAY = 86_400_000;

const groups = computed(() => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const out: { label: string; items: ChatSummary[] }[] = [
    { label: "今天", items: [] },
    { label: "昨天", items: [] },
    { label: "更早", items: [] },
  ];
  for (const c of ai.chats) {
    const i = c.updatedAt >= start ? 0 : c.updatedAt >= start - DAY ? 1 : 2;
    out[i].items.push(c);
  }
  return out.filter((g) => g.items.length);
});

async function openChat(id: string) {
  try {
    await chat.open(id);
    emit("back");
  } catch (e) {
    toast(`打开会话失败：${e instanceof Error ? e.message : e}`);
  }
}

function startRename(c: ChatSummary) {
  menuFor.value = null;
  renaming.value = c;
  newTitle.value = c.title;
}

async function confirmRename() {
  const c = renaming.value;
  if (!c) return;
  try {
    await chat.rename(c.id, newTitle.value);
    renaming.value = null;
  } catch (e) {
    toast(`重命名失败：${e instanceof Error ? e.message : e}`);
  }
}

async function removeChat(c: ChatSummary) {
  menuFor.value = null;
  if (!(await ask({ title: `删除对话“${c.title}”？`, message: chat.isRunning(c.id) ? "这个对话正在生成，删除后会停止。" : "删除后不能恢复。", ok: "删除", danger: true }))) return;
  try {
    await chat.remove(c.id);
  } catch (e) {
    toast(`删除失败：${e instanceof Error ? e.message : e}`);
  }
}
</script>

<template>
  <div class="page bare">
    <div class="top">
      <button class="ib" @click="emit('back')"><Icon name="back" /></button>
      <h1>历史对话</h1>
      <button class="ib" title="新对话" @click="chat.startNew(); emit('back')"><Icon name="plus" /></button>
    </div>
    <div class="scroll">
      <template v-for="g in groups" :key="g.label">
        <div class="sec">{{ g.label }}</div>
        <div v-for="c in g.items" :key="c.id" class="row" @click="openChat(c.id)">
          <span class="main">
            <div class="name">{{ c.title }}<span v-if="chat.isRunning(c.id)" class="badge">生成中</span></div>
          </span>
          <button class="ib" title="更多" @click.stop="menuFor = menuFor === c.id ? null : c.id"><Icon name="more" /></button>
          <div v-if="menuFor === c.id" class="mini-menu">
            <button @click.stop="startRename(c)">重命名</button>
            <button class="dgr" @click.stop="removeChat(c)">删除</button>
          </div>
        </div>
      </template>
      <div v-if="!ai.chats.length" class="m-empty"><p>还没有对话</p></div>
    </div>

    <div v-if="renaming" class="m-ovl">
      <div class="mask" @click="renaming = null"></div>
      <div class="dialog">
        <h2>重命名</h2>
        <div class="inp"><input v-model="newTitle" @keyup.enter="confirmRename" /></div>
        <div class="acts">
          <button class="btn text" @click="renaming = null">取消</button>
          <button class="btn pri" :disabled="!newTitle.trim()" @click="confirmRename">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>
