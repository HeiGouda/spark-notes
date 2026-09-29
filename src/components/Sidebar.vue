<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import TreeRows from "./TreeRows.vue";
import MenuList, { type MenuEntry } from "./MenuList.vue";
import { shortcutOf, tipFor } from "../lib/commands";
import { displayShortcut } from "../lib/shortcut";
import { dirOf } from "../lib/api";
import { dragging, dropTarget, endDrag } from "../lib/treeDrag";
import { useVaultStore } from "../stores/vault";
import { useTabsStore } from "../stores/tabs";
import { useContextMenuStore } from "../stores/contextMenu";
import type { SortKey } from "../stores/settings";
import { useUiStore, type SidebarView } from "../stores/ui";
import SearchView from "./SearchView.vue";
import TagsView from "./TagsView.vue";
import FavoritesView from "./FavoritesView.vue";
import OutlineView from "./OutlineView.vue";
import ScmView from "./ScmView.vue";
import ChatList from "./ChatList.vue";
import { useGitStore } from "../stores/git";
import { runCommand } from "../lib/commands";
import { useNoticeStore } from "../stores/notice";

const vault = useVaultStore();
const tabs = useTabsStore();
const ui = useUiStore();
const git = useGitStore();

const VIEWS: { id: SidebarView; title: string; icon: string }[] = [
  { id: "files", title: "文件", icon: "folder" },
  { id: "search", title: tipFor("搜索", "search.focus"), icon: "search" },
  { id: "tags", title: "标签", icon: "tag" },
  { id: "favorites", title: "收藏", icon: "star" },
  { id: "outline", title: "大纲", icon: "outline" },
  { id: "scm", title: "版本控制", icon: "git" },
];
/** 点左栏其他视图即回到笔记（需求文档 5.17） */
function pickView(id: SidebarView) {
  ui.showNotes();
  if (id === "search") ui.search();
  else ui.view = id;
}

function openChat() {
  runCommand("ai.chat").catch((e) => useNoticeStore().report("打开 AI 对话失败", e));
}

const ctxMenu = useContextMenuStore();
const treeEl = ref<HTMLElement | null>(null);
const sortAt = ref<{ x: number; y: number } | null>(null);

const SORTS: [SortKey, string][] = [
  ["name", "名称"],
  ["modified", "修改时间"],
  ["created", "创建时间"],
  ["custom", "自定义（拖拽排序）"],
];

function sortItems(): MenuEntry[] {
  return [
    ...SORTS.map(([key, label]): MenuEntry => ({
      kind: "item", label, checked: () => vault.sortKey === key, action: () => vault.setSort(key),
    })),
    { kind: "sep" },
    { kind: "item", label: "升序", checked: () => !vault.sortDesc, disabled: vault.sortKey === "custom", action: () => vault.setSort(vault.sortKey, false) },
    { kind: "item", label: "降序", checked: () => vault.sortDesc, disabled: vault.sortKey === "custom", action: () => vault.setSort(vault.sortKey, true) },
  ];
}

