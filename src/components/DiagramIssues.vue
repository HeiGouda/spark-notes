<script setup lang="ts">
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { DiagramIssue } from "../diagram/issues";
import { DOC_LABEL, type DocKind } from "../lib/doctype";
import { api } from "../lib/api";
import { fileManagerName, isMac } from "../lib/platform";
import { useVaultStore } from "../stores/vault";
import { useNoticeStore } from "../stores/notice";

/** 图含有不支持的语法或写坏时的提示页：只列原因，不显示文件内容（需求文档 5.18） */
const props = defineProps<{ kind: DocKind; path: string; issues: DiagramIssue[] }>();
const vault = useVaultStore();

const MAX_SHOWN = 8;

async function openExternal() {
  if (!vault.root) return;
  try {
    await api.openExternal(vault.root, props.path);
  } catch (e) {
    useNoticeStore().report("用系统默认程序打开失败", e);
  }
}

async function reveal() {
  try {
    await revealItemInDir(vault.absolutePath(props.path));
  } catch (e) {
    useNoticeStore().report(`在${fileManagerName}中显示失败`, e);
  }
}
</script>

<template>
  <div class="diagram-issues">
    <div class="diagram-issues-box">
      <h3>无法显示这张{{ DOC_LABEL[kind] }}</h3>
      <ul>
        <li v-for="(it, i) in issues.slice(0, MAX_SHOWN)" :key="i">第 {{ it.line }} 行{{ it.message }}</li>
        <li v-if="issues.length > MAX_SHOWN" class="more">另有 {{ issues.length - MAX_SHOWN }} 处</li>
      </ul>
      <p>文件可能是在其他软件里编辑的。为了不改坏它，Spark 不会显示或修改其中的内容。</p>
      <div class="diagram-issues-actions">
        <button class="btn-primary" type="button" @click="openExternal">用系统默认程序打开</button>
        <button class="plain-btn" type="button" @click="reveal">{{ isMac ? "在访达中显示" : "在文件夹中显示" }}</button>
      </div>
    </div>
  </div>
</template>
