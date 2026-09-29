<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { SCHEMES, swatches } from "../diagram/colors";
import type { CanvasStyle, EdgeRoute, MindLine, MindStructure, Spacing } from "../diagram/spark";
import type { FlowEdgeStyle } from "../diagram/flowchart";

/** 工具栏右侧的“画布”下拉（需求文档 5.18）：整张图的结构、外观、线条、配色、间距，流程图另有新连线的样式 */
const props = defineProps<{
  kind: "mind" | "flow";
  canvas: CanvasStyle;
  dark: boolean;
  readonly?: boolean;
  /** 流程图新连线的线型和走线 */
  edgeStyle?: FlowEdgeStyle;
  edgeRoute?: EdgeRoute;
}>();

const emit = defineEmits<{
  canvas: [patch: Partial<CanvasStyle>];
  edgeStyle: [style: FlowEdgeStyle];
  route: [route: EdgeRoute];
  /** 操作完成，把焦点还给图 */
  done: [];
}>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const STRUCTS: { id: MindStructure; label: string; d: string; f: string }[] = [
  { id: "right", label: "向右", f: "M2 8h9v6H2z", d: "M11 11H18M18 4V18M18 4H30M18 11H30M18 18H30" },
  { id: "balanced", label: "左右平衡", f: "M13 8h10v6H13z", d: "M23 11H28M28 5V17M28 5H35M28 17H35M13 11H8M8 5V17M8 5H1M8 17H1" },
  { id: "left", label: "向左", f: "M25 8h9v6h-9z", d: "M25 11H18M18 4V18M18 4H6M18 11H6M18 18H6" },
  { id: "down", label: "向下", f: "M13 1h10v6H13z", d: "M18 7V11M5 11H31M5 11V17M18 11V17M31 11V17" },
  { id: "fishbone", label: "鱼骨图", f: "M28 6L35 11L28 16Z", d: "M2 11H28M8 11L4 3M16 11L12 3M8 11L4 19M16 11L12 19" },
];
const LINES: { id: MindLine; label: string; d: string }[] = [
  { id: "curve", label: "曲线", d: "M4 11H10C16 11 16 4 24 4H32M10 11C16 11 16 18 24 18H32" },
  { id: "round", label: "圆角折线", d: "M4 11H14M32 4H18Q14 4 14 8V14Q14 18 18 18H32" },
  { id: "elbow", label: "直角折线", d: "M4 11H14M32 4H14V18H32" },
  { id: "fork", label: "分叉斜线", d: "M4 11H14L22 4H32M14 11L22 18H32" },
  { id: "straight", label: "直线", d: "M4 11L32 4M4 11L32 18" },
  { id: "slant", label: "先斜后平", d: "M4 11L16 4H32M4 11L16 18H32" },
];
const ROUTES: { id: EdgeRoute; label: string; d: string }[] = [
  { id: "elbow", label: "直角", d: "M4 4H18V18H32" },
  { id: "round", label: "圆角", d: "M4 4H14Q18 4 18 8V14Q18 18 22 18H32" },
  { id: "straight", label: "直线", d: "M4 4L32 18" },
];
const EDGES: { id: FlowEdgeStyle; label: string }[] = [
  { id: "arrow", label: "实线箭头" },
  { id: "line", label: "无箭头" },
  { id: "dotted", label: "虚线" },
  { id: "thick", label: "粗线" },
];
const SPACE: { id: Spacing; label: string }[] = [
  { id: "compact", label: "紧凑" },
  { id: "standard", label: "标准" },
  { id: "loose", label: "宽松" },
];

const structure = computed(() => props.canvas.structure ?? "right");
const look = computed(() => props.canvas.look ?? "box");
const mindLine = computed(() => props.canvas.line ?? "curve");
const scheme = computed(() => props.canvas.scheme ?? "theme");
const spacing = computed(() => props.canvas.spacing ?? "standard");

