<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import Icon from "../Icon.vue";
import { back } from "../nav";

const version = ref("");

onMounted(async () => {
  version.value = await getVersion().catch(() => "");
});
</script>

<template>
  <div class="page bare">
    <div class="top">
      <button class="ib" @click="back()"><Icon name="back" /></button>
      <h1>关于与同步规则</h1>
    </div>
    <div class="scroll gray">
      <div class="grp" style="margin-top: 12px">
        <div class="row">
          <span class="ic"><Icon name="info" :size="20" /></span>
          <span class="main">
            <div class="name">Spark {{ version }}</div>
            <div class="sub">MIT 许可证</div>
          </span>
        </div>
      </div>
      <div class="grp-t">同步规则</div>
      <div class="grp">
        <div class="row tall">
          <span class="main">
            <div class="snip" style="-webkit-line-clamp: unset">
              普通笔记、导图和流程图只从云端下载，不修改。书架里的书、读书笔记、书签和阅读进度会上传到云端。打开 App 时自动检查笔记更新；一次要删除超过 20 个文件或全库 10% 时先询问。
            </div>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
