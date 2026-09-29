<script setup lang="ts">
import { computed, ref } from "vue";
import { useMobile } from "../store";
import { close, reset, toast } from "../nav";

const props = defineProps<{ id: string }>();
const store = useMobile();
const vault = computed(() => store.vaults.find((v) => v.id === props.id));
const files = computed(() => store.meta[props.id]?.files ?? 0);
const busy = ref(false);
const error = ref("");

async function remove() {
  const name = vault.value?.name ?? "";
  busy.value = true;
  try {
    await store.removeVault(props.id);
    reset(store.vaults.length ? { p: "me" } : { p: "welcome" });
    toast(`已删除“${name}”在手机上的副本`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    busy.value = false;
  }
}
</script>

<template>
  <div class="mask" @click="close()"></div>
  <div class="dialog">
    <h2>删除笔记库“{{ vault?.name }}”？</h2>
    <p>
      会清除手机上的 {{ files }} 篇笔记（连同附件）和保存的密码。<b>云端和电脑上的笔记不受影响</b>，之后可以重新添加。
    </p>
    <p v-if="error" style="color: var(--danger); margin-top: 8px">{{ error }}</p>
    <div class="acts">
      <button class="btn text" @click="close()">取消</button>
      <button class="btn danger" :disabled="busy" @click="remove">删除</button>
    </div>
  </div>
</template>
