<script setup lang="ts">
import { THEMES } from "../lib/themes";
import type { FontSize } from "./prefs";
import { useMobile } from "./store";

const store = useMobile();
const SIZES: [FontSize, string][] = [
  ["small", "小"],
  ["medium", "中"],
  ["large", "大"],
  ["xlarge", "特大"],
];
</script>

<template>
  <div class="seglabel">字号</div>
  <div class="seg">
    <button v-for="[id, label] in SIZES" :key="id" :class="{ on: store.reader.size === id }" @click="store.setReader({ size: id })">
      {{ label }}
    </button>
  </div>
  <div class="seglabel">主题</div>
  <div class="seg">
    <button v-for="t in THEMES" :key="t.id" :class="{ on: store.reader.theme === t.id }" @click="store.setReader({ theme: t.id })">
      {{ t.name }}
    </button>
  </div>
</template>