function set(patch: Partial<CanvasStyle>) {
  if (props.readonly) return;
  emit("canvas", patch);
  emit("done");
}

function onOutside(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener("mousedown", onOutside, true));
onBeforeUnmount(() => document.removeEventListener("mousedown", onOutside, true));
</script>

<template>
  <div ref="root" class="dmenu-wrap">
    <button class="dbtn" :class="{ 'is-active': open }" title="整张图的结构、配色和间距" @mousedown.prevent @click="open = !open">
      画布 <Icon name="down" sm />
    </button>
    <div v-if="open" class="dpop dcanvas" @mousedown.stop>
      <template v-if="kind === 'mind'">
        <div class="dp-label">结构</div>
        <div class="dp-structs">
          <button v-for="s in STRUCTS" :key="s.id" type="button" class="dp-struct" :class="{ on: structure === s.id }" :title="s.label" :disabled="readonly" @mousedown.prevent @click="set({ structure: s.id })">
            <svg viewBox="0 0 36 22" aria-hidden="true"><path :d="s.f" class="f" /><path :d="s.d" /></svg>
            <span>{{ s.label }}</span>
          </button>
        </div>
        <div class="dp-label">节点外观</div>
        <div class="dp-seg">
          <button type="button" :class="{ on: look === 'box' }" :disabled="readonly" @mousedown.prevent @click="set({ look: undefined })">方框</button>
          <button type="button" :class="{ on: look === 'text' }" :disabled="readonly" @mousedown.prevent @click="set({ look: 'text' })">纯文字</button>
        </div>
        <div class="dp-label">线条</div>
        <div class="dp-structs six">
          <button v-for="l in LINES" :key="l.id" type="button" class="dp-struct" :class="{ on: mindLine === l.id }" :title="l.label" :disabled="readonly || structure === 'fishbone'" @mousedown.prevent @click="set({ line: l.id === 'curve' ? undefined : l.id })">
            <svg viewBox="0 0 36 22" aria-hidden="true"><path :d="l.d" /></svg>
            <span>{{ l.label }}</span>
          </button>
        </div>
      </template>

      <div class="dp-label">配色方案</div>
      <div class="dp-schemes four">
        <button v-for="s in SCHEMES" :key="s.id" type="button" class="dp-scheme" :class="{ on: scheme === s.id }" :disabled="readonly" @mousedown.prevent @click="set({ scheme: s.id === 'theme' ? undefined : s.id })">
          <span class="dp-sw"><i v-for="(c, i) in swatches(s.id, dark)" :key="i" :style="{ background: c }" /></span>
          {{ s.id === "theme" ? "跟随主题" : s.name }}
        </button>
      </div>

      <div class="dp-label">主题间距<span v-if="kind === 'flow'" class="dp-note">（AI 整理时用）</span></div>
      <div class="dp-seg">
        <button v-for="s in SPACE" :key="s.id" type="button" :class="{ on: spacing === s.id }" :disabled="readonly" @mousedown.prevent @click="set({ spacing: s.id === 'standard' ? undefined : s.id })">{{ s.label }}</button>
      </div>

      <template v-if="kind === 'flow'">
        <div class="dp-label">新连线的走线</div>
        <div class="dp-structs three">
          <button v-for="r in ROUTES" :key="r.id" type="button" class="dp-struct" :class="{ on: edgeRoute === r.id }" :disabled="readonly" @mousedown.prevent @click="emit('route', r.id); emit('done')">
            <svg viewBox="0 0 36 22" aria-hidden="true"><path :d="r.d" /></svg>
            <span>{{ r.label }}</span>
          </button>
        </div>
        <div class="dp-label">新连线的线型</div>
        <div class="dp-seg">
          <button v-for="s in EDGES" :key="s.id" type="button" :class="{ on: edgeStyle === s.id }" :disabled="readonly" @mousedown.prevent @click="emit('edgeStyle', s.id); emit('done')">{{ s.label }}</button>
        </div>
      </template>
    </div>
  </div>
</template>
