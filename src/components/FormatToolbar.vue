<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { FORMAT_ACTIONS, commandIdOf } from "../editor/formatActions";
import { runCommand, shortcutOf, tipFor } from "../lib/commands";
import { displayShortcut } from "../lib/shortcut";
import { useEditorStore, type ActiveMarks } from "../stores/editor";
import { useSettingsStore } from "../stores/settings";
import { useNoticeStore } from "../stores/notice";

const editorStore = useEditorStore();
const settings = useSettingsStore();
const headingOpen = ref(false);
const headingHost = ref<HTMLElement | null>(null);
const headingMenuEl = ref<HTMLElement | null>(null);
const headingMenuStyle = ref<Record<string, string>>({});
const LEVELS = ["正文", "H1", "H2", "H3", "H4", "H5", "H6"];
/** 下拉框在 v-for 内，用函数形式的 ref 取单个元素 */
function setHeadingHost(el: unknown) {
  headingHost.value = el instanceof HTMLElement ? el : null;
}

interface ButtonDef {
  id: string;
  icon?: string;
  glyph?: { cls: string; text: string };
  wide?: boolean;
  mark?: keyof ActiveMarks;
}

/** 按钮分组与顺序对应需求文档 4.3；"heading" 为段落级别下拉框 */
const GROUPS: ButtonDef[][] = [
  [{ id: "undo", icon: "undo" }, { id: "redo", icon: "redo" }],
  [{ id: "heading" }],
  [
    { id: "strong", glyph: { cls: "g", text: "B" }, mark: "strong" },
    { id: "emphasis", glyph: { cls: "g-i", text: "I" }, mark: "emphasis" },
    { id: "strike", glyph: { cls: "g g-s", text: "S" }, mark: "strike" },
    { id: "highlight", glyph: { cls: "g g-h", text: "H" }, mark: "highlight" },
    { id: "inlineCode", icon: "code", mark: "code" },
    { id: "clear", icon: "clear" },
  ],
  [{ id: "bulletList", icon: "ul" }, { id: "orderedList", icon: "ol" }, { id: "taskList", icon: "task" }, { id: "indent", icon: "indent" }, { id: "outdent", icon: "outdent" }],
  [{ id: "quote", icon: "quote" }, { id: "codeBlock", icon: "codeblock" }, { id: "hr", icon: "hr" }],
  [
    { id: "link", icon: "link", mark: "link" },
    { id: "wikilink", glyph: { cls: "g-sm", text: "[[ ]]" }, wide: true },
    { id: "image", icon: "image" },
    { id: "table", icon: "table" },
    { id: "footnote", glyph: { cls: "g-sm", text: "x¹" } },
  ],
];
const RIGHT_GROUPS: ButtonDef[][] = [
  [{ id: "tidy", icon: "tidy" }, { id: "aiMenu" }],
  [{ id: "find", icon: "search" }, { id: "replace", icon: "replace" }],
];

const hidden = computed(() => new Set(settings.toolbarHidden));
const visibleGroups = computed(() =>
  GROUPS.map((g) => g.filter((b) => !hidden.value.has(b.id))).filter((g) => g.length),
);
const visibleRight = computed(() =>
  RIGHT_GROUPS.map((g) => g.filter((b) => !hidden.value.has(b.id))).filter((g) => g.length),
);

function titleOf(id: string): string {
  if (id === "heading") return "段落级别";
  if (id === "aiMenu") return "AI";
  return FORMAT_ACTIONS[id].title;
}

/* ---------- AI 下拉：总结当前笔记、AI 整理结构（需求文档 5.16） ---------- */
const aiOpen = ref(false);
const aiHost = ref<HTMLElement | null>(null);
function setAiHost(el: unknown) {
  aiHost.value = el instanceof HTMLElement ? el : null;
}
const AI_ITEMS = [
  { id: "ai.summary", icon: "summary", label: "总结当前笔记" },
  { id: "ai.structure", icon: "structure", label: "AI 整理结构" },
];
/** 工具栏会裁掉超出的内容，菜单按按钮位置固定定位 */
const aiMenuStyle = ref<Record<string, string>>({});
function toggleAi(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  aiMenuStyle.value = { position: "fixed", top: `${r.bottom + 6}px`, right: `${Math.max(window.innerWidth - r.right, 4)}px` };
  aiOpen.value = !aiOpen.value;
}
function runAi(id: string) {
  aiOpen.value = false;
  runCommand(id).catch((err) => useNoticeStore().report("执行 AI 功能失败", err));
}

function tip(id: string) {
  return tipFor(titleOf(id), commandIdOf(id));
}

function exec(id: string) {
  runCommand(commandIdOf(id)).catch((err) => useNoticeStore().report(`执行“${titleOf(id)}”失败`, err));
}

function pickLevel(level: number) {
  headingOpen.value = false;
  runCommand(`format.h${level}`).catch((err) => useNoticeStore().report("设置段落级别失败", err));
}

function levelHint(level: number) {
  return displayShortcut(shortcutOf(`format.h${level}`));
}

/* ---------- 右键：选择显示哪些按钮 ---------- */
const menuAt = ref<{ x: number; y: number } | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const ALL = [...GROUPS.flat(), ...RIGHT_GROUPS.flat()].map((b) => b.id);

