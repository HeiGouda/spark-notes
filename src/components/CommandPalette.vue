<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { fuzzyMatch, highlightSegments } from "../lib/fuzzy";
import { isEnabled, listCommands, runCommand, shortcutOf, type AppCommand } from "../lib/commands";
import { displayShortcut } from "../lib/shortcut";
import { dirOf } from "../lib/api";
import { useUiStore } from "../stores/ui";
import { useSettingsStore } from "../stores/settings";
import { useVaultStore } from "../stores/vault";
import { useTabsStore, nameOf } from "../stores/tabs";
import { useNoticeStore } from "../stores/notice";

/** 命令面板（Ctrl+Shift+P）与快速打开（Ctrl+P），对应原型 M4 浮层 1、2 */
const ui = useUiStore();
const settings = useSettingsStore();
const vault = useVaultStore();
const tabs = useTabsStore();
const input = ref<HTMLInputElement | null>(null);
const host = ref<HTMLElement | null>(null);
const query = ref("");
const index = ref(0);

interface Row {
  key: string;
  label: { text: string; hit: boolean }[];
  detail: string;
  shortcut: string[];
  group?: string;
  run: () => void;
}

const FILE_LIMIT = 50;

function splitKeys(spec: string | null): string[] {
  return spec ? displayShortcut(spec).split("+").filter(Boolean) : [];
}

function commandRow(c: AppCommand, indices: number[], group?: string): Row {
  return {
    key: c.id,
    label: highlightSegments(c.title, indices),
    detail: c.category,
    shortcut: splitKeys(shortcutOf(c.id)),
    group,
    run: () => {
      settings.pushRecentCommand(c.id);
      runCommand(c.id).catch((e) => useNoticeStore().report(`执行“${c.title}”失败`, e));
    },
  };
}

const commandRows = computed<Row[]>(() => {
  const all = listCommands().filter((c) => !c.hidden && isEnabled(c.id));
  const q = query.value.replace(/^>\s*/, "");
  if (!q.trim()) {
    const recent = settings.recentCommands.map((id) => all.find((c) => c.id === id)).filter((c): c is AppCommand => !!c);
    const rest = all.filter((c) => !recent.includes(c));
    return [
      ...recent.map((c, i) => commandRow(c, [], i === 0 ? "最近使用" : undefined)),
      ...rest.map((c, i) => commandRow(c, [], i === 0 ? "全部命令" : undefined)),
    ];
  }
  return all
    .map((c) => ({ c, m: fuzzyMatch(q, c.title) ?? (fuzzyMatch(q, c.category) ? { score: -100, indices: [] } : null) }))
    .filter((x): x is { c: AppCommand; m: { score: number; indices: number[] } } => !!x.m)
    .sort((a, b) => b.m.score - a.m.score)
    .map(({ c, m }) => commandRow(c, m.indices));
});

function fileRow(path: string, indices: number[]): Row {
  const name = nameOf(path);
  return {
    key: path,
    label: highlightSegments(name, indices),
    detail: dirOf(path) || "根目录",
    shortcut: [],
    run: () => void tabs.open(path),
  };
}

const fileRows = computed<Row[]>(() => {
  const all = vault.notePaths;
  const q = query.value.trim();
  if (!q) {
    // 最近打开的在前（跳转历史倒序），其余按名称
    const recent = [...new Set([...tabs.history].reverse())].filter((p) => all.includes(p));
    const rest = all.filter((p) => !recent.includes(p)).sort((a, b) => nameOf(a).localeCompare(nameOf(b), "zh-CN"));
    return [...recent, ...rest].slice(0, FILE_LIMIT).map((p) => fileRow(p, []));
  }
  return all
    .map((p) => {
      const byName = fuzzyMatch(q, nameOf(p));
      if (byName) return { p, score: byName.score + 50, indices: byName.indices };
      const byPath = fuzzyMatch(q, p);
      return byPath ? { p, score: byPath.score, indices: [] } : null;
    })
    .filter((x): x is { p: string; score: number; indices: number[] } => !!x)
    .sort((a, b) => b.score - a.score)
    .slice(0, FILE_LIMIT)
    .map((x) => fileRow(x.p, x.indices));
});

const mode = computed(() => (ui.palette === "files" && !query.value.startsWith(">") ? "files" : "commands"));
const rows = computed(() => (mode.value === "files" ? fileRows.value : commandRows.value));

watch(rows, () => (index.value = 0));

watch(
  () => ui.palette,
  async (m) => {
    if (!m) return;
    query.value = "";
    index.value = 0;
    await nextTick();
    input.value?.focus();
  },
  { immediate: true },
);

function close() {
  ui.palette = null;
}

function choose(i = index.value) {
  const row = rows.value[i];
  if (!row) return;
  close();
  row.run();
}

function move(delta: number) {
  const n = rows.value.length;
  if (!n) return;
  index.value = (index.value + delta + n) % n;
  nextTick(() => host.value?.querySelector(".pal-row.on")?.scrollIntoView({ block: "nearest" }));
}

function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") move(1);
  else if (e.key === "ArrowUp") move(-1);
  else if (e.key === "Enter") choose();
  else if (e.key === "Escape") close();
  else return;
  e.preventDefault();
}

function onDocDown(e: MouseEvent) {
  if (ui.palette && host.value && !host.value.contains(e.target as Node)) close();
}
onMounted(() => document.addEventListener("mousedown", onDocDown, true));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocDown, true));
</script>

<template>
  <div v-if="ui.palette" ref="host" class="pop palette" role="dialog" :aria-label="mode === 'files' ? '快速打开' : '命令面板'">
    <input
      ref="input"
      v-model="query"
      :placeholder="mode === 'files' ? '按笔记名搜索' : '输入命令名称'"
      spellcheck="false"
      @keydown="onKey"
    />
    <div class="pal-list">
      <template v-for="(r, i) in rows" :key="r.key">
        <div v-if="r.group" class="pal-group">{{ r.group }}</div>
        <div class="pal-row" :class="{ on: i === index }" @mouseenter="index = i" @mousedown.prevent @click="choose(i)">
          <Icon v-if="mode === 'files'" name="file" sm />
          <span class="pt"><template v-for="(s, j) in r.label" :key="j"><b v-if="s.hit">{{ s.text }}</b><template v-else>{{ s.text }}</template></template></span>
          <span class="pc">{{ r.detail }}</span>
          <span v-if="r.shortcut.length" class="kbd"><span v-for="k in r.shortcut" :key="k">{{ k }}</span></span>
        </div>
      </template>
      <div v-if="!rows.length" class="pal-empty">{{ mode === "files" ? "没有匹配的笔记" : "没有匹配的命令" }}</div>
    </div>
    <div class="pal-foot">
      <span>↑↓ 选择</span><span>Enter {{ mode === "files" ? "打开" : "执行" }}</span><span>Esc 关闭</span>
      <span v-if="mode === 'files'" class="pal-foot-right">输入 &gt; 切换到命令面板</span>
    </div>
  </div>
</template>
