<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import Icon from "../Icon.vue";
import { timeLabel } from "../browse";
import { useMobile } from "../store";
import { go, open } from "../nav";

const store = useMobile();
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
    <div class="scroll">
      <div class="sec">笔记库</div>
      <div v-for="v in store.vaults" :key="v.id" class="row tall">
        <span class="ic"><Icon name="cloud" :size="20" /></span>
        <span class="main">
          <div class="name">{{ v.name }}<span v-if="v.id === store.currentId" class="badge">当前</span></div>
          <div class="sub">{{ v.url.replace(/^https?:\/\//, "") }} · {{ v.remoteDir }}</div>
          <div class="sub">{{ status(v.id) }}</div>
          <div style="display: flex; gap: 8px; margin-top: 8px">
            <button class="btn sm" @click="go({ p: 'form', id: v.id })">编辑</button>
            <button class="btn sm danger" @click="open({ t: 'del', id: v.id })">删除</button>
          </div>
        </span>
      </div>
      <button class="row" @click="go({ p: 'form', id: null })">
        <span class="ic"><Icon name="plus" :size="20" /></span>
        <span class="main"><div class="name">添加笔记库</div></span>
      </button>
      <div class="sec">关于</div>
      <div class="row">
        <span class="ic"><Icon name="info" :size="20" /></span>
        <span class="main">
          <div class="name">Spark {{ version }}（安卓只读版）</div>
          <div class="sub">MIT 许可证</div>
        </span>
      </div>
      <div class="row tall">
        <span class="ic"><Icon name="eye" :size="20" /></span>
        <span class="main">
          <div class="name">同步规则</div>
          <div class="snip" style="-webkit-line-clamp: unset">
            只从云端下载，不上传、不修改云端文件。打开 App 时自动检查更新；一次要删除超过 20 个文件或全库 10% 时先询问。
          </div>
        </span>
      </div>
    </div>
  </div>
</template>
