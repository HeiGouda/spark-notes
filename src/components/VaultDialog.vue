<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import Icon from "./Icon.vue";
import { api } from "../lib/api";
import { useNoticeStore } from "../stores/notice";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { useVaultStore } from "../stores/vault";

const ui = useUiStore();
const vault = useVaultStore();
const settings = useSettingsStore();
const name = ref("我的笔记库");

function label(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function close() {
  ui.vaultOpen = false;
}

async function usePath(path: string) {
  close();
  if (path !== vault.root) await vault.openVault(path);
}

async function openOther() {
  await vault.pickAndOpen();
  close();
}

async function create() {
  const parent = await open({ directory: true, title: "选择新建笔记库的位置" });
  if (typeof parent !== "string") return;
  try {
    const path = await api.createVault(parent, name.value.trim() || "我的笔记库");
    close();
    await vault.openVault(path);
  } catch (e) {
    useNoticeStore().report("新建笔记库失败", e);
  }
}

function onKey(e: KeyboardEvent) {
  if (!ui.vaultOpen || e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  close();
}

onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div v-if="ui.vaultOpen" class="mask" @mousedown.self="close()">
    <div class="pop vaults" role="dialog" aria-label="笔记库">
      <div class="keys-head">
        <h3>笔记库</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="close()"><Icon name="close" sm /></button>
      </div>
      <ul v-if="settings.vaultList.length" class="vault-list">
        <li v-for="path in settings.vaultList" :key="path" class="trash-row">
          <div class="trash-main">
            <div class="log-msg">{{ label(path) }}</div>
            <div class="log-meta">{{ path }}</div>
          </div>
          <button v-if="path !== vault.root" class="fb-txt" type="button" @click="usePath(path)">切换</button>
          <span v-else class="log-meta">当前</span>
          <button class="fb-txt" type="button" @click="settings.forgetVault(path)">移除</button>
        </li>
      </ul>
      <p v-else class="hist-empty">还没有记下笔记库。打开或新建一个之后会出现在这里。移除只是从列表拿掉，不会删除文件。</p>
      <div class="hist-foot">
        <input v-model="name" class="vault-name" type="text" aria-label="新笔记库名称" />
        <button class="fb-txt" type="button" @click="create()">新建</button>
        <button class="btn-primary" type="button" @click="openOther()">打开文件夹</button>
      </div>
    </div>
  </div>
</template>