function onMenu(e: MouseEvent) {
  e.preventDefault();
  menuAt.value = { x: Math.min(e.clientX, window.innerWidth - 310), y: e.clientY + 4 };
}

function toggleHeading(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  headingMenuStyle.value = {
    position: "fixed",
    top: `${r.bottom + 4}px`,
    left: `${Math.min(r.left, window.innerWidth - 200)}px`,
    zIndex: "80",
    minWidth: "168px",
  };
  headingOpen.value = !headingOpen.value;
}

function onDocDown(e: MouseEvent) {
  const t = e.target as Node;
  const inHeading = !!headingHost.value?.contains(t) || !!headingMenuEl.value?.contains(t);
  if (headingOpen.value && !inHeading) headingOpen.value = false;
  if (aiOpen.value && aiHost.value && !aiHost.value.contains(t)) aiOpen.value = false;
  if (menuAt.value && menuEl.value && !menuEl.value.contains(t)) menuAt.value = null;
}
function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  menuAt.value = null;
  aiOpen.value = false;
  headingOpen.value = false;
}
onMounted(() => {
  document.addEventListener("mousedown", onDocDown, true);
  document.addEventListener("keydown", onKey, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocDown, true);
  document.removeEventListener("keydown", onKey, true);
});
</script>

<template>
  <!-- mousedown.prevent：点击工具按钮时不让编辑器失去焦点和选区 -->
  <div class="toolbar" role="toolbar" aria-label="格式" @mousedown.prevent @contextmenu="onMenu">
    <template v-for="(group, gi) in visibleGroups" :key="gi">
      <span v-if="gi > 0" class="sep" />
      <template v-for="b in group" :key="b.id">
        <div v-if="b.id === 'heading'" :ref="setHeadingHost" class="hsel-wrap">
          <button class="hsel" :class="{ 'is-active': headingOpen }" :title="`段落级别 (${levelHint(0)} ~ ${levelHint(6)})`" :disabled="!editorStore.editor" @click="toggleHeading">
            {{ editorStore.block }}<Icon name="down" sm />
          </button>
        </div>
        <button
          v-else
          class="btn"
          :class="{ 'btn-wide': b.wide, 'is-active': b.mark && editorStore.marks[b.mark] }"
          :title="tip(b.id)"
          :disabled="!editorStore.editor"
          @click="exec(b.id)"
        >
          <Icon v-if="b.icon" :name="b.icon" />
          <span v-else-if="b.glyph" :class="b.glyph.cls">{{ b.glyph.text }}</span>
        </button>
      </template>
    </template>
    <span class="tb-spacer" />
    <template v-for="(group, gi) in visibleRight" :key="`r${gi}`">
      <span v-if="gi > 0" class="sep" />
      <template v-for="b in group" :key="b.id">
        <div v-if="b.id === 'aiMenu'" :ref="setAiHost" class="ai-menu-wrap">
          <button class="btn btn-ai" :class="{ 'is-active': aiOpen }" title="AI" :disabled="!editorStore.editor" @click="toggleAi">
            <span class="ai-t">AI</span><Icon name="down" sm />
          </button>
          <div v-if="aiOpen" class="menu ai-menu" :style="aiMenuStyle" role="menu">
            <button v-for="item in AI_ITEMS" :key="item.id" class="menu-item" role="menuitem" :title="tipFor(item.label, item.id)" @click="runAi(item.id)">
              <span class="mark"><Icon :name="item.icon" sm /></span>
              <span class="label">{{ item.label }}</span>
              <span class="hint">{{ displayShortcut(shortcutOf(item.id)) }}</span>
            </button>
          </div>
        </div>
        <button v-else class="btn" :title="tip(b.id)" :disabled="!editorStore.editor" @click="exec(b.id)">
          <Icon :name="b.icon!" />
        </button>
      </template>
    </template>
  </div>
  <!-- 工具栏 overflow:hidden 会裁掉绝对定位的菜单，所以挂到 body 上用固定定位 -->
  <Teleport to="body">
    <div v-if="headingOpen" ref="headingMenuEl" class="menu hsel-menu" :style="headingMenuStyle" role="menu" @mousedown.prevent>
      <button v-for="(label, level) in LEVELS" :key="label" class="menu-item" role="menuitem" @click="pickLevel(level)">
        <span class="mark"><Icon v-if="editorStore.block === label" name="check" sm /></span>
        <span class="label">{{ label }}</span>
        <span class="hint">{{ levelHint(level) }}</span>
      </button>
    </div>
  </Teleport>
  <div v-if="menuAt" ref="menuEl" class="menu tbmenu" :style="{ left: `${menuAt.x}px`, top: `${menuAt.y}px` }" role="menu" @contextmenu.prevent>
    <div class="menu-title">显示的工具栏按钮（点击切换）</div>
    <div class="tb-grid">
      <button v-for="id in ALL" :key="id" class="menu-item" role="menuitemcheckbox" :aria-checked="!hidden.has(id)" @mousedown.prevent @click="settings.toggleToolbarButton(id)">
        <span class="mark"><Icon v-if="!hidden.has(id)" name="check" sm /></span>
        <span class="label">{{ titleOf(id) }}</span>
      </button>
    </div>
    <div class="menu-sep" />
    <button class="menu-item" @mousedown.prevent @click="settings.resetToolbarButtons()"><span class="mark" /><span class="label">恢复默认</span></button>
  </div>
</template>
