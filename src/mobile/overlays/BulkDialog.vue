<script setup lang="ts">
import { computed } from "vue";
import { useMobile } from "../store";
import { close } from "../nav";

const store = useMobile();
const count = computed(() => store.sync.removals.length);

function confirm() {
  close();
  void store.confirmHeld();
}
</script>

<template>
  <div class="mask"></div>
  <div class="dialog">
    <h2>云端有 {{ count }} 个文件被删除</h2>
    <p v-if="store.sync.message">{{ store.sync.message }}继续同步会把手机上的这些文件也删掉。</p>
    <p v-else>
      继续同步会把手机上的这些文件也删掉。一次删除的数量较多，可能是服务器或远端目录设置出了问题，请先确认。
    </p>
    <p v-if="!store.sync.message" style="margin-top: 8px; font-size: 12px; color: var(--muted)">其他新增和修改已经同步完成。</p>
    <details>
      <summary>查看要删除的文件</summary>
      <ul>
        <li v-for="f in store.sync.removals" :key="f">{{ f }}</li>
      </ul>
    </details>
    <div class="acts">
      <button class="btn text" @click="close()">暂不删除</button>
      <button class="btn pri" @click="confirm">确认同步</button>
    </div>
  </div>
</template>
