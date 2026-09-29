<script setup lang="ts">
defineProps<{ name: string; sm?: boolean }>();
</script>

<template>
  <svg class="ico" :class="{ 'ico-sm': sm }"><use :href="`#i-${name}`" /></svg>
</template>
