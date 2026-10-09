<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { open as pickFiles } from "@tauri-apps/plugin-dialog";
import Icon from "../Icon.vue";
import { sizeLabel } from "../browse";
import { mobileApi, type ShelfBook, type UploadOutcome } from "../api";
import { bookStem, progressLabel, useShelf, type ShelfSort } from "../shelf";
import { coverColor } from "../reader/cover";
import { go, toast } from "../nav";

const shelf = useShelf();
const menu = ref<ShelfBook | null>(null);
const conflict = ref<UploadOutcome | null>(null);
const confirmDelete = ref<ShelfBook | null>(null);
const sorting = ref(false);
const busy = ref(false);

const SORTS: [ShelfSort, string][] = [
  ["recent", "最近阅读"],
  ["added", "导入时间"],
  ["name", "书名"],
];

onMounted(() => {
  shelf
    .refreshLocal()
    .then(() => shelf.ensureCovers())
    .catch((e) => toast(e instanceof Error ? e.message : String(e)));
  if (shelf.vaultId) shelf.refreshCloud().catch(() => {});
  document.addEventListener("visibilitychange", onVisible);
});

onBeforeUnmount(() => document.removeEventListener("visibilitychange", onVisible));

/** 从系统文件选择器等别的界面回来时重新读一遍书架 */
function onVisible() {
  if (document.visibilityState !== "visible") return;
  shelf.refreshLocal().catch((e) => toast(e instanceof Error ? e.message : String(e)));
}

/** 没有封面图时用按书名算出的颜色 */
function coverStyle(name: string, id?: string) {
  if (id && shelf.covers[id]) return {};
  const c = coverColor(bookStem(name));
  // 旧版 WebView 不认 color-mix 时渐变整条失效，底色还在，书名不会落到看不清的背景上
  return { backgroundColor: c.bg, backgroundImage: `linear-gradient(160deg, ${c.bg}, color-mix(in srgb, ${c.bg} 72%, #000))`, color: c.fg };
}

function cloudNames(): Set<string> {
  return new Set(shelf.cloud.map((b) => b.name));
}

function uploaded(book: ShelfBook): boolean {
  return cloudNames().has(book.name);
}

