<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { groupByDay } from "../lib/chat";
import type { ChatSummary } from "../lib/api";
import { useChatStore } from "../stores/chat";

const chat = useChatStore();
const groups = computed(() => groupByDay(chat.list));
const menu = ref<{ id: string; x: number; y: number } | null>(null);
const renaming = ref<string | null>(null);
const deleting = ref<ChatSummary | null>(null);
const listEl = ref<HTMLElement | null>(null);

function openMenu(e: MouseEvent, id: string) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = { id, x: Math.min(r.left, window.innerWidth - 150), y: r.bottom + 2 };
}

async function startRename(id: string) {
  menu.value = null;
  renaming.value = id;
  await nextTick();
  const input = listEl.value?.querySelector<HTMLInputElement>(".row-rename");
  input?.focus();
  input?.select();
}

function finishRename(id: string, value: string) {
  if (renaming.value !== id) return;
  renaming.value = null;
  void chat.rename(id, value);
}

function askDelete(id: string) {
  menu.value = null;
  deleting.value = chat.list.find((c) => c.id === id) ?? null;
}

async function confirmDelete() {
  const target = deleting.value;
  deleting.value = null;
  if (target) await chat.remove(target.id);
}

function onDocDown(e: MouseEvent) {
  if (menu.value && !(e.target as HTMLElement).closest(".chat-menu")) menu.value = null;
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (deleting.value) {
    e.preventDefault();
    e.stopImmediatePropagation();
    deleting.value = null;
  }
  menu.value = null;
}

onMounted(() => {
  void chat.loadList();
  document.addEventListener("mousedown", onDocDown, true);
  window.addEventListener("keydown", onKey, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocDown, true);
  window.removeEventListener("keydown", onKey, true);
});
</script>

<template>
  <div class="chats">
    <div class="tree-head"><span class="vault">AI 对话</span></div>
    <button class="chat-new" type="button" @click="chat.newChat()"><Icon name="plus" sm />新对话</button>
    <div ref="listEl" class="chat-list">
      <p v-if="chat.loadError" class="side-error">读取会话列表失败：{{ chat.loadError }}</p>
      <template v-for="g in groups" :key="g.label">
        <div class="chat-group">{{ g.label }}</div>
        <div
          v-for="c in g.items"
          :key="c.id"
          class="row"
          :class="{ 'is-active': chat.current?.id === c.id }"
          tabindex="0"
          @click="chat.open(c.id)"
          @contextmenu.prevent="openMenu($event, c.id)"
        >
          <Icon name="chat" sm />
          <input
            v-if="renaming === c.id"
            class="row-rename"
            :value="c.title"
            aria-label="会话名称"
            @click.stop
            @keydown.enter.prevent="finishRename(c.id, ($event.target as HTMLInputElement).value)"
            @keydown.esc.stop.prevent="renaming = null"
            @blur="finishRename(c.id, ($event.target as HTMLInputElement).value)"
          />
          <span v-else class="name" :title="c.title">{{ c.title }}</span>
          <button class="btn more" type="button" title="更多" @click.stop="openMenu($event, c.id)"><Icon name="dots" sm /></button>
        </div>
      </template>
      <p v-if="!chat.list.length && !chat.loadError" class="chat-none">还没有对话</p>
    </div>
    <div v-if="menu" class="menu chat-menu" :style="{ position: 'fixed', left: `${menu.x}px`, top: `${menu.y}px` }" role="menu">
      <button class="menu-item" role="menuitem" @click="startRename(menu.id)"><span class="mark"><Icon name="edit" sm /></span><span class="label">重命名</span></button>
      <button class="menu-item danger" role="menuitem" @click="askDelete(menu.id)"><span class="mark"><Icon name="trash" sm /></span><span class="label">删除</span></button>
    </div>
    <div v-if="deleting" class="mask" @mousedown.self="deleting = null">
      <div class="pop ai-dlg ai-small" role="dialog" aria-label="删除会话">
        <div class="keys-head">
          <h3>删除这个对话？</h3>
          <button class="btn" type="button" title="关闭 (Esc)" @click="deleting = null"><Icon name="close" sm /></button>
        </div>
        <div class="ai-dlg-body"><p>“{{ deleting.title }}”的全部消息和附件会从这台电脑上删除，无法恢复。已经插入或保存到笔记里的内容不受影响。</p></div>
        <div class="ai-dlg-actions">
          <span class="flex" />
          <button class="fb-txt" type="button" @click="deleting = null">取消</button>
          <button class="btn-primary btn-danger" type="button" @click="confirmDelete()">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>
