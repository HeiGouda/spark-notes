<script setup lang="ts">
import { onMounted, ref } from "vue";
import Icon from "../Icon.vue";
import { sizeLabel, timeLabel } from "../browse";
import { mobileApi, type CloudBook } from "../api";
import { bookStem, METERED_LIMIT, progressLabel, useShelf } from "../shelf";
import { back, go, toast } from "../nav";
import { ask } from "../dialog";

const shelf = useShelf();
const loading = ref(false);
const refreshed = ref(0);
const pending = ref<CloudBook | null>(null);
const menu = ref<CloudBook | null>(null);

async function load() {
  loading.value = true;
  try {
    await shelf.refreshCloud();
    refreshed.value = Date.now();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function download(book: CloudBook) {
  if (shelf.downloads[book.rel]) return;
  if (!book.readable) {
    toast("这种格式还不能打开");
    return;
  }
  if (book.localId) {
    go({ p: "ebook", id: book.localId });
    return;
  }
  if (!shelf.vaultId) return;
  const metered = await mobileApi.networkMetered().catch(() => false);
  if (metered && book.size > METERED_LIMIT) {
    pending.value = book;
    return;
  }
  await runDownload(book);
}

function runDownload(book: CloudBook) {
  pending.value = null;
  // 不等它下完：离开这一页下载也照常进行，进度记在书架里
  void shelf.download(book);
}

async function deleteCloud(book: CloudBook) {
  if (!shelf.vaultId) return;
  const ok = await ask({ title: `从云端删除《${bookStem(book.name)}》？`, message: "书会移进云端书架的回收站，可以在笔记柜里恢复。手机里的副本一并移除，读书笔记和进度保留。", ok: "删除", danger: true });
  if (!ok) return;
  try {
    await mobileApi.shelfDeleteCloud(shelf.vaultId, shelf.remoteDir, book.rel);
    menu.value = null;
    await shelf.refreshLocal();
    await load();
    toast("已从云端删除");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}
</script>

<template>
  <div class="page bare">
    <div class="top">
      <button class="ib" @click="back()"><Icon name="back" /></button>
      <h1>云端书架<small>{{ shelf.remoteDir }} · {{ shelf.cloud.length }} 本</small></h1>
    </div>
    <button class="status" @click="load"><span>{{ loading ? "正在读取云端…" : refreshed ? `已刷新 ${timeLabel(refreshed)} · 点此刷新` : "点此刷新" }}</span></button>
    <div class="scroll">
      <button v-for="b in shelf.cloud" :key="b.rel" class="row" @click="download(b)" @contextmenu.prevent="menu = b">
        <span class="ic"><Icon name="book" :size="20" /></span>
        <span class="main">
          <div class="name">{{ bookStem(b.name) }}</div>
          <div class="sub">{{ b.ext.toUpperCase() }} · {{ sizeLabel(b.size) }}<template v-if="b.localId && shelf.progress[b.localId]"> · {{ progressLabel(shelf.progress[b.localId]) }}</template></div>
          <div v-if="shelf.downloads[b.rel]" class="dl-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="shelf.downloads[b.rel].percent">
            <i :style="{ width: shelf.downloads[b.rel].percent + '%' }"></i>
          </div>
        </span>
        <span class="end">
          <template v-if="b.localId">已在书架</template>
          <template v-else-if="!b.readable">后续支持</template>
          <span v-else-if="shelf.downloads[b.rel]" class="dl-pct">{{ shelf.downloads[b.rel].percent }}%</span>
          <span v-else class="btn sm">下载</span>
        </span>
      </button>
      <div v-if="!loading && !shelf.cloud.length" class="m-empty"><p>云端书架是空的</p></div>
    </div>
    <div v-if="pending" class="m-ovl">
      <div class="mask" @click="pending = null"></div>
      <div class="dialog">
        <h2>下载《{{ bookStem(pending.name) }}》？</h2>
        <p>当前在使用移动数据，这本书 {{ sizeLabel(pending.size) }}。</p>
        <div class="acts">
          <button class="btn text" @click="pending = null">取消</button>
          <button class="btn pri" @click="runDownload(pending)">下载</button>
        </div>
      </div>
    </div>
    <div v-if="menu" class="m-ovl">
      <div class="mask" @click="menu = null"></div>
      <div class="sheet">
        <div class="grab"></div>
        <button v-if="!menu.localId && menu.readable" class="row" @click="download(menu); menu = null"><span class="main"><div class="name">下载</div></span></button>
        <button class="row" style="color: var(--danger)" @click="deleteCloud(menu)"><span class="main"><div class="name">从云端删除</div></span></button>
        <button class="row" style="justify-content: center; color: var(--muted)" @click="menu = null">取消</button>
      </div>
    </div>
  </div>
</template>
