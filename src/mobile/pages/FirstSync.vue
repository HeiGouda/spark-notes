<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Icon from "../Icon.vue";
import { mobileApi, type SyncCheck } from "../api";
import { sizeLabel } from "../browse";
import { useMobile } from "../store";
import { open, reset, toast } from "../nav";

const props = defineProps<{ id: string }>();
const store = useMobile();
const vault = computed(() => store.vaults.find((v) => v.id === props.id));
const info = ref<SyncCheck | null>(null);
const metered = ref(false);
const loadError = ref("");
const started = ref(false);

async function load() {
  loadError.value = "";
  try {
    const [check, onCell] = await Promise.all([mobileApi.syncCheck(props.id), mobileApi.networkMetered().catch(() => false)]);
    info.value = check;
    metered.value = onCell;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(async () => {
  if (store.currentId !== props.id) await store.selectVault(props.id);
  await load();
});

async function start() {
  started.value = true;
  await store.runSync();
}

function later() {
  reset({ p: "files", path: "" });
}

const percent = computed(() => (store.sync.total ? Math.round((store.sync.done / store.sync.total) * 100) : 0));

watch(
  () => store.sync.state,
  (state) => {
    if (!started.value) return;
    if (state === "ok") {
      reset({ p: "files", path: "" });
      toast(`下载完成，共 ${store.meta[props.id]?.files ?? 0} 篇笔记`);
    } else if (state === "held") {
      reset({ p: "files", path: "" });
      open({ t: "bulk" });
    }
  },
);
</script>

<template>
  <div class="page bare">
    <div class="top">
      <button class="ib" @click="later"><Icon name="back" /></button>
      <h1>首次同步</h1>
    </div>
    <div class="scroll">
      <div class="center">
        <div class="logo round"><Icon name="cloud" :size="34" /></div>
        <h2>{{ vault?.name }}</h2>
        <p v-if="info" class="lead">
          云端目录里有 <b>{{ info.downloads }}</b> 个文件，约 <b>{{ sizeLabel(info.downloadBytes) }}</b>
        </p>
        <p v-else-if="loadError" class="lead" style="color: var(--danger)">{{ loadError }}</p>
        <p v-else class="lead">正在读取云端目录…</p>
        <div v-if="metered && info" class="warnbox">
          <Icon name="warn" :size="18" />
          <span>当前正在使用移动数据，下载约 {{ sizeLabel(info.downloadBytes) }} 会消耗流量。可以连上 Wi‑Fi 后再开始。</span>
        </div>
        <ul class="facts">
          <li><Icon name="image" :size="18" /><span>图片等附件会一起下载，没有网络时也能完整查看</span></li>
          <li><Icon name="eye" :size="18" /><span>只从云端下载，不会上传或修改云端文件</span></li>
          <li><Icon name="sync" :size="18" /><span>以后每次打开 App 自动检查更新，也可以下拉刷新</span></li>
        </ul>
        <div v-if="!started || store.sync.state === 'fail'" class="stack">
          <p v-if="started" class="prog bad">下载失败：{{ store.sync.message }}</p>
          <button v-if="loadError" class="btn block" @click="load">重试</button>
          <button class="btn pri block" :disabled="!info" @click="start">{{ started ? "重新下载" : "开始下载" }}</button>
          <button class="btn text block" @click="later">以后再说</button>
        </div>
        <div v-else style="align-self: stretch">
          <div class="bar"><i :style="{ width: percent + '%' }"></i></div>
          <div class="prog">
            {{ store.sync.total ? `正在下载 ${store.sync.done}/${store.sync.total}` : "准备中…" }}
            <template v-if="store.sync.rel"> · {{ store.sync.rel }}</template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
