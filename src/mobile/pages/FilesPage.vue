<script setup lang="ts">
import { computed, ref } from "vue";
import type { TreeNode } from "../../lib/api";
import Icon from "../Icon.vue";
import StatusLine from "../StatusLine.vue";
import { DOC_TAG, docKind, type DocKind } from "../../lib/doctype";
import type { IconName } from "../icons";
import { favoriteNotes, folderItems, folderLabel, timeLabel } from "../browse";
import { useMobile } from "../store";
import { addBackInterceptor, back, go, open, openDoc, toast } from "../nav";
import { askWithCheck } from "../dialog";
import { mobileApi } from "../api";
import { onBeforeUnmount } from "vue";

const props = defineProps<{ path: string }>();
const store = useMobile();

const synced = computed(() => (store.currentId ? (store.meta[store.currentId]?.lastSyncMs ?? 0) > 0 : false));
const items = computed(() => folderItems(store.tree, props.path, store.order, store.sort));
const favs = computed(() => (props.path ? [] : favoriteNotes(store.tree, store.favorites)));
const favSet = computed(() => new Set(store.favorites));
const title = computed(() => props.path.slice(props.path.lastIndexOf("/") + 1));
const crumbs = computed(() => [store.current?.name ?? "", ...props.path.split("/").slice(0, -1)].join(" / "));

function kindOf(n: TreeNode): DocKind {
  return docKind(n.path) ?? "note";
}

/** 表格簿在磁盘上是文件夹，但这里像文件一样直接打开 */
const isFolder = (n: TreeNode) => n.isDir && !n.book;

function iconOf(n: TreeNode): IconName {
  if (n.book) return "book";
  const k = kindOf(n);
  return k === "note" ? "note" : k;
}

function openNode(n: TreeNode) {
  if (held) {
    held = false;
    return;
  }
  if (isFolder(n)) go({ p: "files", path: n.path });
  else openDoc(n.path);
}

/* 长按一项：底部弹出菜单，可以删除 */
const menu = ref<TreeNode | null>(null);
let holdTimer = 0;
let held = false;
function holdStart(n: TreeNode) {
  held = false;
  clearTimeout(holdTimer);
  holdTimer = window.setTimeout(() => {
    held = true;
    menu.value = n;
    navigator.vibrate?.(12);
  }, 500);
}
function holdEnd() {
  clearTimeout(holdTimer);
}
const removeBack = addBackInterceptor(() => {
  if (!menu.value) return false;
  menu.value = null;
  return true;
});
onBeforeUnmount(removeBack);

function kindLabel(n: TreeNode): string {
  if (n.book) return "表格簿";
  if (isFolder(n)) return "文件夹";
  return DOC_TAG[kindOf(n)] || "笔记";
}

async function removeNode(n: TreeNode) {
  menu.value = null;
  const id = store.currentId;
  if (!id) return;
  const what = kindLabel(n);
  const inner = isFolder(n) || n.book ? "，里面的内容会一起删除" : "";
  const { ok, checked } = await askWithCheck({
    title: `删除${what}“${n.name}”？`,
    message: `不勾选时只删这台手机上的${inner}，以后同步也不再下载，云端和电脑上的还在。`,
    check: "同时删除云端文件（移进云端回收站，电脑下次同步时也会删除）",
    ok: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await mobileApi.deleteNote(id, n.path, checked);
    await store.loadTree();
    toast(checked ? "已删除，云端的已移进回收站" : "已从这台手机删除");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
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
      <template v-else-if="store.current">
        <button class="libsw" @click="open({ t: 'libs' })">
          <span>{{ store.current.name }}</span><Icon name="down" :size="18" />
        </button>
        <span class="grow"></span>
        <button class="ib" title="最近打开" @click="go({ p: 'recent' })"><Icon name="recent" /></button>
      </template>
      <h1 v-else>绑定 WebDAV</h1>
    </div>
    <StatusLine v-if="store.current" />
    <div
      ref="scroller"
      class="scroll"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchEnd"
    >
      <div v-if="store.current" class="ptr" :style="{ height: Math.min(pull * 0.5, 56) + 'px', transition: pull ? 'none' : '' }">
        {{ pull > 100 ? "松开刷新" : "下拉刷新" }}
      </div>
      <div v-if="!store.current" class="m-empty">
        <Icon name="cloud" :size="44" />
        <p>绑定 WebDAV</p>
        <p style="margin-top: 14px">
          <button class="btn pri" @click="go({ p: 'form', id: null })">去绑定</button>
        </p>
      </div>
      <template v-else>
      <button v-if="!path" class="search-box" @click="go({ p: 'search' })">
        <Icon name="search" :size="18" />搜索 {{ store.current.name }}
      </button>
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
          <button v-for="n in favs" :key="'fav-' + n.path" class="row" @click="openNode(n)" @pointerdown="holdStart(n)" @pointerup="holdEnd" @pointerleave="holdEnd" @pointercancel="holdEnd" @contextmenu.prevent="menu = n">
            <span class="ic"><Icon :name="iconOf(n)" :size="20" /></span>
            <span class="main">
              <div class="name">{{ n.name }}<span v-if="DOC_TAG[kindOf(n)]" class="badge">{{ DOC_TAG[kindOf(n)] }}</span></div>
              <div class="sub">{{ folderLabel(n.path) }} · {{ timeLabel(n.modifiedMs) }}</div>
            </span>
            <span class="end star"><Icon name="star" :size="14" /></span>
          </button>
          <div class="sec">全部</div>
        </template>
        <button v-for="n in items" :key="n.path" class="row" @click="openNode(n)" @pointerdown="holdStart(n)" @pointerup="holdEnd" @pointerleave="holdEnd" @pointercancel="holdEnd" @contextmenu.prevent="menu = n">
          <span class="ic"><Icon :name="isFolder(n) ? 'folder' : iconOf(n)" :size="20" /></span>
          <span class="main">
            <div class="name">{{ n.name }}<span v-if="!n.isDir && DOC_TAG[kindOf(n)]" class="badge">{{ DOC_TAG[kindOf(n)] }}</span></div>
            <div class="sub">{{ isFolder(n) ? `${n.children.length} 项` : n.book ? `${n.children.length} 张表 · ${timeLabel(n.modifiedMs)}` : timeLabel(n.modifiedMs) }}</div>
          </span>
          <span class="end">
            <Icon v-if="isFolder(n)" name="chev" :size="18" />
            <span v-else-if="favSet.has(n.path)" class="star"><Icon name="star" :size="14" /></span>
          </span>
        </button>
        <div v-if="!items.length" class="m-empty">{{ path ? "这个文件夹是空的" : "云端目录里还没有笔记" }}</div>
      </template>
      </template>
    </div>
    <div v-if="menu" class="m-ovl">
      <div class="mask" @click="menu = null"></div>
      <div class="sheet">
        <div class="grab"></div>
        <div class="row" style="border: 0">
          <span class="ic"><Icon :name="isFolder(menu) ? 'folder' : iconOf(menu)" :size="20" /></span>
          <span class="main">
            <div class="name">{{ menu.name }}</div>
            <div class="sub">{{ kindLabel(menu) }} · {{ folderLabel(menu.path) }}</div>
          </span>
        </div>
        <button class="row" style="color: var(--danger)" @click="removeNode(menu)">
          <span class="main"><div class="name">删除</div><div class="sub">可以选择是否同时删除云端文件</div></span>
        </button>
        <button class="row" style="justify-content: center; color: var(--muted)" @click="menu = null">取消</button>
      </div>
    </div>
  </div>
</template>