async function importBooks() {
  const picked = await pickFiles({ multiple: true, filters: [{ name: "电子书", extensions: ["epub", "txt", "mobi", "azw3", "pdf"] }] });
  const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
  if (!paths.length) return;
  busy.value = true;
  try {
    const added = await mobileApi.shelfImport(paths);
    shelf.addLocal(added);
    await shelf.refreshLocal();
    void shelf.ensureCovers().catch(() => {});
    toast(added.length === 1 ? `已导入《${bookStem(added[0].name)}》` : `已导入 ${added.length} 本`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

function openCloud() {
  if (!shelf.vaultId) {
    toast("先选择读书笔记库");
    return;
  }
  go({ p: "cloud" });
}

function openBook(book: ShelfBook) {
  go({ p: "ebook", id: book.id });
}

async function upload(book: ShelfBook, mode: "check" | "overwrite" | "rename") {
  if (!shelf.vaultId) {
    toast("先选择读书笔记库");
    return;
  }
  busy.value = true;
  try {
    const outcome = await mobileApi.shelfUpload(shelf.vaultId, shelf.remoteDir, book.id, mode);
    if (!outcome.done) {
      conflict.value = outcome;
      menu.value = book;
      return;
    }
    conflict.value = null;
    menu.value = null;
    toast("已上传到云端");
    await shelf.refreshCloud().catch(() => {});
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

async function removeLocal(book: ShelfBook) {
  try {
    await mobileApi.shelfRemove(book.id);
    confirmDelete.value = null;
    menu.value = null;
    await shelf.refreshLocal();
    toast("已从书架移除");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

async function deleteCloud(book: ShelfBook) {
  const remote = shelf.cloud.find((b) => b.name === book.name);
  if (!shelf.vaultId || !remote) return;
  try {
    await mobileApi.shelfDeleteCloud(shelf.vaultId, shelf.remoteDir, remote.rel);
    menu.value = null;
    await shelf.refreshLocal();
    toast("已从云端删除");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

let hold = 0;
let held = false;
function holdStart(book: ShelfBook) {
  held = false;
  hold = window.setTimeout(() => {
    held = true;
    menu.value = book;
  }, 500);
}
function holdEnd() {
  clearTimeout(hold);
}
function tap(book: ShelfBook) {
  if (held) {
    held = false;
    return;
  }
  openBook(book);
}
</script>

<template>
  <div class="page">
    <div class="top">
      <h1>书架</h1>
      <button class="btn sm" :style="shelf.vaultId ? '' : 'opacity:.4'" @click="openCloud"><Icon name="cloud" :size="16" />云端</button>
      <button class="ib" title="排序" @click="sorting = true"><Icon name="sort" /></button>
      <button class="ib" title="导入" :disabled="busy" @click="importBooks"><Icon name="plus" /></button>
    </div>
    <div class="scroll">
      <div v-if="!shelf.shown.length && !Object.keys(shelf.downloads).length" class="m-empty">
        <Icon name="book" :size="44" />
        <p>书架是空的</p>
        <p class="sub">点右上角“＋”导入电子书，或从云端下载</p>
      </div>
      <div v-else class="shelf-grid">
        <div v-for="(d, rel) in shelf.downloads" :key="'dl-' + rel" class="shelf-book downloading">
          <span class="cover" :style="coverStyle(d.name)"><span class="ct">{{ bookStem(d.name) }}</span><span class="pb dl"><i :style="{ width: d.percent + '%' }"></i></span></span>
          <span class="t">{{ bookStem(d.name) }}</span>
          <span class="p">下载中 {{ d.percent }}%</span>
        </div>
        <button
          v-for="b in shelf.shown"
          :key="b.id"
          class="shelf-book"
          @click="tap(b)"
          @pointerdown="holdStart(b)"
          @pointerup="holdEnd"
          @pointerleave="holdEnd"
          @contextmenu.prevent="menu = b"
        >
          <span class="cover" :class="{ img: shelf.covers[b.id] }" :style="coverStyle(b.name, b.id)"><img v-if="shelf.covers[b.id]" :src="shelf.covers[b.id]" alt="" @error="shelf.covers[b.id] = ''" /><span v-else class="ct">{{ bookStem(b.name) }}</span><i v-if="b.origin === 'import' && !uploaded(b)" class="tag">本地</i><span v-if="(shelf.progress[b.id] ?? 0) > 0" class="pb"><i :style="{ width: Math.round((shelf.progress[b.id] ?? 0) * 100) + '%' }"></i></span></span>
          <span class="t">{{ bookStem(b.name) }}</span>
          <span class="p">{{ progressLabel(shelf.progress[b.id]) }}<template v-if="b.name.toLowerCase().endsWith('.txt')"> · TXT</template></span>
        </button>
      </div>
    </div>

    <div v-if="sorting" class="m-ovl">
      <div class="mask" @click="sorting = false"></div>
      <div class="sheet">
        <div class="grab"></div>
        <h2>排序</h2>
        <button v-for="[key, label] in SORTS" :key="key" class="row" @click="shelf.sort = key; sorting = false">
          <span class="main"><div class="name">{{ label }}</div></span>
          <Icon v-if="shelf.sort === key" name="check" :size="18" />
        </button>
      </div>
    </div>

    <div v-if="menu && !conflict && !confirmDelete" class="m-ovl">
      <div class="mask" @click="menu = null"></div>
      <div class="sheet">
        <div class="grab"></div>
        <div class="row" style="border: 0">
          <span class="main">
            <div class="name">{{ bookStem(menu.name) }}</div>
            <div class="sub">{{ menu.name.split('.').pop()?.toUpperCase() }} · {{ sizeLabel(menu.size) }}{{ uploaded(menu) ? " · 已上传" : " · 仅本地" }}</div>
          </span>
        </div>
        <button v-if="!uploaded(menu)" class="row" :disabled="busy" @click="upload(menu, 'check')"><span class="main"><div class="name">上传到云端</div></span></button>
        <button v-else class="row" @click="removeLocal(menu)"><span class="main"><div class="name">移除下载</div><div class="sub">从书架拿掉，云端还在</div></span></button>
        <button v-if="uploaded(menu)" class="row" style="color: var(--danger)" @click="deleteCloud(menu)"><span class="main"><div class="name">从云端删除</div></span></button>
        <button v-else class="row" style="color: var(--danger)" @click="confirmDelete = menu"><span class="main"><div class="name">删除</div></span></button>
        <button class="row" style="justify-content: center; color: var(--muted)" @click="menu = null">取消</button>
      </div>
    </div>

    <div v-if="confirmDelete" class="m-ovl">
      <div class="mask" @click="confirmDelete = null"></div>
      <div class="dialog">
        <h2>删除《{{ bookStem(confirmDelete.name) }}》？</h2>
        <p>这本书还没有上传，删除后手机里就没有了。</p>
        <div class="acts">
          <button class="btn text" @click="confirmDelete = null">取消</button>
          <button class="btn danger" @click="removeLocal(confirmDelete)">删除</button>
        </div>
      </div>
    </div>

    <div v-if="conflict && menu" class="m-ovl">
      <div class="mask" @click="conflict = null"></div>
      <div class="dialog">
        <h2>云端已有《{{ conflict.name }}》</h2>
        <p>云端书架里已经有同名文件（{{ sizeLabel(conflict.size) }}{{ conflict.modified ? `，${conflict.modified}` : "" }}）。</p>
        <div class="acts">
          <button class="btn text" @click="conflict = null">取消</button>
          <button class="btn" @click="upload(menu, 'rename')">另存</button>
          <button class="btn pri" @click="upload(menu, 'overwrite')">覆盖</button>
        </div>
      </div>
    </div>
  </div>
</template>
