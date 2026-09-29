<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ask } from "@tauri-apps/plugin-dialog";
import Icon from "./Icon.vue";
import { api } from "../lib/api";
import { diffLines, type DiffLine } from "../lib/diff";
import { formatGitWhen } from "../lib/gitTime";
import { useNoticeStore } from "../stores/notice";
import { useTabsStore } from "../stores/tabs";
import { useUiStore } from "../stores/ui";
import { useVaultStore } from "../stores/vault";

const ui = useUiStore();
const vault = useVaultStore();
const tabs = useTabsStore();
const versions = ref<{ id: string; timeMs: number }[]>([]);
const selected = ref("");
const preview = ref("");
const current = ref("");
const compare = ref(false);
const loading = ref(false);

const diff = computed<DiffLine[]>(() => (compare.value ? diffLines(preview.value, current.value) : []));

async function load() {
  const root = vault.root;
  const path = tabs.activePath;
  if (!root || !path) return;
  loading.value = true;
  compare.value = false;
  try {
    versions.value = await api.historyList(root, path);
    selected.value = versions.value[0]?.id ?? "";
    current.value = (await api.readNote(root, path)).content;
    await loadPreview();
  } catch (e) {
    useNoticeStore().report("读取历史版本失败", e);
  } finally {
    loading.value = false;
  }
}

async function loadPreview() {
  const root = vault.root;
  const path = tabs.activePath;
  if (!root || !path || !selected.value) {
    preview.value = "";
    return;
  }
  preview.value = await api.historyRead(root, path, selected.value);
}

watch(() => ui.historyOpen, (open) => { if (open) void load(); });

async function pick(id: string) {
  selected.value = id;
  try {
    await loadPreview();
  } catch (e) {
    useNoticeStore().report("读取历史版本失败", e);
  }
}

function close() {
  ui.historyOpen = false;
}

async function restore() {
  const root = vault.root;
  const path = tabs.activePath;
  if (!root || !path || !selected.value) return;
  const ok = await ask("恢复到这个版本？当前内容会先存成一份历史版本。", {
    title: "恢复历史版本", kind: "warning", okLabel: "恢复", cancelLabel: "取消",
  });
  if (!ok) return;
  try {
    await tabs.save(path);
    await api.historyRestore(root, path, selected.value);
    await tabs.reload(path);
    useNoticeStore().inform("已恢复历史版本");
    close();
  } catch (e) {
    useNoticeStore().report("恢复历史版本失败", e);
  }
}

function onKey(e: KeyboardEvent) {
  if (!ui.historyOpen || e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  close();
}

onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div v-if="ui.historyOpen" class="mask" @mousedown.self="close()">
    <div class="pop history" role="dialog" aria-label="历史版本">
      <div class="keys-head">
        <h3>历史版本<span v-if="tabs.active" class="hist-name"> · {{ tabs.active.name }}</span></h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="close()"><Icon name="close" sm /></button>
      </div>
      <div v-if="loading" class="hist-empty">正在读取…</div>
      <div v-else-if="!versions.length" class="hist-empty">还没有历史版本。保存笔记后，超过 5 分钟的上一份内容会留在这里。</div>
      <div v-else class="hist-body">
        <ul class="hist-list">
          <li v-for="v in versions" :key="v.id">
            <button type="button" class="hist-item" :class="{ on: v.id === selected }" @click="pick(v.id)">{{ formatGitWhen(v.timeMs / 1000) }}</button>
          </li>
        </ul>
        <div class="hist-preview">
          <pre v-if="!compare" class="hist-text">{{ preview }}</pre>
          <div v-else class="hist-text">
            <div v-for="(line, i) in diff" :key="i" class="diff-line" :class="line.kind"><span class="diff-mark">{{ line.kind === "add" ? "+" : line.kind === "del" ? "−" : " " }}</span>{{ line.text }}</div>
          </div>
        </div>
      </div>
      <div v-if="versions.length" class="hist-foot">
        <button class="fb-txt" type="button" @click="compare = !compare">{{ compare ? "查看原文" : "与当前对比" }}</button>
        <button class="btn-primary" type="button" :disabled="!selected" @click="restore()">恢复此版本</button>
      </div>
    </div>
  </div>
</template>