function toggleSortMenu(e: MouseEvent) {
  if (sortAt.value) {
    sortAt.value = null;
    return;
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  sortAt.value = { x: r.left, y: r.bottom + 4 };
}

function onSortOutside(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (sortAt.value && !t.closest(".sort-menu, .sort-btn")) sortAt.value = null;
}
onMounted(() => document.addEventListener("mousedown", onSortOutside, true));
onBeforeUnmount(() => document.removeEventListener("mousedown", onSortOutside, true));

function onBlankMenu(e: MouseEvent) {
  vault.selected = null;
  ctxMenu.show(e, [
    { kind: "item", label: "新建笔记", hint: displayShortcut(shortcutOf("file.newNote")), action: () => vault.newNote("") },
    { kind: "item", label: "新建文件夹", hint: displayShortcut(shortcutOf("file.newFolder")), action: () => vault.newFolder("") },
  ]);
}

function onBlankClick(e: MouseEvent) {
  if (e.target === treeEl.value) vault.selected = null;
}

/** 拖到空白处：移到根目录 */
function onBlankDragOver(e: DragEvent) {
  if (!dragging.value || dirOf(dragging.value) === "") return;
  e.preventDefault();
  dropTarget.value = null;
}

async function onBlankDrop(e: DragEvent) {
  e.preventDefault();
  const from = dragging.value;
  endDrag();
  if (from) await vault.move(from, "");
}

/** 当前笔记在树中自动定位 */
watch(
  () => tabs.activePath,
  async () => {
    await nextTick();
    treeEl.value?.querySelector(".row.is-active")?.scrollIntoView({ block: "nearest" });
  },
);

/** 新建或按 F2 后进入改名状态时聚焦输入框并全选 */
watch(
  () => vault.renaming,
  async (path) => {
    if (!path) return;
    await nextTick();
    const input = treeEl.value?.querySelector<HTMLInputElement>(".row-rename");
    input?.scrollIntoView({ block: "nearest" });
    input?.focus();
    input?.select();
  },
);
</script>

<template>
  <aside class="sidebar">
    <nav class="views" aria-label="侧栏视图">
      <button
        v-for="v in VIEWS"
        :key="v.id"
        class="btn"
        :class="{ 'is-active': ui.view === v.id }"
        :title="v.title"
        :disabled="!vault.root && v.id !== 'files'"
        @click="pickView(v.id)"
      >
        <Icon :name="v.icon" />
        <span v-if="v.id === 'scm' && git.badge" class="view-badge">{{ git.badge }}</span>
      </button>
    </nav>
    <template v-if="ui.view === 'chat'"><ChatList /></template>
    <template v-else-if="vault.root && ui.view === 'search'"><SearchView /></template>
    <template v-else-if="vault.root && ui.view === 'tags'"><TagsView /></template>
    <template v-else-if="vault.root && ui.view === 'favorites'"><FavoritesView /></template>
    <template v-else-if="vault.root && ui.view === 'outline'"><OutlineView /></template>
    <template v-else-if="vault.root && ui.view === 'scm'"><ScmView /></template>
    <template v-else-if="vault.root">
      <div class="tree-head">
        <span class="vault" :title="vault.root">{{ vault.name }}</span>
        <button class="btn" :title="tipFor('新建笔记', 'file.newNote')" @click="vault.newNote()"><Icon name="file-plus" sm /></button>
        <button class="btn" :title="tipFor('新建文件夹', 'file.newFolder')" @click="vault.newFolder()"><Icon name="folder-plus" sm /></button>
        <button class="btn sort-btn" :class="{ 'is-active': sortAt }" title="排序方式" @click="toggleSortMenu"><Icon name="sort" sm /></button>
        <button class="btn" title="全部折叠" @click="vault.collapseAll()"><Icon name="collapse" sm /></button>
      </div>
      <ul
        ref="treeEl"
        class="tree"
        role="tree"
        @click="onBlankClick"
        @contextmenu.self="onBlankMenu"
        @dragover="onBlankDragOver"
        @drop="onBlankDrop"
      >
        <TreeRows :nodes="vault.sortedTree" :depth="0" />
      </ul>
    </template>
    <div v-else class="side-empty">
      <span>尚未打开笔记库</span>
      <button class="plain-btn" @click="vault.pickAndOpen()">打开文件夹</button>
    </div>
    <div v-if="vault.loadError && ui.view !== 'chat'" class="side-error">{{ vault.loadError }}</div>
    <div class="side-foot">
      <button class="row" :class="{ 'is-active': ui.view === 'chat' }" type="button" :title="tipFor('AI 对话', 'ai.chat')" @click="openChat()">
        <Icon name="sparkle" /><span class="name">AI 对话</span>
      </button>
    </div>
    <MenuList v-if="sortAt" class="sort-menu" :items="sortItems()" :at="sortAt" @done="sortAt = null" />
  </aside>
</template>
