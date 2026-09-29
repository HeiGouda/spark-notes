<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { PALETTE, resolveColor } from "../diagram/colors";
import type { AlignMode } from "../diagram/flowLayout";
import { FLOW_SHAPES, type FlowEdgeStyle, type FlowShape } from "../diagram/flowchart";
import type { EdgeRoute, FontSize, NodeStyle } from "../diagram/spark";

/**
 * 工具栏的格式区（需求文档 5.18）：跟随选中的内容。选中节点时是颜色、字号、加粗、格式刷、恢复默认样式
 * （流程图另有形状，多选时有对齐）；流程图选中连线时换成走线和线型；没有选中时按钮不可用、位置不变。
 */
const props = defineProps<{
  kind: "mind" | "flow";
  /** 选中了节点且可以编辑 */
  enabled: boolean;
  style?: NodeStyle;
  /** 第一个选中节点现在是否加粗 */
  bold: boolean;
  dark: boolean;
  painter: "off" | "once" | "sticky";
  /** 流程图：第一个选中节点的形状（文字节点为 null） */
  shape?: FlowShape | null;
  /** 流程图：选中的节点数 */
  count?: number;
  /** 流程图选中连线时 */
  edge?: { route: EdgeRoute; style: FlowEdgeStyle } | null;
}>();

const emit = defineEmits<{
  style: [patch: Partial<NodeStyle>];
  reset: [];
  painter: [mode: "off" | "once" | "sticky"];
  shape: [shape: FlowShape];
  align: [mode: AlignMode];
  route: [route: EdgeRoute];
  edgeStyle: [style: FlowEdgeStyle];
  done: [];
}>();

type Pop = "bg" | "border" | "color" | "size" | "shape" | "align" | "route" | "line";
const open = ref<Pop | null>(null);
const root = ref<HTMLElement | null>(null);

const SIZES: { id: FontSize; label: string }[] = [
  { id: "s", label: "小" },
  { id: "m", label: "中" },
  { id: "l", label: "大" },
  { id: "xl", label: "特大" },
];
const SHAPE_ICON: Record<FlowShape, [string, string]> = {
  rect: ["矩形", "M3 5h22v12H3z"],
  round: ["圆角", "M6 5h16a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z"],
  stadium: ["胶囊", "M9 5h10a6 6 0 0 1 0 12H9A6 6 0 0 1 9 5z"],
  circle: ["圆", "M14 3a8 8 0 1 1 0 16a8 8 0 1 1 0-16z"],
  diamond: ["菱形", "M14 2L25 11L14 20L3 11Z"],
  hexagon: ["六边形", "M8 4H20L25 11L20 18H8L3 11Z"],
  parallelogram: ["平行四边形", "M8 5H25L20 17H3Z"],
  trapezoid: ["梯形", "M8 5H20L25 17H3Z"],
  cylinder: ["圆柱", "M5 6V16C5 19 23 19 23 16V6M5 6C5 3 23 3 23 6C23 9 5 9 5 6"],
};
const ALIGNS: { id: AlignMode; label: string }[][] = [
  [{ id: "left", label: "左对齐" }, { id: "hcenter", label: "水平居中" }, { id: "right", label: "右对齐" }],
  [{ id: "top", label: "顶对齐" }, { id: "vcenter", label: "垂直居中" }, { id: "bottom", label: "底对齐" }],
  [{ id: "hspace", label: "水平等间距" }, { id: "vspace", label: "垂直等间距" }],
];
const ROUTES: { id: EdgeRoute; label: string; d: string }[] = [
  { id: "elbow", label: "直角", d: "M4 4H18V18H32" },
  { id: "round", label: "圆角", d: "M4 4H14Q18 4 18 8V14Q18 18 22 18H32" },
  { id: "straight", label: "直线", d: "M4 4L32 18" },
];
const LINE_STYLES: { id: FlowEdgeStyle; label: string }[] = [
  { id: "arrow", label: "实线箭头" },
  { id: "line", label: "无箭头" },
  { id: "dotted", label: "虚线" },
  { id: "thick", label: "粗线" },
];

const COLOR_KEYS: { key: "bg" | "border" | "color"; label: string; glyph: string }[] = [
  { key: "bg", label: "背景色", glyph: "bg" },
  { key: "border", label: "边框色", glyph: "border" },
  { key: "color", label: "文字颜色", glyph: "text" },
];

