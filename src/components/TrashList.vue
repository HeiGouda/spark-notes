<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ask } from "@tauri-apps/plugin-dialog";
import Icon from "./Icon.vue";
import { api, type TrashItem } from "../lib/api";
import { formatGitWhen } from "../lib/gitTime";
import { useNoticeStore } from "../stores/notice";
import { useVaultStore } from "../stores/vault";

const DAY_MS = 24 * 60 * 60 * 1000;

const vault = useVaultStore();
const items = ref<TrashItem[]>([]);
const days = ref(30);
const query = ref("");
const selected = ref(new Set<string>());
const busy = ref(false);
const loaded = ref(false);

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return items.value;
  return items.value.filter((t) => t.name.toLowerCase().includes(q) || t.originalPath.toLowerCase().includes(q));
});
const picked = computed(() => shown.value.filter((t) => selected.value.has(t.id)));
const allPicked = computed(() => shown.value.length > 0 && picked.value.length === shown.value.length);

watch(query, () => { selected.value = new Set(); });

async function loadDays(root: string) {
  try {
    const raw = await api.readConfig(root, "retention.json");
    const v = raw ? JSON.parse(raw) as { trashDays?: number } : {};
    days.value = Number.isInteger(v.trashDays) && v.trashDays! >= 0 ? v.trashDays! : 30;
  } catch {
    days.value = 30;
  }
}

async function load() {
  const root = vault.root;
  if (!root) return;
  try {
    const [list] = await Promise.all([api.trashList(root), loadDays(root)]);
    items.value = list;
    const ids = new Set(list.map((t) => t.id));
    selected.value = new Set([...selected.value].filter((id) => ids.has(id)));
  } catch (e) {
    useNoticeStore().report("读取回收站失败", e);
  } finally {
    loaded.value = true;
  }
}

defineExpose({ load });
onMounted(() => void load());

function folderOf(item: TrashItem): string {
  const i = Math.max(item.originalPath.lastIndexOf("/"), item.originalPath.lastIndexOf("\\"));
  return i > 0 ? item.originalPath.slice(0, i) : "根目录";
}

function leftDays(item: TrashItem): number {
  return Math.ceil((item.deletedAt + days.value * DAY_MS - Date.now()) / DAY_MS);
}

function leftLabel(item: TrashItem): string {
  if (!days.value) return "不自动清理";
  const n = leftDays(item);
  return n <= 0 ? "即将清理" : `${n} 天后清理`;
}

function toggle(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleAll() {
  selected.value = allPicked.value ? new Set() : new Set(shown.value.map((t) => t.id));
}

async function restoreAll(list: TrashItem[]) {
  const root = vault.root;
  if (!root || busy.value || !list.length) return;
  busy.value = true;
  let ok = 0;
  let failed: unknown = null;
  try {
    for (const item of list) {
      try {
        await api.trashRestore(root, item.id);
        ok++;
      } catch (e) {
        failed ??= e;
      }
    }
    if (ok) await vault.refresh();
    if (ok === 1 && list.length === 1) useNoticeStore().inform(`已恢复「${list[0].name}」到 ${folderOf(list[0])}`);
    else if (ok) useNoticeStore().inform(`已恢复 ${ok} 项`);
    if (failed) useNoticeStore().report(list.length === 1 ? "恢复失败" : `有 ${list.length - ok} 项恢复失败`, failed);
  } finally {
    busy.value = false;
    await load();
  }
}

async function removeAll(list: TrashItem[]) {
  const root = vault.root;
  if (!root || busy.value || !list.length) return;
  const text = list.length === 1 ? `彻底删除「${list[0].name}」？此操作不能恢复。` : `彻底删除选中的 ${list.length} 项？此操作不能恢复。`;
  const ok = await ask(text, { title: "彻底删除", kind: "warning", okLabel: "彻底删除", cancelLabel: "取消" });
  if (!ok) return;
  busy.value = true;
  try {
    for (const item of list) await api.trashDelete(root, item.id);
  } catch (e) {
    useNoticeStore().report("彻底删除失败", e);
  } finally {
    busy.value = false;
    await load();
  }
}

async function empty() {
  const root = vault.root;
  if (!root || busy.value || !items.value.length) return;
  const ok = await ask("清空回收站？其中的笔记和附件都会被彻底删除。", {
    title: "清空回收站", kind: "warning", okLabel: "清空", cancelLabel: "取消",
  });
  if (!ok) return;
  busy.value = true;
  try {
    await api.trashEmpty(root);
    useNoticeStore().inform("已清空回收站");
  } catch (e) {
    useNoticeStore().report("清空回收站失败", e);
  } finally {
    busy.value = false;
    await load();
  }
}
</script>

<template>
  <div class="tl">
    <div class="tl-bar">
      <span class="tl-count">{{ items.length ? `共 ${items.length} 项` : "" }}</span>
      <input v-if="items.length" v-model="query" class="tl-search" type="text" spellcheck="false" placeholder="搜索文件名或位置" aria-label="搜索回收站" />
      <button class="fb-txt is-danger" type="button" :disabled="!items.length || busy" @click="empty()">清空</button>
    </div>
    <div v-if="items.length" class="tl-head">
      <label class="tl-all"><input type="checkbox" :checked="allPicked" :indeterminate="picked.length > 0 && !allPicked" :disabled="!shown.length" @change="toggleAll()" />全选</label>
      <template v-if="picked.length">
        <span class="tl-picked">已选 {{ picked.length }} 项</span>
        <button class="fb-txt" type="button" :disabled="busy" @click="restoreAll(picked)">恢复所选</button>
        <button class="fb-txt is-danger" type="button" :disabled="busy" @click="removeAll(picked)">彻底删除所选</button>
      </template>
    </div>
    <div v-if="loaded && !items.length" class="tl-empty">
      <Icon name="trash" />
      <p>回收站是空的</p>
      <p class="git-hint">{{ days ? `删除的笔记和文件夹会在这里保留 ${days} 天。` : "删除的笔记和文件夹会一直留在这里，直到彻底删除。" }}</p>
    </div>
    <div v-else-if="items.length && !shown.length" class="tl-empty"><p class="git-hint">没有找到匹配的项。</p></div>
    <ul v-else-if="shown.length" class="tl-list">
      <li v-for="item in shown" :key="item.id" class="tl-row" :class="{ on: selected.has(item.id) }">
        <input type="checkbox" :checked="selected.has(item.id)" :aria-label="`选择 ${item.name}`" @change="toggle(item.id)" />
        <Icon :name="item.isDir ? 'folder' : 'file'" sm />
        <div class="tl-main" :title="item.originalPath">
          <div class="log-msg">{{ item.name }}</div>
          <div class="log-meta">
            {{ folderOf(item) }} · {{ formatGitWhen(item.deletedAt / 1000) }} ·
            <span :class="{ 'tl-soon': days && leftDays(item) <= 7 }">{{ leftLabel(item) }}</span>
          </div>
        </div>
        <div class="tl-acts">
          <button class="fb-txt" type="button" :disabled="busy" @click="restoreAll([item])">恢复</button>
          <button class="fb-txt is-danger" type="button" :disabled="busy" @click="removeAll([item])">彻底删除</button>
        </div>
      </li>
    </ul>
  </div>
</template>
