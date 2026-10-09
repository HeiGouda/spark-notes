<script setup lang="ts">
import Icon from "../Icon.vue";
import ReaderSettings from "../ReaderSettings.vue";
import { back } from "../nav";
</script>

<template>
  <div class="page bare">
    <div class="top">
      <button class="ib" @click="back()"><Icon name="back" /></button>
      <h1>阅读设置</h1>
    </div>
    <div class="scroll gray">
      <div class="grp-t">笔记阅读</div>
      <div class="grp"><ReaderSettings /></div>
      <p class="ghint">改这里会影响所有笔记的阅读页，电子书另有自己的阅读设置</p>
    </div>
  </div>
</template>