/** 色条显示的颜色：没设时显示为空 */
const strip = (key: "bg" | "border" | "color") => resolveColor(props.style?.[key], props.dark) ?? "transparent";
const sizeLabel = computed(() => SIZES.find((s) => s.id === (props.style?.size ?? "m"))!.label);

function toggle(p: Pop) {
  open.value = open.value === p ? null : p;
}

function pick(patch: Partial<NodeStyle>) {
  open.value = null;
  emit("style", patch);
  emit("done");
}

const custom = (v: string | undefined) => !!v && v.startsWith("#");
const picker = ref<HTMLInputElement | null>(null);
const pickFor = ref<"bg" | "border" | "color">("bg");
function openPicker(key: "bg" | "border" | "color") {
  pickFor.value = key;
  const el = picker.value;
  if (!el) return;
  const cur = resolveColor(props.style?.[key], props.dark);
  el.value = cur?.startsWith("#") ? cur.slice(0, 7) : "#888888";
  el.click();
}
function onPick(e: Event) {
  pick({ [pickFor.value]: (e.target as HTMLInputElement).value.toLowerCase() });
}

function onPainterClick() {
  emit("painter", props.painter === "off" ? "once" : "off");
}

function onOutside(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = null;
}
onMounted(() => document.addEventListener("mousedown", onOutside, true));
onBeforeUnmount(() => document.removeEventListener("mousedown", onOutside, true));
</script>

