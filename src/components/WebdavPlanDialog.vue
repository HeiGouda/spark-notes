<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import type { PlanItem, SyncStep } from "../lib/api";
import { firstStep, needsConfirm, useWebdavStore } from "../stores/webdav";

const webdav = useWebdavStore();
const accepted = ref<Set<string>>(new Set());
const forced = ref(false);

const LABELS: Record<"upload" | "download", Record<SyncStep, string>> = {
  upload: {
    add: "新增到云端",
    update: "更新到云端",
    overwrite: "覆盖云端的新版本（云端版本移到云端回收文件夹）",
    remove: "本地已删除，从云端移除（移到云端回收文件夹）",
    keep: "本地已删除，但云端被改过，保留云端版本",
  },
  download: {
    add: "从云端下载",
    update: "用云端版本更新（原内容存为历史版本）",
    overwrite: "覆盖本地的修改（本地版本存为历史版本，附件移入回收站）",
    remove: "云端已删除，本地移入回收站",
    keep: "本地新建、还没上传，保留不动",
  },
};
const ORDER: SyncStep[] = ["overwrite", "remove", "add", "update", "keep"];

const dir = computed(() => webdav.planDirection);
const items = computed<PlanItem[]>(() => {
  const p = webdav.planPreview;
  if (!p) return [];
  return dir.value === "upload" ? p.upload : p.download;
});
const groups = computed(() =>
  ORDER.map((step) => ({ step, label: LABELS[dir.value][step], items: items.value.filter((i) => i.step === step) })).filter((g) => g.items.length),
);
const firstTime = computed(() => webdav.planPreview && firstStep(webdav.planPreview) === "choose");
const guard = computed(() => webdav.planPreview?.guard ?? null);
const canRun = computed(() => !guard.value || forced.value);

watch(() => webdav.planOpen, (open) => {
  if (!open) return;
  accepted.value = new Set(items.value.filter(needsConfirm).map((i) => i.rel));
  forced.value = false;
});

function toggle(rel: string, on: boolean) {
  const next = new Set(accepted.value);
  if (on) next.add(rel);
  else next.delete(rel);
  accepted.value = next;
}

function toggleGroup(list: PlanItem[], on: boolean) {
  const next = new Set(accepted.value);
  for (const i of list) {
    if (on) next.add(i.rel);
    else next.delete(i.rel);
  }
  accepted.value = next;
}

function groupChecked(list: PlanItem[]) {
  return list.every((i) => accepted.value.has(i.rel));
}

function confirm() {
  if (!canRun.value) return;
  void webdav.confirmPlan([...accepted.value], forced.value);
}

function switchToUpload() {
  webdav.cancelPlan();
  void webdav.start("upload");
}

function onKey(e: KeyboardEvent) {
  if (!webdav.planOpen || e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  webdav.cancelPlan();
}

onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div v-if="webdav.planOpen" class="mask" @mousedown.self="webdav.cancelPlan()">
    <div class="pop plan" role="dialog" :aria-label="dir === 'upload' ? '确认上传' : '确认同步'">
      <div class="keys-head">
        <h3>{{ dir === "upload" ? "上传到云端" : "从云端同步" }}</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="webdav.cancelPlan()"><Icon name="close" sm /></button>
      </div>
      <div class="plan-body">
        <div v-if="guard" class="inline-err">
          <div>
            <p>{{ guard }}</p>
            <p>建议先到设置里点“测试连接”核对地址和远程目录。</p>
            <label class="git-check plan-force"><input v-model="forced" type="checkbox" />我确认云端就是这样，继续</label>
          </div>
        </div>
        <p v-else-if="firstTime" class="inline-ok">
          这是第一次同步，本地和云端都有文件。同步以云端为准：两边不同的笔记会换成云端版本，本地版本存为历史版本。如果想以本地为准，请改为上传。
        </p>
        <p class="git-hint">{{ dir === "upload" ? "云端是正本。被覆盖或移除的云端文件都放进云端的 .spark-trash 文件夹，按回收站的保留天数清理。" : "本地被覆盖的笔记可在“历史版本”里找回，被移走的文件在“回收站”里。" }}</p>
        <p v-if="!groups.length" class="git-hint">没有需要处理的文件。</p>
        <section v-for="g in groups" :key="g.step" class="plan-group" :class="{ 'is-risky': g.step === 'overwrite' || g.step === 'remove' }">
          <label v-if="g.step === 'overwrite' || g.step === 'remove'" class="git-check plan-head">
            <input type="checkbox" :checked="groupChecked(g.items)" @change="toggleGroup(g.items, ($event.target as HTMLInputElement).checked)" />
            {{ g.label }}<span class="bl-count">{{ g.items.length }}</span>
          </label>
          <div v-else class="plan-head">{{ g.label }}<span class="bl-count">{{ g.items.length }}</span></div>
          <ul class="plan-list">
            <li v-for="i in g.items" :key="i.rel">
              <label v-if="g.step === 'overwrite' || g.step === 'remove'" class="git-check">
                <input type="checkbox" :checked="accepted.has(i.rel)" @change="toggle(i.rel, ($event.target as HTMLInputElement).checked)" />{{ i.rel }}
              </label>
              <span v-else>{{ i.rel }}</span>
            </li>
          </ul>
        </section>
      </div>
      <div class="git-actions plan-actions">
        <button v-if="firstTime && dir === 'download'" class="fb-txt" type="button" @click="switchToUpload()">改为上传（以本地为准）</button>
        <span class="scm-flex" />
        <button class="fb-txt" type="button" @click="webdav.cancelPlan()">取消</button>
        <button class="btn-primary" :class="{ 'btn-danger': guard }" type="button" :disabled="!canRun" @click="confirm()">
          {{ dir === "upload" ? "确认上传" : "确认同步" }}
        </button>
      </div>
    </div>
  </div>
</template>
