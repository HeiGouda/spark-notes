<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "../../lib/api";
import { DOC_LABEL, docKind, docName } from "../../lib/doctype";
import { isDarkTheme } from "../../lib/themes";
import { flowNodeColors, mindNodeColors, schemeColors } from "../../diagram/colors";
import { cylinderRy, fillPositions, flowGeometry, shapePath, type FlowBox } from "../../diagram/flowLayout";
import { eachMind, parseMind, type MindDoc } from "../../diagram/mindmap";
import { layoutMind } from "../../diagram/mindLayout";
import { parseFlow, type FlowDoc } from "../../diagram/flowchart";
import type { DiagramIssue } from "../../diagram/issues";
import type { NodeStyle } from "../../diagram/spark";
import Icon from "../Icon.vue";
import SheetStrip from "../SheetStrip.vue";
import { bookName, bookOf } from "../../lib/book";
import { useMobile } from "../store";
import { back } from "../nav";

const props = defineProps<{ path: string }>();
const store = useMobile();
const error = ref("");
const issues = ref<DiagramIssue[] | null>(null);
const mind = ref<MindDoc | null>(null);
const flow = ref<FlowDoc | null>(null);
const host = ref<HTMLElement | null>(null);
const kind = docKind(props.path) === "flow" ? "flow" : "mind";
const title = docName(props.path);
const bookPath = bookOf(props.path);

const dark = computed(() => isDarkTheme(store.reader.theme));

const mindView = computed(() => {
  const doc = mind.value;
  if (!doc) return null;
  const styles = new Map<string, NodeStyle>();
  eachMind(doc.root, (n) => n.style && styles.set(n.id, n.style));
  const c = doc.canvas;
  const layout = layoutMind(doc.root, new Set(), { structure: c.structure, look: c.look, line: c.line, spacing: c.spacing, styles });
  const scheme = schemeColors(c.scheme, dark.value);
  const colors = new Map<string, { fill: string; stroke: string; text: string; line: string }>();
  for (const b of layout.boxes.values()) colors.set(b.id, mindNodeColors(scheme, b.depth, b.branch, b.summary, styles.get(b.id), dark.value, b.boxed));
  return { layout, scheme, colors };
});

const flowView = computed(() => {
  const doc = flow.value;
  if (!doc) return null;
  const copy: FlowDoc = { ...doc, nodes: doc.nodes.map((n) => ({ ...n })), edges: doc.edges };
  fillPositions(copy);
  const geo = flowGeometry(copy);
  const scheme = schemeColors(doc.canvas.scheme, dark.value);
  const pad = 32;
  return { doc: copy, geo, scheme, pad };
});

const size = computed(() => {
  if (mindView.value) return { w: Math.max(mindView.value.layout.width, 1), h: Math.max(mindView.value.layout.height, 1) };
  const f = flowView.value;
  if (!f) return { w: 1, h: 1 };
  return { w: Math.max(f.geo.width + f.pad * 2, 1), h: Math.max(f.geo.height + f.pad * 2, 1) };
});

const view = reactive({ k: 1, x: 0, y: 0 });

function fit() {
  const el = host.value;
  if (!el) return;
  const k = Math.min(1.2, (el.clientWidth - 24) / size.value.w, (el.clientHeight - 24) / size.value.h);
  view.k = Number.isFinite(k) && k > 0 ? k : 1;
  view.x = (el.clientWidth - size.value.w * view.k) / 2;
  view.y = (el.clientHeight - size.value.h * view.k) / 2;
}

