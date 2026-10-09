<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import Icon from "../Icon.vue";
import { timeLabel } from "../browse";
import { useMobile } from "../store";
import { useMobileAi } from "../ai";
import { useShelf } from "../shelf";
import { go } from "../nav";

const store = useMobile();
const ai = useMobileAi();
const shelf = useShelf();
const shelfLabel = computed(() => store.vaults.find((v) => v.id === shelf.vaultId)?.name ?? "未设置");
const version = ref("");

onMounted(async () => {
  version.value = await getVersion().catch(() => "");
});

function status(id: string) {
  const m = store.meta[id];
  return m?.lastSyncMs ? `上次同步 ${timeLabel(m.lastSyncMs)} · ${m.files} 篇笔记` : "尚未下载";
}
</script>

<template>
  <div class="page">
    <div class="top pad"><h1>我的</h1></div>
    <div class="scroll gray">
      <div class="hero">
        <span class="logo">S</span>
        <div>
          <div class="name">Spark<span v-if="version">{{ version }}</span></div>
          <div class="sub">
            <template v-if="store.current">当前笔记库 {{ store.current.name }}</template>
            <template v-else>还没有笔记库</template>
          </div>
        </div>
      </div>

      <div class="grp-t">笔记库</div>
      <div class="grp">
        <button v-for="v in store.vaults" :key="v.id" class="row" @click="go({ p: 'form', id: v.id })">
          <span class="ic"><Icon name="cloud" :size="20" /></span>
          <span class="main">
            <div class="name">{{ v.name }}<span v-if="v.id === store.currentId" class="badge">当前</span></div>
            <div class="sub">{{ v.remoteDir }} · {{ status(v.id) }}</div>
          </span>
          <span class="v"><Icon name="chev" :size="16" /></span>
        </button>
        <button class="row link" @click="go({ p: 'form', id: null })">
          <span class="ic"><Icon name="plus" :size="20" /></span>
          <span class="main"><div class="name">添加笔记库</div></span>
        </button>
      </div>

      <div class="grp-t">阅读与助手</div>
      <div class="grp">
        <button class="row" @click="go({ p: 'shelf-settings' })">
          <span class="ic"><Icon name="book" :size="20" /></span>
          <span class="main"><div class="name">书架</div></span>
          <span class="v">{{ shelfLabel }} <Icon name="chev" :size="16" /></span>
        </button>
        <button class="row" @click="go({ p: 'ai-models' })">
          <span class="ic"><Icon name="spark" :size="20" /></span>
          <span class="main"><div class="name">AI 模型</div></span>
          <span class="v">{{ ai.models.length ? `${ai.models.length} 个` : "未设置" }} <Icon name="chev" :size="16" /></span>
        </button>
        <button class="row" @click="go({ p: 'reader-settings' })">
          <span class="ic"><Icon name="aa" :size="20" /></span>
          <span class="main"><div class="name">阅读设置</div></span>
          <span class="v"><Icon name="chev" :size="16" /></span>
        </button>
      </div>

      <div class="grp" style="margin-top: 14px; margin-bottom: 24px">
        <button class="row" @click="go({ p: 'about' })">
          <span class="ic"><Icon name="info" :size="20" /></span>
          <span class="main"><div class="name">关于与同步规则</div></span>
          <span class="v"><Icon name="chev" :size="16" /></span>
        </button>
      </div>
    </div>
  </div>
</template>
