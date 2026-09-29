<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import Icon from "./Icon.vue";
import { findConflict, isCustomized, listCommands, shortcutOf, shortcutOverrides, getCommand, type AppCommand } from "../lib/commands";
import { displayShortcut, eventToShortcut, normalizeShortcut, shortcutProblem } from "../lib/shortcut";
import { parseKeymap, serializeKeymap } from "../lib/keymapFile";
import { api } from "../lib/api";
import { useUiStore } from "../stores/ui";
import { useSettingsStore } from "../stores/settings";
import { useNoticeStore } from "../stores/notice";

/** 快捷键设置（原型 M4 浮层 7）：搜索、点击录入、冲突覆盖、恢复默认、导入导出 */
const props = defineProps<{ embedded?: boolean }>();
const ui = useUiStore();
const settings = useSettingsStore();
const notice = useNoticeStore();
const filter = ref("");
const recordingId = ref<string | null>(null);
/** 等待确认覆盖：把 spec 分配给 id，同时清空 conflictId 的快捷键 */
const pending = ref<{ id: string; spec: string; conflictId: string } | null>(null);
const error = ref<{ id: string; text: string } | null>(null);
const info = ref("");

const CATEGORY_ORDER = ["文件", "编辑", "格式", "插入", "视图", "标签页", "导航", "搜索", "版本控制", "通用", "帮助"];

const groups = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const cmds = listCommands().filter((c) => !c.hidden);
  const hit = (c: AppCommand) =>
    !q || c.title.toLowerCase().includes(q) || (shortcutOf(c.id) ?? "").toLowerCase().includes(q) || c.category.includes(q);
  return CATEGORY_ORDER.map((cat) => ({ cat, items: cmds.filter((c) => c.category === cat && hit(c)) })).filter((g) => g.items.length);
});

function keysOf(id: string): string[] {
  const s = shortcutOf(id);
  return s ? displayShortcut(s).split("+") : [];
}

function startRecording(id: string) {
  recordingId.value = id;
  pending.value = null;
  error.value = null;
  info.value = "";
  ui.recording = true;
}

function stopRecording() {
  recordingId.value = null;
  ui.recording = false;
}

/** 分配快捷键；与默认值相同时去掉自定义记录 */
function assign(id: string, spec: string | null) {
  const def = getCommand(id)?.defaultShortcut ?? null;
  if ((spec && normalizeShortcut(spec)) === (def && normalizeShortcut(def))) settings.resetShortcut(id);
  else settings.setShortcut(id, spec);
}

/** 尝试分配，冲突时进入待确认状态 */
function tryAssign(id: string, spec: string) {
  const problem = shortcutProblem(spec);
  if (problem) {
    error.value = { id, text: problem };
    return;
  }
  const other = findConflict(spec, id);
  if (other) {
    pending.value = { id, spec, conflictId: other.id };
    return;
  }
  assign(id, spec);
}

function confirmOverride() {
  const p = pending.value;
  if (!p) return;
  settings.setShortcut(p.conflictId, null);
  assign(p.id, p.spec);
  pending.value = null;
}

function resetOne(id: string) {
  const def = getCommand(id)?.defaultShortcut ?? null;
  error.value = null;
  if (def) {
    const other = findConflict(def, id);
    if (other) {
      pending.value = { id, spec: def, conflictId: other.id };
      return;
    }
  }
  settings.resetShortcut(id);
}

async function resetAll() {
  const ok = await ask("把全部快捷键恢复为默认值？自定义的设置将被清除。", {
    title: "快捷键",
    kind: "warning",
    okLabel: "全部恢复默认",
    cancelLabel: "取消",
  });
  if (ok) {
    settings.resetAllShortcuts();
    pending.value = null;
    info.value = "已恢复默认";
  }
}

