<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { MIND_GEN_LAYOUTS, useMindGenStore, type MindGenLayout } from "../stores/mindGen";

/** AI 生成思维导图的输入框：描述 + 布局（需求文档 5.18） */
const mindGen = useMindGenStore();
const desc = ref("");
const layout = ref<MindGenLayout>("auto");
const box = ref<HTMLTextAreaElement | null>(null);

watch(
  () => mindGen.dialog,
  (d) => {
    if (!d) return;
    desc.value = d.desc;
    layout.value = d.layout;
    void nextTick(() => box.value?.focus());
  },
);

const chars = computed(() => desc.value.trim().length);
const tooLong = computed(() => (chars.value ? mindGen.checkDesc(desc.value) : null));
const canSubmit = computed(() => chars.value > 0 && !tooLong.value);

function close() {
  mindGen.dialog = null;
}

function submit() {
  if (canSubmit.value) mindGen.submit(desc.value, layout.value);
}

function onKey(e: KeyboardEvent) {
  if (!mindGen.dialog) return;
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
  <div v-if="mindGen.dialog" class="mask" @mousedown.self="close()">
    <div class="pop ai-dlg flowgen-dlg" role="dialog" aria-label="AI 生成思维导图">
      <div class="keys-head">
        <h3>{{ mindGen.dialog.target.kind === "regen" ? "重新生成思维导图" : "AI 生成思维导图" }}</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="close()"><Icon name="close" sm /></button>
      </div>
      <div class="ai-dlg-body">
        <textarea
          ref="box"
          v-model="desc"
          class="flowgen-desc"
          spellcheck="false"
          placeholder="写下主题和想展开的要点，例如：整理“马克思主义哲学”第一章，分基本问题、辩证法、认识论三部分，每部分列出核心概念。"
        />
        <div class="flowgen-row">
          <span>布局</span>
          <div class="dp-seg mindgen-layout">
            <button v-for="l in MIND_GEN_LAYOUTS" :key="l.id" type="button" :class="{ on: layout === l.id }" @click="layout = l.id">{{ l.label }}</button>
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
