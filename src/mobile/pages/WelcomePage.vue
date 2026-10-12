<script setup lang="ts">
import Icon from "../Icon.vue";
import { go, reset } from "../nav";
import { useMobile } from "../store";

const store = useMobile();

function later() {
  store.skipWelcome();
  reset({ p: "files", path: "" });
}
</script>

<template>
  <div class="page bare">
    <div class="scroll">
      <div class="center" style="padding-top: 90px">
        <div class="logo">S</div>
        <h2>Spark</h2>
        <p class="lead">从 WebDAV 同步笔记，在手机上随时查看</p>
        <ul class="facts">
          <li><Icon name="cloud" :size="18" /><span>支持坚果云、Nextcloud、群晖 NAS、Alist 以及自建 WebDAV</span></li>
          <li><Icon name="eye" :size="18" /><span>手机端只读，不会修改云端和电脑上的笔记</span></li>
          <li><Icon name="lock" :size="18" /><span>密码只保存在本机，由系统密钥库加密</span></li>
        </ul>
        <button class="btn pri block" @click="go({ p: 'form', id: null })"><Icon name="plus" :size="18" />添加笔记库</button>
        <button class="btn text block" style="margin-top: 8px" @click="later">以后再说</button>
      </div>
    </div>
  </div>
</template>
