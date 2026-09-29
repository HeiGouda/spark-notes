<script setup lang="ts">
import { ref } from "vue";
import Icon from "./Icon.vue";
import { useVaultStore } from "../stores/vault";
import { useTabsStore, nameOf } from "../stores/tabs";
import { useContextMenuStore } from "../stores/contextMenu";
import { useUiStore } from "../stores/ui";

const vault = useVaultStore();
const tabs = useTabsStore();
const ctxMenu = useContextMenuStore();
const ui = useUiStore();
const dragFrom = ref<number | null>(null);
const dropAt = ref<number | null>(null);

function isDir(path: string) {
  return vault.node(path)?.isDir ?? false;
}

function open(path: string, pin = false) {
  if (isDir(path)) {
    vault.reveal(path);
    vault.expand(path);
    vault.selected = path;
    ui.view = "files";
    return;
  }
  void tabs.open(path, { preview: !pin });
}

function onMenu(e: MouseEvent, path: string) {
  ctxMenu.show(e, [
    { kind: "item", label: "取消收藏", action: () => vault.toggleFavorite(path) },
    { kind: "item", label: "在文件树中定位", action: () => { vault.reveal(path); vault.selected = path; } },
  ]);
}

function onDrop(i: number) {
  if (dragFrom.value !== null) vault.reorderFavorite(dragFrom.value, i);
  dragFrom.value = dropAt.value = null;
}
</script>

<template>
  <div class="side-view">
    <ul class="tree">
      <li
        v-for="(p, i) in vault.favoriteList"
        :key="p"
        class="row"
        :class="{ 'is-active': p === tabs.activePath, 'drop-before': dropAt === i && dragFrom !== i, 'is-missing': !vault.node(p) }"
        tabindex="0"
        :title="vault.node(p) ? p : `${p}（已不存在）`"
        draggable="true"
        @click="open(p)"
        @dblclick="open(p, true)"
        @contextmenu="onMenu($event, p)"
        @dragstart="dragFrom = i"
        @dragover.prevent="dropAt = i"
        @drop.prevent="onDrop(i)"
        @dragend="dragFrom = dropAt = null"
      >
        <span class="spacer" />
        <Icon :name="isDir(p) ? 'folder' : 'file'" />
        <span class="name">{{ isDir(p) ? p.split("/").pop() : nameOf(p) }}</span>
        <Icon class="star" name="star" sm />
      </li>
    </ul>
    <div v-if="!vault.favoriteList.length" class="side-empty">还没有收藏。在文件树中右键笔记或文件夹即可收藏</div>
  </div>
</template>
