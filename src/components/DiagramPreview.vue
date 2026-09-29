<script setup lang="ts">
import { computed } from "vue";
import MindEditor from "./MindEditor.vue";
import FlowEditor from "./FlowEditor.vue";
import { parseMind, type MindDoc } from "../diagram/mindmap";
import { parseFlow, type FlowDoc } from "../diagram/flowchart";
import { DOC_LABEL } from "../lib/doctype";

/** 只读地画出某个版本的图（历史版本预览）；画不出来时列出原因 */
const props = defineProps<{ kind: "mind" | "flow"; text: string; name: string }>();

const result = computed(() => (props.kind === "mind" ? parseMind(props.text, props.name) : parseFlow(props.text)));
</script>

<template>
  <div class="diagram-preview">
    <div v-if="!result.ok" class="diagram-preview-bad">
      这个版本的{{ DOC_LABEL[kind] }}无法显示：
      <span v-for="(it, i) in result.issues.slice(0, 3)" :key="i">第 {{ it.line }} 行{{ it.message }}；</span>
    </div>
    <MindEditor v-else-if="kind === 'mind'" :doc="result.doc as MindDoc" readonly bare :zoom="0.8" :collapsed-paths="[]" />
    <FlowEditor v-else :doc="result.doc as FlowDoc" readonly bare :zoom="0.8" />
  </div>
</template>
