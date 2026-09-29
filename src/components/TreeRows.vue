<script setup lang="ts">
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import Icon from "./Icon.vue";
import type { MenuEntry } from "./MenuList.vue";
import { dirOf, isWithin, type TreeNode } from "../lib/api";
import { DRAG_MIME, dragging, dropTarget, endDrag, type DropWhere } from "../lib/treeDrag";
import { useVaultStore } from "../stores/vault";
import { useTabsStore } from "../stores/tabs";
import { useNoticeStore } from "../stores/notice";
import { useContextMenuStore } from "../stores/contextMenu";
import { shortcutOf } from "../lib/commands";
import { displayShortcut } from "../lib/shortcut";
import { fileManagerName, isMac } from "../lib/platform";

defineProps<{ nodes: TreeNode[]; depth: number }>();
const vault = useVaultStore();
const tabs = useTabsStore();
const ctxMenu = useContextMenuStore();

function click(node: TreeNode) {
  vault.selected = node.path;
  if (node.isDir) vault.toggle(node.path);
  else void tabs.open(node.path, { preview: true });
}

function dblclick(node: TreeNode) {
  if (!node.isDir) void tabs.open(node.path);
}

function onKey(e: KeyboardEvent, node: TreeNode) {
  if (vault.renaming) return;
  if (e.key === "Enter") {
    e.preventDefault();
    if (node.isDir) vault.toggle(node.path);
    else void tabs.open(node.path);
  } else if (e.key === "F2") {
    e.preventDefault();
    vault.renaming = node.path;
  } else if (e.key === "Delete" || (isMac && e.metaKey && e.key === "Backspace")) {
    e.preventDefault();
    void vault.trash(node.path);
  }
}

async function copyPath(node: TreeNode) {
  try {
    await navigator.clipboard.writeText(vault.absolutePath(node.path));
  } catch (e) {
    useNoticeStore().report("复制路径失败", e);
  }
}

async function reveal(node: TreeNode) {
  try {
    await revealItemInDir(vault.absolutePath(node.path));
  } catch (e) {
    useNoticeStore().report(`在${fileManagerName}中显示失败`, e);
  }
}

function onMenu(e: MouseEvent, node: TreeNode) {
  vault.selected = node.path;
  const dir = node.isDir ? node.path : dirOf(node.path);
  const items: MenuEntry[] = [
    { kind: "item", label: "新建笔记", hint: displayShortcut(shortcutOf("file.newNote")), action: () => vault.newNote(dir) },
    { kind: "item", label: "新建文件夹", hint: displayShortcut(shortcutOf("file.newFolder")), action: () => vault.newFolder(dir) },
    { kind: "sep" },
    { kind: "item", label: "重命名", hint: "F2", action: () => (vault.renaming = node.path) },
    { kind: "item", label: "删除", hint: isMac ? "Cmd+Backspace" : "Delete", action: () => vault.trash(node.path) },
    { kind: "sep" },
    { kind: "item", label: vault.favorites.has(node.path) ? "取消收藏" : "收藏", action: () => vault.toggleFavorite(node.path) },
    { kind: "item", label: "复制路径", action: () => copyPath(node) },
    { kind: "item", label: isMac ? "在访达中显示" : "在资源管理器中打开", action: () => reveal(node) },
  ];
  ctxMenu.show(e, items);
}

/* ---------- 就地改名 ---------- */
let committing = false;

async function commitRename(node: TreeNode, input: HTMLInputElement) {
  if (committing || vault.renaming !== node.path) return;
  committing = true;
  const value = input.value;
  vault.renaming = null;
  const rel = await vault.rename(node.path, value);
  committing = false;
  if (rel && !node.isDir && tabs.activePath === rel) vault.selected = rel;
}

function onRenameKey(e: KeyboardEvent, node: TreeNode) {
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    void commitRename(node, e.target as HTMLInputElement);
  } else if (e.key === "Escape") {
    e.preventDefault();
    vault.renaming = null;
  }
}

/* ---------- 拖拽 ---------- */
function onDragStart(e: DragEvent, node: TreeNode) {
  if (vault.renaming) return e.preventDefault();
  dragging.value = node.path;
  e.dataTransfer?.setData(DRAG_MIME, node.path);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

function whereOf(e: DragEvent, node: TreeNode): DropWhere | null {
  const from = dragging.value;
  if (!from || isWithin(node.path, from)) return null;
  const el = e.currentTarget as HTMLElement;
  const ratio = (e.clientY - el.getBoundingClientRect().top) / el.offsetHeight;
  const custom = vault.sortKey === "custom";
  if (node.isDir) {
    if (custom && ratio < 0.25) return "before";
    if (custom && ratio > 0.75) return "after";
    return "into";
  }
  if (custom) return ratio < 0.5 ? "before" : "after";
  // 非自定义排序时，拖到笔记上等同于移入它所在的文件夹
  return dirOf(node.path) === dirOf(from) ? null : "into";
}

function onDragOver(e: DragEvent, node: TreeNode) {
  if (!dragging.value) return;
  // 不让事件冒泡到空白区域，否则会被当作“移到根目录”
  e.stopPropagation();
  const where = whereOf(e, node);
  if (!where) {
    dropTarget.value = null;
    return;
  }
  e.preventDefault();
  dropTarget.value = { path: node.path, where };
}

async function onDrop(e: DragEvent, node: TreeNode) {
  e.preventDefault();
  e.stopPropagation();
  const from = dragging.value;
  const target = dropTarget.value;
  endDrag();
  if (!from || !target || target.path !== node.path) return;
  if (target.where === "into") await vault.move(from, node.isDir ? node.path : dirOf(node.path));
  else await vault.place(from, node.path, target.where);
}

function dropClass(node: TreeNode) {
  const t = dropTarget.value;
  if (!t || t.path !== node.path) return "";
  if (t.where === "into") return node.isDir ? "drop-into" : "";
  return `drop-${t.where}`;
}
</script>

<template>
  <template v-for="node in nodes" :key="node.path">
    <li
      class="row"
      :class="[
        {
          'is-active': !node.isDir && node.path === tabs.activePath,
          'is-selected': node.path === vault.selected,
          'is-dragging': node.path === dragging,
        },
        dropClass(node),
      ]"
      :style="{ '--d': depth }"
      role="treeitem"
      :aria-expanded="node.isDir ? vault.expanded.has(node.path) : undefined"
      tabindex="0"
      :title="node.path"
      :draggable="vault.renaming !== node.path"
      @click="click(node)"
      @dblclick="dblclick(node)"
      @keydown="onKey($event, node)"
      @contextmenu="onMenu($event, node)"
      @dragstart="onDragStart($event, node)"
      @dragover="onDragOver($event, node)"
      @drop="onDrop($event, node)"
      @dragend="endDrag()"
    >
      <Icon v-if="node.isDir" class="chev" :name="vault.expanded.has(node.path) ? 'down' : 'right'" />
      <span v-else class="spacer" />
      <Icon :name="node.isDir ? 'folder' : 'file'" />
      <input
        v-if="vault.renaming === node.path"
        class="row-rename"
        :value="node.name"
        spellcheck="false"
        @click.stop
        @dblclick.stop
        @keydown="onRenameKey($event, node)"
        @blur="commitRename(node, $event.target as HTMLInputElement)"
      />
      <span v-else class="name">{{ node.name }}</span>
      <Icon v-if="vault.favorites.has(node.path)" class="star" name="star" sm />
    </li>
    <TreeRows v-if="node.isDir && vault.expanded.has(node.path)" :nodes="node.children" :depth="depth + 1" />
  </template>
</template>