<template>
  <div ref="root" class="dformat" @mousedown.stop>
    <template v-if="edge">
      <div class="dmenu-wrap">
        <button class="dbtn" :class="{ 'is-active': open === 'route' }" title="走线" @mousedown.prevent @click="toggle('route')">
          走线：{{ ROUTES.find((r) => r.id === edge!.route)?.label }} <Icon name="down" sm />
        </button>
        <div v-if="open === 'route'" class="dpop dp-list">
          <button v-for="r in ROUTES" :key="r.id" type="button" class="dp-item" :class="{ on: edge.route === r.id }" @mousedown.prevent @click="open = null; emit('route', r.id); emit('done')">
            <svg viewBox="0 0 36 22" class="dp-ico" aria-hidden="true"><path :d="r.d" /></svg>{{ r.label }}
          </button>
        </div>
      </div>
      <div class="dmenu-wrap">
        <button class="dbtn" :class="{ 'is-active': open === 'line' }" title="线型" @mousedown.prevent @click="toggle('line')">
          线型：{{ LINE_STYLES.find((s) => s.id === edge!.style)?.label }} <Icon name="down" sm />
        </button>
        <div v-if="open === 'line'" class="dpop dp-list">
          <button v-for="s in LINE_STYLES" :key="s.id" type="button" class="dp-item" :class="{ on: edge.style === s.id }" @mousedown.prevent @click="open = null; emit('edgeStyle', s.id); emit('done')">
            <svg viewBox="0 0 36 22" class="dp-ico" aria-hidden="true">
              <path d="M4 11H30" :class="`ln-${s.id}`" /><path v-if="s.id !== 'line'" d="M26 7L32 11L26 15Z" class="f" />
            </svg>{{ s.label }}
          </button>
        </div>
      </div>
    </template>
    <template v-else>
      <div v-if="kind === 'flow'" class="dmenu-wrap">
        <button class="dbtn icon-dd" :class="{ 'is-active': open === 'shape' }" :disabled="!enabled" title="改为某种形状" @mousedown.prevent @click="toggle('shape')">
          <svg viewBox="0 0 28 22" class="dp-ico" aria-hidden="true"><path :d="SHAPE_ICON[shape ?? 'rect'][1]" /></svg><Icon name="down" sm />
        </button>
        <div v-if="open === 'shape'" class="dpop dp-shapes">
          <button v-for="s in FLOW_SHAPES" :key="s" type="button" class="flow-pop-cell" :class="{ on: shape === s }" :title="SHAPE_ICON[s][0]" @mousedown.prevent @click="open = null; emit('shape', s); emit('done')">
            <svg viewBox="0 0 28 22" aria-hidden="true"><path :d="SHAPE_ICON[s][1]" /></svg>
          </button>
        </div>
      </div>
      <div v-for="c in COLOR_KEYS" :key="c.key" class="dmenu-wrap">
        <button class="dbtn icon-dd" :class="{ 'is-active': open === c.key }" :disabled="!enabled" :title="c.label" @mousedown.prevent @click="toggle(c.key)">
          <span class="dcolor">
            <svg v-if="c.glyph === 'bg'" viewBox="0 0 16 12" aria-hidden="true"><rect x="2" y="1" width="12" height="9" rx="2" class="f" /></svg>
            <svg v-else-if="c.glyph === 'border'" viewBox="0 0 16 12" aria-hidden="true"><rect x="2.5" y="1.5" width="11" height="8" rx="2" /></svg>
            <b v-else>A</b>
            <i :style="{ background: strip(c.key) }" />
          </span>
          <Icon name="down" sm />
        </button>
        <div v-if="open === c.key" class="dpop">
          <div class="dp-label">{{ c.label }}</div>
          <div class="dp-pal">
            <button type="button" class="dp-c none" :class="{ on: !style?.[c.key] }" title="默认" @mousedown.prevent @click="pick({ [c.key]: undefined })" />
            <button
              v-for="p in PALETTE"
              :key="p.name"
              type="button"
              class="dp-c"
              :class="{ on: style?.[c.key] === p.name }"
              :style="{ background: dark ? p.dark : p.light }"
              :title="p.label"
              @mousedown.prevent
              @click="pick({ [c.key]: p.name })"
            />
            <button
              type="button"
              class="dp-c more"
              :class="{ on: custom(style?.[c.key]) }"
              :style="custom(style?.[c.key]) ? { background: style?.[c.key] } : undefined"
              title="更多颜色"
              @mousedown.prevent
              @click="openPicker(c.key)"
            />
          </div>
        </div>
      </div>
      <div class="dmenu-wrap">
        <button class="dbtn dsize" :class="{ 'is-active': open === 'size' }" :disabled="!enabled" title="字号" @mousedown.prevent @click="toggle('size')">
          {{ sizeLabel }} <Icon name="down" sm />
        </button>
        <div v-if="open === 'size'" class="dpop dp-list">
          <button v-for="s in SIZES" :key="s.id" type="button" class="dp-item" :class="{ on: (style?.size ?? 'm') === s.id }" @mousedown.prevent @click="pick({ size: s.id === 'm' ? undefined : s.id })">{{ s.label }}</button>
        </div>
      </div>
      <button class="dbtn icon" :class="{ 'is-active': enabled && bold }" :disabled="!enabled" title="加粗" @mousedown.prevent @click="emit('style', { bold: !bold }); emit('done')"><b>B</b></button>
      <button
        class="dbtn icon"
        :class="{ 'is-active': painter !== 'off' }"
        :disabled="!enabled && painter === 'off'"
        :title="painter === 'sticky' ? '格式刷（连续，按 Esc 退出）' : '格式刷：单击刷一次，双击可以连续刷'"
        @mousedown.prevent
        @click="onPainterClick"
        @dblclick="emit('painter', 'sticky')"
      ><Icon name="brush" sm /></button>
      <button class="dbtn icon" :disabled="!enabled" title="恢复默认样式" @mousedown.prevent @click="emit('reset'); emit('done')"><Icon name="reset" sm /></button>
      <div v-if="kind === 'flow' && (count ?? 0) >= 2" class="dmenu-wrap">
        <button class="dbtn" :class="{ 'is-active': open === 'align' }" :disabled="!enabled" title="对齐与分布" @mousedown.prevent @click="toggle('align')">
          <Icon name="align" sm />对齐 <Icon name="down" sm />
        </button>
        <div v-if="open === 'align'" class="dpop dp-list">
          <template v-for="(group, gi) in ALIGNS" :key="gi">
            <div v-if="gi" class="dp-sep" />
            <button
              v-for="a in group"
              :key="a.id"
              type="button"
              class="dp-item"
              :disabled="(a.id === 'hspace' || a.id === 'vspace') && (count ?? 0) < 3"
              @mousedown.prevent
              @click="open = null; emit('align', a.id); emit('done')"
            >{{ a.label }}</button>
          </template>
        </div>
      </div>
    </template>
    <input ref="picker" class="dp-picker" type="color" tabindex="-1" aria-hidden="true" @change="onPick" />
  </div>
</template>
