<script setup lang="ts">
import { ICONS, type IconName } from "./icons";

defineProps<{ name: string; size?: number }>();
</script>

<template>
  <svg
    :width="size ?? 22"
    :height="size ?? 22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="ICONS[name as IconName]"
  />
</template>
