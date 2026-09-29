<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { useFlowGenStore } from "../stores/flowGen";
import type { GenDir } from "../diagram/flowGen";

/** AI 生成流程图的输入框：描述 + 方向（需求文档 5.18） */
const flowGen = useFlowGenStore();
const desc = ref("");
const dir = ref<GenDir>("auto");
const box = ref<HTMLTextAreaElement | null>(null);

const DIRS: { id: GenDir; label: string }[] = [
  { id: "auto", label: "自动" },
  { id: "TD", label: "上到下" },
  { id: "LR", label: "左到右" },
];

watch(
  () => flowGen.dialog,
  (d) => {
    if (!d) return;
    desc.value = d.desc;
    dir.value = d.dir;
    void nextTick(() => box.value?.focus());
  },
);

const chars = computed(() => desc.value.trim().length);
const tooLong = computed(() => (chars.value ? flowGen.checkDesc(desc.value, dir.value) : null));
const canSubmit = computed(() => chars.value > 0 && !tooLong.value);

function close() {
  flowGen.dialog = null;
}

function submit() {
  if (canSubmit.value) flowGen.submit(desc.value, dir.value);
}

function onKey(e: KeyboardEvent) {
  if (!flowGen.dialog) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    submit();
  }
}

onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div v-if="flowGen.dialog" class="mask" @mousedown.self="close()">
    <div class="pop ai-dlg flowgen-dlg" role="dialog" aria-label="AI 生成流程图">
      <div class="keys-head">
        <h3>{{ flowGen.dialog.target.kind === "regen" ? "重新生成流程图" : "AI 生成流程图" }}</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="close()"><Icon name="close" sm /></button>
      </div>
      <div class="ai-dlg-body">
        <textarea
          ref="box"
          v-model="desc"
          class="flowgen-desc"
          spellcheck="false"
          placeholder="写下流程的步骤、判断条件和分支，例如：员工提交请假申请，组长审批；超过 3 天还要经理审批；驳回后修改再提交。"
        />
        <div class="flowgen-row">
          <span>方向</span>
          <div class="dp-seg flowgen-dir">
            <button v-for="d in DIRS" :key="d.id" type="button" :class="{ on: dir === d.id }" @click="dir = d.id">{{ d.label }}</button>
          </div>
        </div>
      </div>
      <div class="ai-dlg-actions">
        <span v-if="tooLong" class="git-error flowgen-note">{{ tooLong }}</span>
        <span v-else class="hint">{{ chars ? `将发送这段描述，约 ${chars.toLocaleString("zh-CN")} 字` : "Ctrl+Enter 生成" }}</span>
        <span class="flex" />
        <button class="fb-txt" type="button" @click="close()">取消</button>
        <button class="btn-primary" type="button" :disabled="!canSubmit" @click="submit()">生成</button>
      </div>
    </div>
  </div>
</template>
