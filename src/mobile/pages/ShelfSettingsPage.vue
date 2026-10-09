<script setup lang="ts">
import { ref } from "vue";
import { sizeLabel } from "../browse";
import { mobileApi } from "../api";
import { useMobile } from "../store";
import { useShelf } from "../shelf";
import { back, toast } from "../nav";
import { ask } from "../dialog";

const mobile = useMobile();
const shelf = useShelf();
const dir = ref(shelf.remoteDir);

async function choose(id: string) {
  if (shelf.vaultId && shelf.vaultId !== id) toast("已有的读书笔记留在原来的库里，不会搬过去");
  await shelf.setVault(id);
}

async function saveDir() {
  await shelf.setRemoteDir(dir.value);
  toast("已保存云端书架目录");
}

async function clearDownloads() {
  if (!(await ask({ title: "移除所有下载？", message: "只删手机里从云端下载的副本，云端的书还在。还没上传的书会留在书架上。", ok: "移除", danger: true }))) return;
  try {
    const n = await mobileApi.shelfRemoveDownloads();
    await shelf.refreshLocal();
    toast(n ? `已移除 ${n} 本` : "没有下载的书");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}
</script>

<template>
  <div class="page bare">
    <div class="top">
      <button class="ib" @click="back()"><Icon name="back" /></button>
      <h1>书架</h1>
    </div>
    <div class="scroll gray">
      <div class="grp-t">读书笔记库</div>
      <div class="grp">
        <button v-for="v in mobile.vaults" :key="v.id" class="row" @click="choose(v.id)">
          <span class="main">
            <div class="name">{{ v.name }}</div>
            <div class="sub">{{ v.remoteDir }}</div>
          </span>
          <Icon v-if="v.id === shelf.vaultId" name="check" :size="18" />
        </button>
        <div v-if="!mobile.vaults.length" class="row"><span class="main"><div class="sub">还没有笔记库，先在“我的”里添加</div></span></div>
      </div>
      <p class="ghint">书架用这个库的 WebDAV 账号连接，划线和想法以后写进它的“读书笔记”文件夹。</p>

      <div class="grp-t">云端书架目录</div>
      <div class="grp">
        <div class="fld">
          <div class="box"><input v-model="dir" autocapitalize="off" @change="saveDir" /></div>
        </div>
      </div>
      <p class="ghint">和 spark/ 在同一层。改了之后，云端书架会按新目录重新读取。</p>

      <div class="grp-t">存储空间</div>
      <div class="grp">
        <div class="row">
          <span class="main"><div class="name">书架上的书</div></span>
          <span class="v">{{ shelf.usage.books }} 本 · {{ sizeLabel(shelf.usage.bytes) }}</span>
        </div>
        <button class="row dgr" @click="clearDownloads">移除所有下载</button>
      </div>
      <p class="ghint">只删从云端下载的副本。导入后还没上传的书不受影响。</p>
    </div>
  </div>
</template>