async function exportKeys() {
  try {
    const path = await save({ title: "导出快捷键", defaultPath: "spark-keybindings.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    await api.writeTextFile(path, serializeKeymap(shortcutOverrides.value));
    info.value = "已导出";
  } catch (e) {
    notice.report("导出快捷键失败", e);
  }
}

async function importKeys() {
  try {
    const path = await open({ title: "导入快捷键", multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    const parsed = parseKeymap(await api.readTextFile(path), new Set(listCommands().map((c) => c.id)));
    settings.replaceShortcuts(parsed.keybindings);
    info.value = parsed.skipped.length ? `已导入，跳过 ${parsed.skipped.length} 项：${parsed.skipped.join("；")}` : "已导入";
  } catch (e) {
    notice.report("导入快捷键失败", e);
  }
}

function close() {
  stopRecording();
  ui.keysOpen = false;
}

/** 录入时在捕获阶段拦截按键（App 的全局快捷键在 ui.recording 时不处理） */
function onKey(e: KeyboardEvent) {
  if (!props.embedded && !ui.keysOpen) return;
  const id = recordingId.value;
  if (!id) {
    if (props.embedded) return;
    if (e.key === "Escape" && !(e.target instanceof HTMLInputElement && filter.value)) {
      e.preventDefault();
      close();
    }
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") return stopRecording();
  if (e.key === "Backspace" || e.key === "Delete") {
    assign(id, null);
    return stopRecording();
  }
  const spec = eventToShortcut(e);
  if (!spec) return;
  stopRecording();
  tryAssign(id, spec);
}

onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey, true);
  ui.recording = false;
});
</script>

<template>
  <div :class="embedded ? 'keys-embed' : 'mask'" @mousedown.self="embedded ? undefined : close()">
    <div class="pop keys" :class="{ 'is-embedded': embedded }" role="dialog" aria-label="快捷键">
      <div class="keys-head">
        <h3>快捷键</h3>
        <input v-model="filter" placeholder="按命令名称或快捷键搜索" spellcheck="false" />
        <button class="fb-txt" @click="importKeys()">导入</button>
        <button class="fb-txt" @click="exportKeys()">导出</button>
        <button class="fb-txt" @click="resetAll()">全部恢复默认</button>
        <button v-if="!embedded" class="btn" title="关闭 (Esc)" @click="close()"><Icon name="close" sm /></button>
      </div>
      <div v-if="info" class="keys-info">{{ info }}</div>
      <div class="keys-body">
        <table>
          <thead>
            <tr><th style="width: 42%">命令</th><th>快捷键</th><th style="width: 16%">作用范围</th><th style="width: 84px"></th></tr>
          </thead>
          <tbody>
            <template v-for="g in groups" :key="g.cat">
              <tr class="grp"><td colspan="4">{{ g.cat }}</td></tr>
              <template v-for="c in g.items" :key="c.id">
                <tr class="key-row" :class="{ rec: recordingId === c.id }" title="点击后按下新的组合键" @click="startRecording(c.id)">
                  <td>{{ c.title }}</td>
                  <td>
                    <span v-if="recordingId === c.id" class="rec-box">请按下组合键…　Esc 取消　Backspace 设为无</span>
                    <template v-else>
                      <span v-if="keysOf(c.id).length" class="kbd"><span v-for="k in keysOf(c.id)" :key="k">{{ k }}</span></span>
                      <span v-else class="scope">无</span>
                      <span v-if="isCustomized(c.id)" class="custom">已自定义</span>
                    </template>
                  </td>
                  <td class="scope">{{ (c.scope ?? "global") === "editor" ? "编辑器" : "全局" }}</td>
                  <td>
                    <button v-if="isCustomized(c.id)" class="reset" :title="`恢复默认（${c.defaultShortcut ?? '无'}）`" @click.stop="resetOne(c.id)">↺ 恢复</button>
                  </td>
                </tr>
                <tr v-if="pending?.id === c.id">
                  <td colspan="4" class="inline-cell">
                    <div class="conflict">
                      <span><b>{{ displayShortcut(pending.spec) }}</b> 已被“{{ getCommand(pending.conflictId)?.title }}”占用，覆盖后“{{ getCommand(pending.conflictId)?.title }}”的快捷键将变为“无”。</span>
                      <span class="flex" />
                      <button class="btn-primary" @click.stop="confirmOverride()">覆盖</button>
                      <button class="fb-txt" @click.stop="pending = null">取消</button>
                    </div>
                  </td>
                </tr>
                <tr v-if="error?.id === c.id">
                  <td colspan="4" class="inline-cell"><div class="conflict">{{ error.text }}<span class="flex" /><button class="fb-txt" @click.stop="error = null">知道了</button></div></td>
                </tr>
              </template>
            </template>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