onMounted(async () => {
  void store.rememberOpen(bookPath ?? props.path);
  if (!store.root) return;
  try {
    const { content } = await api.readNote(store.root, props.path);
    if (kind === "mind") {
      const parsed = parseMind(content, title);
      if (parsed.ok) mind.value = parsed.doc;
      else issues.value = parsed.issues;
    } else {
      const parsed = parseFlow(content);
      if (parsed.ok) flow.value = parsed.doc;
      else issues.value = parsed.issues;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
  requestAnimationFrame(fit);
});

function box(id: string) {
  return mindView.value?.layout.boxes.get(id);
}
function vars(id: string) {
  const c = mindView.value?.colors.get(id);
  return c ? { "--n-fill": c.fill, "--n-stroke": c.stroke, "--n-text": c.text, "--n-line": c.line } : {};
}
function flowVars(b: FlowBox) {
  const f = flowView.value;
  if (!f) return {};
  const c = flowNodeColors(f.scheme, b.shape === "diamond", f.doc.nodes.find((n) => n.id === b.id)?.style, dark.value);
  return { "--n-fill": c.fill, "--n-stroke": c.stroke, "--n-text": c.text };
}
const textShift = (b: FlowBox) => (b.shape === "cylinder" && !b.isText ? cylinderRy(b.h) / 2 : 0);

interface Gesture {
  k: number;
  x: number;
  y: number;
  dist: number;
  mx: number;
  my: number;
}
let g: Gesture | null = null;
const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const mid = (t: TouchList) => (t.length > 1 ? [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2] : [t[0].clientX, t[0].clientY]);

function onStart(e: TouchEvent) {
  const [mx, my] = mid(e.touches);
  g = { k: view.k, x: view.x, y: view.y, dist: e.touches.length > 1 ? dist(e.touches) : 0, mx, my };
}
function onMove(e: TouchEvent) {
  if (!g) return;
  e.preventDefault();
  const [mx, my] = mid(e.touches);
  if (e.touches.length > 1 && g.dist) {
    const k = Math.min(4, Math.max(0.3, (g.k * dist(e.touches)) / g.dist));
    view.x = mx - ((g.mx - g.x) * k) / g.k;
    view.y = my - ((g.my - g.y) * k) / g.k;
    view.k = k;
  } else {
    view.x = g.x + mx - g.mx;
    view.y = g.y + my - g.my;
  }
}
function onEnd(e: TouchEvent) {
  if (e.touches.length) onStart(e);
  else g = null;
}
</script>

<template>
  <div class="page bare">
    <div class="top">
      <button class="ib" @click="back()"><Icon name="back" /></button>
      <h1>{{ bookPath ? bookName(bookPath) : title }}<small>{{ bookPath ? `${title} · ` : "" }}{{ DOC_LABEL[kind] }} · 只读</small></h1>
      <button class="ib" title="居中" @click="fit"><Icon name="target" /></button>
    </div>
    <div v-if="error" class="m-empty">{{ error }}</div>
    <div v-else-if="issues" class="scroll">
      <div class="issue">
        <Icon name="warn" :size="36" />
        <h2>这张图暂时无法显示</h2>
        <p>文件里有 Spark 还不支持的写法。为避免画错，这里不画图，也不会改动文件。</p>
        <ul>
          <li v-for="(it, i) in issues" :key="i">第 {{ it.line }} 行：{{ it.message }}</li>
        </ul>
      </div>
    </div>
    <div v-else ref="host" class="diagram-canvas" @touchstart="onStart" @touchmove="onMove" @touchend="onEnd" @touchcancel="onEnd">
      <svg
        v-if="mindView"
        class="mind-svg"
        :width="size.w * view.k"
        :height="size.h * view.k"
        :viewBox="`0 0 ${size.w} ${size.h}`"
        :style="{ transform: `translate(${view.x}px, ${view.y}px)` }"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path v-if="mindView.layout.spine" class="mind-spine" :d="mindView.layout.spine" :style="{ stroke: mindView.scheme.line }" />
        <path v-for="l in mindView.layout.links" :key="l.to" class="mind-link" :d="l.d" :style="{ stroke: mindView.colors.get(l.to)?.line }" />
        <path v-for="br in mindView.layout.brackets" :key="br.id" class="mind-bracket" :d="br.d" :style="{ stroke: mindView.colors.get(br.id)?.line }" />
        <g v-for="id in mindView.layout.order" :key="id" class="mind-node" :style="vars(id)">
          <rect
            class="mind-box"
            :class="{ 'is-plain': !box(id)!.boxed, 'is-summary': box(id)!.summary }"
            :x="box(id)!.x"
            :y="box(id)!.y"
            :width="box(id)!.w"
            :height="box(id)!.h"
            :rx="box(id)!.depth === 0 ? 8 : 5"
          />
          <line v-if="box(id)!.underline" class="mind-underline" :x1="box(id)!.x" :x2="box(id)!.x + box(id)!.w" :y1="box(id)!.y + box(id)!.h" :y2="box(id)!.y + box(id)!.h" />
          <text class="mind-text" :font-size="box(id)!.size" :font-weight="box(id)!.weight">
            <tspan v-for="(line, i) in box(id)!.lines" :key="i" :x="box(id)!.x + box(id)!.padX" :y="box(id)!.y + box(id)!.padY + i * box(id)!.lineH + box(id)!.lineH * 0.7">{{ line }}</tspan>
          </text>
        </g>
      </svg>
      <svg
        v-else-if="flowView"
        class="flow-svg"
        :width="size.w * view.k"
        :height="size.h * view.k"
        :viewBox="`${flowView.geo.minX - flowView.pad} ${flowView.geo.minY - flowView.pad} ${size.w} ${size.h}`"
        :style="{ transform: `translate(${view.x}px, ${view.y}px)`, '--d-edge': flowView.scheme.edge }"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path class="flow-arrow" d="M0 0L10 5L0 10z" />
          </marker>
        </defs>
        <g v-for="r in flowView.geo.routes" :key="r.key" class="flow-edge" :class="`style-${flowView.doc.edges.find((e) => e.key === r.key)?.style}`">
          <path class="flow-edge-line" :d="r.d" :marker-end="flowView.doc.edges.find((e) => e.key === r.key)?.style === 'line' ? undefined : 'url(#flow-arrow)'" />
          <g v-if="r.label" class="flow-label" :transform="`translate(${r.label.x} ${r.label.y})`">
            <rect :width="r.label.w" :height="r.label.h" rx="4" />
            <text :x="r.label.w / 2" :y="14" text-anchor="middle">{{ flowView.doc.edges.find((e) => e.key === r.key)?.label }}</text>
          </g>
        </g>
        <g v-for="b in flowView.geo.boxes.values()" :key="b.id" class="flow-node" :class="b.isText ? 'is-text' : `shape-${b.shape}`" :transform="`translate(${b.cx} ${b.cy})`" :style="flowVars(b)">
          <rect v-if="b.isText" class="flow-text-box" :x="-b.w / 2" :y="-b.h / 2" :width="b.w" :height="b.h" rx="3" />
          <path v-else class="flow-shape" :d="shapePath(b.shape, b.w, b.h)" />
          <text class="flow-text" text-anchor="middle" :font-size="b.size" :font-weight="b.weight">
            <tspan v-for="(line, i) in b.lines" :key="i" x="0" :y="(i - (b.lines.length - 1) / 2) * b.lineH + b.size * 0.35 + textShift(b)">{{ line }}</tspan>
          </text>
        </g>
      </svg>
    </div>
    <SheetStrip :path="path" />
  </div>
</template>
