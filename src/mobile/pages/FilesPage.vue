<script setup lang="ts">
import { computed, ref } from "vue";
import type { TreeNode } from "../../lib/api";
import Icon from "../Icon.vue";
import StatusLine from "../StatusLine.vue";
import { favoriteNotes, folderItems, folderLabel, timeLabel } from "../browse";
import { useMobile } from "../store";
import { back, go, open } from "../nav";

const props = defineProps<{ path: string }>();
const store = useMobile();

const synced = computed(() => (store.currentId ? (store.meta[store.currentId]?.lastSyncMs ?? 0) > 0 : false));
const items = computed(() => folderItems(store.tree, props.path, store.order));
const favs = computed(() => (props.path ? [] : favoriteNotes(store.tree, store.favorites)));
const favSet = computed(() => new Set(store.favorites));
const title = computed(() => props.path.slice(props.path.lastIndexOf("/") + 1));
const crumbs = computed(() => [store.current?.name ?? "", ...props.path.split("/").slice(0, -1)].join(" / "));

function openNode(n: TreeNode) {
  go(n.isDir ? { p: "files", path: n.path } : { p: "note", path: n.path });
}

/* 下拉刷新：列表在顶部时往下拖超过 100px 松手 */
const scroller = ref<HTMLElement | null>(null);
const pull = ref(0);
let startY: number | null = null;

function onTouchStart(e: TouchEvent) {
  startY = scroller.value && scroller.value.scrollTop <= 0 ? e.touches[0].clientY : null;
  pull.value = 0;
}

function onTouchMove(e: TouchEvent) {
  if (startY == null) return;
  pull.value = Math.max(0, e.touches[0].clientY - startY);
}

function onTouchEnd() {
  if (startY != null && pull.value > 100) void store.runSync();
  startY = null;
  pull.value = 0;
}
</script>

<template>
  <div class="page">
    <div class="top">
      <template v-if="path">
        <button class="ib" @click="back()"><Icon name="back" /></button>
        <h1>{{ title }}<small>{{ crumbs }}</small></h1>
      </template>
      <button v-else class="libsw" @click="open({ t: 'libs' })">
        <span>{{ store.current?.name }}</span><Icon name="down" :size="18" />
      </button>
    </div>
    <StatusLine />
    <div
      ref="scroller"
      class="scroll"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchEnd"
    >
      <div class="ptr" :style="{ height: Math.min(pull * 0.5, 56) + 'px', transition: pull ? 'none' : '' }">
        {{ pull > 100 ? "松开刷新" : "下拉刷新" }}
      </div>
      <div v-if="!synced" class="m-empty">
        <Icon name="cloud" :size="44" />
        <p>还没有下载这个笔记库的笔记</p>
        <p style="margin-top: 14px">
          <button class="btn pri" @click="store.currentId && go({ p: 'firstsync', id: store.currentId })">开始下载</button>
        </p>
      </div>
      <template v-else>
        <template v-if="favs.length">
          <div class="sec">收藏</div>
          <button v-for="n in favs" :key="'fav-' + n.path" class="row" @click="openNode(n)">
            <span class="ic"><Icon name="note" :size="20" /></span>
            <span class="main">
              <div class="name">{{ n.name }}</div>
              <div class="sub">{{ folderLabel(n.path) }} · {{ timeLabel(n.modifiedMs) }}</div>
            </span>
            <span class="end star"><Icon name="star" :size="14" /></span>
          </button>
          <div class="sec">全部</div>
        </template>
        <button v-for="n in items" :key="n.path" class="row" @click="openNode(n)">
          <span class="ic"><Icon :name="n.isDir ? 'folder' : 'note'" :size="20" /></span>
          <span class="main">
            <div class="name">{{ n.name }}</div>
            <div class="sub">{{ n.isDir ? `${n.children.length} 项` : timeLabel(n.modifiedMs) }}</div>
          </span>
          <span class="end">
            <Icon v-if="n.isDir" name="chev" :size="18" />
            <span v-else-if="favSet.has(n.path)" class="star"><Icon name="star" :size="14" /></span>
          </span>
        </button>
        <div v-if="!items.length" class="m-empty">{{ path ? "这个文件夹是空的" : "云端目录里还没有笔记" }}</div>
      </template>
    </div>
  </div>
</template>
