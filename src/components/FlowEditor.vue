<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import Icon from "./Icon.vue";
import DiagramFormatBar from "./DiagramFormatBar.vue";
import DiagramCanvasMenu from "./DiagramCanvasMenu.vue";
import DiagramZoom from "./DiagramZoom.vue";
import type { MenuEntry } from "./MenuList.vue";
import {
  FLOW_SHAPES, addFlowEdge, addFlowNode, copyFragment, findFlowNode, fragmentToText, pasteFragment, removeFlowEdge, removeFlowNode, shiftBends,
  reconnectEdge, serializeFlow, textToFragment, type FlowDoc, type FlowEdgeStyle, type FlowShape,
} from "../diagram/flowchart";
import {
  GRID, MIN_H, MIN_W, alignNodes, approachSide, arrange, cylinderRy, dirLabel, facing, fillPositions, flowGeometry, measureNode, opposite,
  bendHandle, bendsOf, pointRoute, polylinePath, routePoints, shapePath, sideNear, sidePoints, sidesOf, type AlignMode, type FlowBox,
} from "../diagram/flowLayout";
import { arrangeMessages, parseArrange } from "../diagram/aiArrange";
import { recall, remember } from "../diagram/clipboard";
import { formatTokens, messagesTokens } from "../lib/aiModels";
import { displayShortcut } from "../lib/shortcut";
import { AiCancelled, useAiStore, type AiRun } from "../stores/ai";
import { useNoticeStore } from "../stores/notice";
import { flowNodeColors, schemeColors } from "../diagram/colors";
import { patchStyle, type CanvasStyle, type EdgeRoute, type NodeStyle, type Side } from "../diagram/spark";
import { findInItems, groupMatches, replaceMatches, type DiagramMatch } from "../diagram/find";
import { dispatchShortcut, shortcutOf, tipFor } from "../lib/commands";
import { isDarkTheme } from "../lib/themes";
import { useContextMenuStore } from "../stores/contextMenu";
import { useSettingsStore } from "../stores/settings";
import type { DiagramAction } from "../stores/diagram";

const props = defineProps<{ doc: FlowDoc; readonly?: boolean; bare?: boolean; zoom: number }>();
const emit = defineEmits<{
  change: [text: string];
  zoom: [value: number];
  stats: [nodes: number, edges: number, selected: number];
  aiGenerate: [];
}>();

const NEW_TEXT = "新节点";
const TEXT_TEXT = "文字";
const MARGIN = 60;
const HISTORY = 100;
/** 靠近其他节点的中线或边多近时吸附 */
const SNAP = 6;
/** 快速延伸、Tab、Enter 新建的节点离原节点多远 */
const GAP = 60;

const SHAPE_INFO: Record<FlowShape, { label: string; icon: string }> = {
  rect: { label: "矩形", icon: "M3 5h22v12H3z" },
  round: { label: "圆角", icon: "M6 5h16a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z" },
  stadium: { label: "胶囊", icon: "M9 5h10a6 6 0 0 1 0 12H9A6 6 0 0 1 9 5z" },
  circle: { label: "圆", icon: "M14 3a8 8 0 1 1 0 16a8 8 0 1 1 0-16z" },
  diamond: { label: "菱形", icon: "M14 2L25 11L14 20L3 11Z" },
  hexagon: { label: "六边形", icon: "M8 4H20L25 11L20 18H8L3 11Z" },
  parallelogram: { label: "平行四边形", icon: "M8 5H25L20 17H3Z" },
  trapezoid: { label: "梯形", icon: "M8 5H20L25 17H3Z" },
  cylinder: { label: "圆柱", icon: "M5 6V16C5 19 23 19 23 16V6M5 6C5 3 23 3 23 6C23 9 5 9 5 6" },
};
const TEXT_ICON = "M8 5H20M14 5V18";
const STYLES: { style: FlowEdgeStyle; label: string }[] = [
  { style: "arrow", label: "实线箭头" },
  { style: "line", label: "无箭头" },
  { style: "dotted", label: "虚线" },
  { style: "thick", label: "粗线" },
];
const ROUTES: { route: EdgeRoute; label: string }[] = [
  { route: "elbow", label: "直角" },
  { route: "round", label: "圆角" },
  { route: "straight", label: "直线" },
];
const ALIGNS: { mode: AlignMode; label: string }[] = [
  { mode: "left", label: "左对齐" }, { mode: "hcenter", label: "水平居中" }, { mode: "right", label: "右对齐" },
  { mode: "top", label: "顶对齐" }, { mode: "vcenter", label: "垂直居中" }, { mode: "bottom", label: "底对齐" },
  { mode: "hspace", label: "水平等间距" }, { mode: "vspace", label: "垂直等间距" },
];
const NORMAL: Record<Side, [number, number]> = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const SIDE_LABELS: [Side, string][] = [["top", "上边"], ["bottom", "下边"], ["left", "左边"], ["right", "右边"]];
const DIR_SIDE: Record<FlowDoc["dir"], Side> = { TD: "bottom", BT: "top", LR: "right", RL: "left" };

const settings = useSettingsStore();
const dark = computed(() => isDarkTheme(settings.theme));

/* ---------- 文档与撤销 ---------- */
/** 载入时给没有位置的节点补上位置；只在内存里，编辑后才随文件保存 */
function load(d: FlowDoc): FlowDoc {
  const copy = structuredClone(d);
  fillPositions(copy);
  return copy;
}

const doc = shallowRef<FlowDoc>(load(props.doc));
const version = ref(0);
const past: FlowDoc[] = [];
const future: FlowDoc[] = [];

function commit() {
  version.value++;
  emit("change", serializeFlow(doc.value));
}

function snapshot() {
  past.push(structuredClone(doc.value));
  if (past.length > HISTORY) past.shift();
  future.length = 0;
}

function mutate(fn: (d: FlowDoc) => void, record = true) {
  if (props.readonly) return;
  if (record) snapshot();
  fn(doc.value);
  commit();
}

function fixSelection() {
  nodeSel.value = nodeSel.value.filter((id) => findFlowNode(doc.value, id));
  const s = selected.value;
  if (s?.type === "node" && !findFlowNode(doc.value, s.id)) {
    const last = nodeSel.value[nodeSel.value.length - 1];
    selected.value = last ? { type: "node", id: last } : null;
  }
  if (s?.type === "edge" && !doc.value.edges.some((e) => e.key === s.key)) selected.value = null;
}

function undo() {
  const prev = past.pop();
  if (!prev || props.readonly) return;
  future.push(doc.value);
  doc.value = prev;
  fixSelection();
  commit();
}

function redo() {
  const next = future.pop();
  if (!next || props.readonly) return;
  past.push(doc.value);
  doc.value = next;
  fixSelection();
  commit();
}

watch(
  () => props.doc,
  (d) => {
    doc.value = load(d);
    past.length = 0;
    future.length = 0;
    fixSelection();
    version.value++;
    // AI 生成中图不断变大，保持在视野中间
    // 生成过程中保持在视野中间，但不抢走顶部输入框的焦点
    if (props.readonly) void nextTick(() => center(false));
  },
);

/* ---------- 几何与配色 ---------- */
const geo = computed(() => {
  void version.value;
  return flowGeometry(doc.value);
});

const scheme = computed(() => {
  void version.value;
  return schemeColors(doc.value.canvas.scheme, dark.value);
});

function nodeVars(b: FlowBox) {
  const c = flowNodeColors(scheme.value, b.shape === "diamond", findFlowNode(doc.value, b.id)?.style, dark.value);
  return { "--n-fill": c.fill, "--n-stroke": c.stroke, "--n-text": c.text };
}

const host = ref<HTMLElement | null>(null);
const viewW = ref(800);
const viewH = ref(600);
let resize: ResizeObserver | null = null;
/** 四周各留出一个窗口大小的空白，图比窗口小时也能拖动画布 */
const padX = computed(() => Math.max(MARGIN, viewW.value / props.zoom));
const padY = computed(() => Math.max(MARGIN, viewH.value / props.zoom));
const canvasW = computed(() => geo.value.width + padX.value * 2);
const canvasH = computed(() => geo.value.height + padY.value * 2);
/** 图坐标 (0, 0) 在画布上的位置 */
const originX = computed(() => padX.value - geo.value.minX);
const originY = computed(() => padY.value - geo.value.minY);

/** 图的范围变了（例如节点拖到了最左边外面）时滚动画布，让画面不跳 */
watch(
  () => [geo.value.minX, geo.value.minY] as const,
  ([x, y], [ox, oy]) => {
    const el = host.value;
    if (!el || zooming) return;
    void nextTick(() => {
      el.scrollLeft += (ox - x) * props.zoom;
      el.scrollTop += (oy - y) * props.zoom;
    });
  },
);

const box = (id: string): FlowBox | undefined => geo.value.boxes.get(id);
const edgeOf = (key: string) => doc.value.edges.find((e) => e.key === key);
const routeOf = (key: string) => geo.value.routes.find((r) => r.key === key);

/* ---------- 选中与编辑 ---------- */
type Sel = { type: "node"; id: string } | { type: "edge"; key: string };
const selected = ref<Sel | null>(null);
/** 选中的全部节点（Shift / Ctrl 加选、框选）；选中连线时为空 */
const nodeSel = ref<string[]>([]);
const selSet = computed(() => new Set(nodeSel.value));
const editing = ref<Sel | null>(null);
const editIsNew = ref(false);
const draft = ref("");
const composing = ref(false);
const sink = ref<HTMLTextAreaElement | null>(null);
const newEdgeStyle = ref<FlowEdgeStyle>("arrow");
const newEdgeRoute = ref<EdgeRoute>("elbow");

const selNode = computed(() => (selected.value?.type === "node" ? selected.value.id : null));
const selEdge = computed(() => (selected.value?.type === "edge" ? selected.value.key : null));

watch([version, nodeSel], () => emit("stats", doc.value.nodes.length, doc.value.edges.length, nodeSel.value.length), { immediate: true });

function focusSink() {
  sink.value?.focus({ preventScroll: true });
}

function select(s: Sel | null, mode: "only" | "add" | "toggle" = "only", focus = true) {
  if (s?.type === "node" && mode !== "only") {
    const has = selSet.value.has(s.id);
    if (mode === "toggle" && has) {
      nodeSel.value = nodeSel.value.filter((x) => x !== s.id);
      const last = nodeSel.value[nodeSel.value.length - 1];
      selected.value = last ? { type: "node", id: last } : null;
    } else {
      nodeSel.value = [...nodeSel.value.filter((x) => x !== s.id), s.id];
      selected.value = s;
    }
  } else {
    selected.value = s;
    nodeSel.value = s?.type === "node" ? [s.id] : [];
  }
  void nextTick(() => {
    if (focus) focusSink();
    if (s?.type === "node") scrollIntoView(s.id);
  });
}

function selectNodes(ids: string[]) {
  nodeSel.value = ids;
  const last = ids[ids.length - 1];
  selected.value = last ? { type: "node", id: last } : null;
}

function startEdit(s: Sel, replace: string | null, isNew = false) {
  if (props.readonly) return;
  const current = s.type === "node" ? findFlowNode(doc.value, s.id)?.text : edgeOf(s.key)?.label;
  if (current === undefined) return;
  selected.value = s;
  nodeSel.value = s.type === "node" ? [s.id] : [];
  editing.value = s;
  editIsNew.value = isNew;
  draft.value = replace ?? current;
  void nextTick(() => {
    focusSink();
    if (replace === null || isNew) sink.value?.select();
  });
}

function finishEdit(keep: boolean) {
  const s = editing.value;
  if (!s) return;
  editing.value = null;
  const raw = draft.value;
  draft.value = "";
  if (!keep) return;
  if (s.type === "node") {
    const text = raw.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
    const node = findFlowNode(doc.value, s.id);
    if (!node) return;
    if (!text) {
      if (editIsNew.value) mutate((d) => removeFlowNode(d, s.id), false);
      return;
    }
    if (text !== node.text) mutate((d) => void (findFlowNode(d, s.id)!.text = text), !editIsNew.value);
  } else {
    const text = raw.replace(/\s*\n\s*/g, " ").trim();
    const edge = edgeOf(s.key);
    if (edge && text !== edge.label) mutate((d) => void (d.edges.find((e) => e.key === s.key)!.label = text));
  }
}

const snapGrid = (v: number) => Math.round(v / GRID) * GRID;

/** 新建节点（shape 为 null 时是文字）；from 不为空时同时从它连一条线过去 */
function addNode(shape: FlowShape | null, at: { x: number; y: number }, from: string | null = null, sides: { from?: Side; to?: Side } = {}) {
  if (props.readonly) return;
  let id = "";
  mutate((d) => {
    id = addFlowNode(d, shape ?? "rect", shape ? NEW_TEXT : TEXT_TEXT, { x: snapGrid(at.x), y: snapGrid(at.y) }, !shape);
    if (from) addFlowEdge(d, from, id, newEdgeStyle.value, newEdgeRoute.value, sides);
  });
  startEdit({ type: "node", id }, null, true);
  void nextTick(() => scrollIntoView(id));
}

/** 当前看得见的区域的中心（图坐标） */
function viewCenter() {
  const el = host.value;
  if (!el) return { x: 0, y: 0 };
  const z = props.zoom;
  return { x: (el.scrollLeft + el.clientWidth / 2) / z - originX.value, y: (el.scrollTop + el.clientHeight / 2) / z - originY.value };
}

/** 在节点 b 的 side 方向隔一段距离放一个新节点的位置；那里已有节点时沿垂直方向错开 */
function besidePos(b: FlowBox, side: Side, shape: FlowShape | null): { x: number; y: number } {
  const m = measureNode(shape ? NEW_TEXT : TEXT_TEXT, shape ?? "rect", undefined, !shape);
  const [nx, ny] = NORMAL[side];
  const base = { x: b.cx + nx * (b.w / 2 + GAP + m.w / 2), y: b.cy + ny * (b.h / 2 + GAP + m.h / 2) };
  const step = nx ? m.h + 30 : m.w + 30;
  const free = (p: { x: number; y: number }) =>
    ![...geo.value.boxes.values()].some((o) => Math.abs(o.cx - p.x) < (o.w + m.w) / 2 + 10 && Math.abs(o.cy - p.y) < (o.h + m.h) / 2 + 10);
  for (let k = 0; k < 12; k++) {
    const off = k === 0 ? 0 : Math.ceil(k / 2) * step * (k % 2 ? 1 : -1);
    const p = nx ? { x: base.x, y: base.y + off } : { x: base.x + off, y: base.y };
    if (free(p)) return p;
  }
  return base;
}

/** 快速延伸：在 side 方向新建一个同形状的节点并连上 */
function extend(fromId: string, side: Side) {
  const b = box(fromId);
  const n = findFlowNode(doc.value, fromId);
  if (!b || !n || props.readonly) return;
  const shape = n.isText ? "rect" : n.shape;
  addNode(shape, besidePos(b, side, shape), fromId, { from: side, to: opposite(side) });
}

/** Tab：沿选中节点最后一条出线的方向新建下一个节点；没有出线时沿进线的方向，都没有时按文件里的方向 */
function addNext() {
  const id = selNode.value;
  const b = id ? box(id) : undefined;
  if (!id || !b) return addNode("rect", viewCenter());
  const out = [...doc.value.edges].reverse().find((e) => e.from === id && e.to !== id);
  const inc = [...doc.value.edges].reverse().find((e) => e.to === id && e.from !== id);
  let side: Side = DIR_SIDE[doc.value.dir];
  if (out) {
    const target = box(out.to);
    side = out.fromSide ?? (target ? facing(b, target)[0] : side);
  } else if (inc) {
    const up = box(inc.from);
    side = inc.toSide ? opposite(inc.toSide) : up ? facing(up, b)[0] : side;
  }
  extend(id, side);
}

/** Enter：新建兄弟节点，放在选中节点旁边，连在同一个上游节点上 */
function addBrother() {
  const id = selNode.value;
  const b = id ? box(id) : undefined;
  if (!id || !b || props.readonly) return;
  const inc = doc.value.edges.find((e) => e.to === id && e.from !== id);
  const up = inc ? box(inc.from) : undefined;
  const flow = inc?.fromSide ?? (up ? facing(up, b)[0] : DIR_SIDE[doc.value.dir]);
  const beside: Side = flow === "top" || flow === "bottom" ? "right" : "bottom";
  const shape = findFlowNode(doc.value, id)!.isText ? "rect" : findFlowNode(doc.value, id)!.shape;
  const pos = besidePos(b, beside, shape);
  if (inc) addNode(shape, pos, inc.from, { from: inc.fromSide, to: inc.toSide });
  else addNode(shape, pos);
}

/** 工具栏“图形”下拉：在视图中央新建 */
function insertShape(shape: FlowShape) {
  shapeMenu.value = false;
  addNode(shape, viewCenter());
}

/** 格式区的形状：把选中的节点改为该形状 */
function changeShape(shape: FlowShape) {
  const ids = nodeSel.value;
  if (!ids.length) return;
  if (ids.some((id) => { const n = findFlowNode(doc.value, id); return n?.shape !== shape || n.isText; })) {
    mutate((d) => ids.forEach((id) => {
      const n = findFlowNode(d, id)!;
      n.shape = shape;
      delete n.isText;
    }));
  }
  focusSink();
}

function setEdgeStyle(style: FlowEdgeStyle) {
  const key = selEdge.value;
  if (key) {
    if (edgeOf(key)?.style !== style) mutate((d) => void (d.edges.find((e) => e.key === key)!.style = style));
  } else newEdgeStyle.value = style;
  focusSink();
}

function setRoute(route: EdgeRoute) {
  const key = selEdge.value;
  if (key) {
    if ((edgeOf(key)?.route ?? "elbow") !== route) {
      mutate((d) => {
        const e = d.edges.find((x) => x.key === key)!;
        if (route === "elbow") delete e.route;
        else e.route = route;
      });
    }
  } else newEdgeRoute.value = route;
  focusSink();
}

function align(mode: AlignMode) {
  const ids = [...nodeSel.value];
  if (ids.length < 2) return;
  mutate((d) => alignNodes(d, ids, mode));
  focusSink();
}

/** AI 整理：AI 决定方向、分层和每层里的先后，程序算出位置 */
const aiJob = ref<AiRun | null>(null);

async function aiArrange() {
  if (props.readonly || aiJob.value || !doc.value.nodes.length) return;
  const ai = useAiStore();
  const notice = useNoticeStore();
  if (!ai.ensureConfigured()) return;
  const messages = arrangeMessages(doc.value);
  const tokens = messagesTokens(messages);
  const budget = ai.defaultBudget();
  if (tokens > budget) {
    notice.report("AI 整理失败", `流程图过大（约 ${formatTokens(tokens)} tokens，当前模型最多可发送约 ${formatTokens(budget)} tokens）`);
    return;
  }
  const job = ai.run(messages, () => {});
  aiJob.value = job;
  try {
    const text = await job.done;
    // 等待期间图可能被改过：按现在的节点解析，删掉的忽略，新加的放进最后一层
    const plan = parseArrange(text, doc.value);
    mutate((d) => arrange(d, plan.dir, plan.layers));
    const undoKey = displayShortcut(shortcutOf("diagram.undo"));
    notice.inform(`已按 AI 的建议重新排列（${dirLabel(plan.dir)}）${undoKey ? `，${undoKey} 撤销` : ""}`);
    void nextTick(center);
  } catch (e) {
    if (!(e instanceof AiCancelled)) notice.report("AI 整理失败", e);
  } finally {
    aiJob.value = null;
  }
}

function stopAi() {
  aiJob.value?.cancel();
}

function setCanvas(patch: Partial<CanvasStyle>) {
  const next: CanvasStyle = { ...doc.value.canvas, ...patch };
  for (const k of Object.keys(next) as (keyof CanvasStyle)[]) if (next[k] === undefined) delete next[k];
  if (JSON.stringify(next) !== JSON.stringify(doc.value.canvas)) mutate((d) => void (d.canvas = next));
}

function applyStyle(patch: Partial<NodeStyle>) {
  const ids = [...nodeSel.value];
  mutate((d) => {
    for (const id of ids) {
      const n = findFlowNode(d, id);
      if (n) n.style = patchStyle(n.style, patch);
    }
  });
}

/** 恢复默认样式，同时恢复自动大小 */
function resetStyle() {
  const ids = nodeSel.value.filter((id) => { const n = findFlowNode(doc.value, id); return n?.style || n?.w; });
  if (ids.length) {
    mutate((d) => ids.forEach((id) => {
      const n = findFlowNode(d, id)!;
      delete n.style;
      delete n.w;
      delete n.h;
    }));
  }
}

const focusNode = computed(() => {
  void version.value;
  return selNode.value ? findFlowNode(doc.value, selNode.value) : undefined;
});
const focusStyle = computed(() => focusNode.value?.style);
const edgeFormat = computed(() => {
  void version.value;
  const e = selEdge.value ? edgeOf(selEdge.value) : undefined;
  return e ? { route: e.route ?? "elbow", style: e.style } : null;
});

/* ---------- 格式刷：单击刷一次，双击连续刷；同时刷形状和大小 ---------- */
const painter = ref<"off" | "once" | "sticky">("off");
let painterSrc: { style?: NodeStyle; shape: FlowShape; isText?: boolean; w?: number; h?: number } | null = null;

function setPainter(mode: "off" | "once" | "sticky") {
  if (mode !== "off") {
    const n = focusNode.value;
    if (!n) return;
    painterSrc = structuredClone({ style: n.style, shape: n.shape, isText: n.isText, w: n.w, h: n.h });
  }
  painter.value = mode;
  focusSink();
}

function paint(ids: string[]) {
  const src = painterSrc;
  if (!src || !ids.length) return;
  mutate((d) => ids.forEach((id) => {
    const n = findFlowNode(d, id);
    if (!n) return;
    n.shape = src.shape;
    if (src.style) n.style = { ...src.style };
    else delete n.style;
    if (src.isText) n.isText = true;
    else delete n.isText;
    if (src.w && src.h) {
      n.w = src.w;
      n.h = src.h;
    } else {
      delete n.w;
      delete n.h;
    }
  }));
  if (painter.value === "once") painter.value = "off";
}

function deleteSelected() {
  const s = selected.value;
  if (!s) return;
  if (s.type === "node") {
    const ids = [...nodeSel.value];
    mutate((d) => ids.forEach((id) => removeFlowNode(d, id)));
  } else mutate((d) => removeFlowEdge(d, s.key));
  selected.value = null;
  nodeSel.value = [];
}

/** 方向键移动选中的节点 */
function nudge(key: string, big: boolean) {
  const ids = nodeSel.value;
  const v = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
  if (!ids.length || !v) return;
  const step = big ? GRID * 5 : GRID;
  const set = new Set(ids);
  mutate((d) => {
    ids.forEach((id) => {
      const n = findFlowNode(d, id)!;
      n.x = (n.x ?? 0) + v[0] * step;
      n.y = (n.y ?? 0) + v[1] * step;
    });
    for (const e of d.edges) {
      if (e.bends && e.fromSide && set.has(e.from) && set.has(e.to)) e.bends = shiftBends(e.bends, e.fromSide, v[0] * step, v[1] * step);
    }
  });
  void nextTick(() => scrollIntoView(ids[ids.length - 1]));
}

/* ---------- 复制、剪切、粘贴、克隆 ---------- */
/** 鼠标最后停在画布上的位置（图坐标），粘贴到这里 */
let lastPointer: { x: number; y: number } | null = null;

function copySelection(cut: boolean, e?: ClipboardEvent) {
  const ids = [...nodeSel.value];
  if (!ids.length) return;
  const frag = copyFragment(doc.value, ids);
  const text = fragmentToText(frag);
  remember({ kind: "flow", text, frag });
  if (e?.clipboardData) {
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  } else void navigator.clipboard?.writeText(text).catch(() => {});
  if (cut && !props.readonly) deleteSelected();
}

function pasteText(text: string, at?: { x: number; y: number }) {
  if (props.readonly || !text.trim()) return;
  const clip = recall("flow", text);
  const frag = clip ? clip.frag : textToFragment(text);
  if (!frag.nodes.length) return;
  let ids: string[] = [];
  mutate((d) => {
    ids = pasteFragment(d, frag, { at: at ?? lastPointer ?? viewCenter() });
  });
  selectNodes(ids);
  void nextTick(() => scrollIntoView(ids[ids.length - 1]));
}

function onCopy(e: ClipboardEvent) {
  if (!editing.value) copySelection(false, e);
}

function onCut(e: ClipboardEvent) {
  if (!editing.value) copySelection(true, e);
}

function onPaste(e: ClipboardEvent) {
  if (editing.value) return;
  e.preventDefault();
  pasteText(e.clipboardData?.getData("text/plain") ?? "");
}

async function pasteFromMenu(at?: { x: number; y: number }) {
  try {
    pasteText(await navigator.clipboard.readText(), at);
  } catch (err) {
    useNoticeStore().report("读取剪贴板失败", err);
  }
}

function duplicate() {
  const ids = [...nodeSel.value];
  if (props.readonly || !ids.length) return;
  let made: string[] = [];
  mutate((d) => {
    made = pasteFragment(d, copyFragment(d, ids), { offset: GRID * 2 });
  });
  selectNodes(made);
}

function selectAll() {
  selectNodes(doc.value.nodes.map((n) => n.id));
}

function run(action: DiagramAction) {
  if (editing.value) finishEdit(true);
  switch (action) {
    case "addChild": return addNext();
    case "addSibling": return addBrother();
    case "edit":
      if (selected.value) startEdit(selected.value, null);
      return;
    case "delete": return deleteSelected();
    case "undo": return undo();
    case "redo": return redo();
    case "center": return center();
    case "aiArrange": return void aiArrange();
    case "duplicate": return duplicate();
    case "zoomFit": return zoomFit();
    case "zoom100": return zoomTo(1);
    case "addSiblingBefore":
    case "addParent":
    case "toggleFold":
    case "summary":
      return;
  }
}

const space = { down: false, used: false };
const panReady = ref(false);

function onKey(e: KeyboardEvent) {
  if (editing.value) {
    if (composing.value || e.isComposing) return;
    // 节点文字 Shift+Enter 换行，交给输入框
    if (e.key === "Enter" && e.shiftKey && editing.value.type === "node") return;
    if (e.key === "Enter") {
      e.preventDefault();
      finishEdit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishEdit(false);
    }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  // 复制、剪切、粘贴交给系统的剪贴板事件（onCopy / onCut / onPaste）
  if (mod && !e.altKey && !e.shiftKey && ["c", "x", "v"].includes(e.key.toLowerCase())) return;
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
    e.preventDefault();
    selectAll();
    return;
  }
  if (e.key === " ") {
    e.preventDefault();
    if (!e.repeat && !space.down) {
      space.down = true;
      space.used = false;
      panReady.value = true;
    }
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    if (aiJob.value) stopAi();
    else if (picker.value) closePicker();
    else if (painter.value !== "off") painter.value = "off";
    else select(null);
    return;
  }
  const cmd = dispatchShortcut(e, "diagram");
  if (cmd) {
    e.preventDefault();
    e.stopPropagation();
    void cmd.run();
    return;
  }
  if (e.key.startsWith("Arrow")) {
    e.preventDefault();
    nudge(e.key, e.shiftKey);
    return;
  }
  if (e.key === "Backspace") {
    e.preventDefault();
    deleteSelected();
    return;
  }
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  if ((printable || e.key === "Process") && selected.value && !props.readonly) startEdit(selected.value, "");
  else e.preventDefault();
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key === " ") resetSpace();
}

function resetSpace() {
  space.down = false;
  panReady.value = false;
}

function onCompositionStart() {
  composing.value = true;
  if (!editing.value && selected.value && !props.readonly) startEdit(selected.value, "");
}

function onBlur() {
  resetSpace();
  if (editing.value && !press) finishEdit(true);
}

const sinkStyle = computed(() => {
  const z = props.zoom;
  const s = editing.value ?? selected.value;
  let rect = { x: 0, y: 0, w: 120, h: 30 };
  let size = 13;
  let weight = 400;
  const lines = Math.max(1, draft.value.split("\n").length);
  if (s?.type === "node" && box(s.id)) {
    const b = box(s.id)!;
    const w = Math.max(b.w, 140);
    size = b.size;
    weight = b.weight;
    rect = { x: b.cx - w / 2, y: b.cy - (b.lineH * lines) / 2 - 5, w, h: b.lineH * lines + 10 };
  } else if (s?.type === "edge") {
    const r = routeOf(s.key);
    const p = r?.label ?? (r ? { x: r.points[Math.floor(r.points.length / 2)].x - 60, y: r.points[Math.floor(r.points.length / 2)].y - 12 } : null);
    if (p) rect = { x: p.x - 20, y: p.y - 4, w: 160, h: 28 };
  }
  return {
    left: `${(originX.value + rect.x) * z}px`,
    top: `${(originY.value + rect.y) * z}px`,
    width: `${rect.w * z}px`,
    minHeight: `${rect.h * z}px`,
    padding: `${5 * z}px ${8 * z}px`,
    fontSize: `${size * z}px`,
    lineHeight: `${Math.round(size * 1.46) * z}px`,
    fontWeight: String(weight),
    textAlign: "center" as const,
  };
});

/* ---------- 鼠标 ---------- */
type Pt = { x: number; y: number };
type Corner = "nw" | "ne" | "sw" | "se";
type Press =
  | { kind: "pan"; x: number; y: number; sx: number; sy: number; moved: boolean }
  | { kind: "marquee"; x: number; y: number; start: Pt; base: string[]; moved: boolean }
  | { kind: "move"; x: number; y: number; start: Pt; origin: Map<string, Pt>; bends: Map<string, number[]>; primary: string; moved: boolean }
  | { kind: "connect"; from: string; side?: Side; x: number; y: number; moved: boolean }
  | { kind: "arrow"; from: string; side: Side; x: number; y: number; moved: boolean }
  | { kind: "resize"; id: string; corner: Corner; fixed: Pt; ratio: number; x: number; y: number; moved: boolean }
  | { kind: "reconnect"; key: string; end: "from" | "to"; x: number; y: number; moved: boolean }
  | {
    kind: "bend"; key: string; bends: number[]; index: number; axis: "x" | "y"; sides: { from: Side; to: Side };
    start: Pt; snaps: number[]; x: number; y: number; moved: boolean;
  };
let press: Press | null = null;
/** 当前按下的是哪种拖动，供模板显示提示 */
const mode = ref<Press["kind"] | null>(null);
const pointer = ref<Pt | null>(null);
const hover = ref<string | null>(null);
/** 鼠标所在的节点：显示快速延伸的箭头 */
const hoverNode = ref<string | null>(null);
const marquee = ref<{ x: number; y: number; w: number; h: number } | null>(null);
/** 拖动时的对齐线 */
const guides = ref<{ x?: number; y?: number }[]>([]);
/** 松开到空白处后弹出的图形选框 */
const picker = ref<{ from: string; side?: Side; at: Pt } | null>(null);

function toCanvas(e: { clientX: number; clientY: number }): Pt {
  const r = host.value!.getBoundingClientRect();
  return {
    x: (e.clientX - r.left + host.value!.scrollLeft) / props.zoom - originX.value,
    y: (e.clientY - r.top + host.value!.scrollTop) / props.zoom - originY.value,
  };
}

function nodeAt(p: Pt): string | null {
  const list = [...geo.value.boxes.values()];
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    if (Math.abs(p.x - b.cx) <= b.w / 2 + 4 && Math.abs(p.y - b.cy) <= b.h / 2 + 4) return b.id;
  }
  return null;
}

function closePicker() {
  picker.value = null;
  pointer.value = null;
  focusSink();
}

/** 在图形选框里选了图形：新节点接在预览线的末端，接边方向和预览线一致 */
function pick(shape: FlowShape | null) {
  const p = picker.value;
  const line = preview.value;
  if (!p) return;
  picker.value = null;
  pointer.value = null;
  const toSide = line ? approachSide(line.points) : opposite(p.side ?? "bottom");
  const m = measureNode(shape ? NEW_TEXT : TEXT_TEXT, shape ?? "rect", undefined, !shape);
  const [nx, ny] = NORMAL[toSide];
  const at = { x: p.at.x - nx * (m.w / 2), y: p.at.y - ny * (m.h / 2) };
  addNode(shape, at, p.from, { from: line?.fromSide ?? p.side, to: toSide });
}

/** 改连线某一端接在哪一边；side 为 undefined 时改回自动 */
function setEdgeSide(key: string, end: "from" | "to", side: Side | undefined) {
  const prop = end === "from" ? "fromSide" : "toSide";
  if (edgeOf(key)?.[prop] === side) return;
  mutate((d) => {
    const e = d.edges.find((x) => x.key === key);
    if (!e) return;
    if (side) e[prop] = side;
    else delete e[prop];
    delete e.bends;
  });
  focusSink();
}

/** 去掉手动拖过的走线，改回自动 */
function resetBends(key: string) {
  if (!edgeOf(key)?.bends) return;
  mutate((d) => {
    const e = d.edges.find((x) => x.key === key);
    if (e) delete e.bends;
  });
  focusSink();
}

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0 && e.button !== 1) return;
  const el = e.target as Element;
  if (editing.value) finishEdit(true);
  if (picker.value) {
    picker.value = null;
    pointer.value = null;
  }
  e.preventDefault();
  const at = { x: e.clientX, y: e.clientY };
  if (e.button === 1 || space.down) {
    space.used = true;
    press = { kind: "pan", ...at, sx: host.value!.scrollLeft, sy: host.value!.scrollTop, moved: false };
  } else {
    const arrow = el.closest<SVGElement>("[data-arrow]");
    const corner = el.closest<SVGElement>("[data-corner]")?.dataset.corner as Corner | undefined;
    const end = el.closest<SVGElement>("[data-end]");
    const seg = el.closest<SVGElement>("[data-seg]");
    const node = el.closest<SVGElement>("[data-id]")?.dataset.id;
    const edge = el.closest<SVGElement>("[data-edge]")?.dataset.edge;
    if (arrow && !props.readonly) {
      press = { kind: "arrow", from: arrow.dataset.node!, side: arrow.dataset.arrow as Side, ...at, moved: false };
    } else if (corner && selNode.value && !props.readonly) {
      const b = box(selNode.value)!;
      const fx = corner.includes("w") ? b.cx + b.w / 2 : b.cx - b.w / 2;
      const fy = corner.includes("n") ? b.cy + b.h / 2 : b.cy - b.h / 2;
      press = { kind: "resize", id: selNode.value, corner, fixed: { x: fx, y: fy }, ratio: b.w / b.h, ...at, moved: false };
    } else if (end && selEdge.value && !props.readonly) {
      press = { kind: "reconnect", key: selEdge.value, end: end.dataset.end as "from" | "to", ...at, moved: false };
    } else if (node) {
      if (painter.value !== "off") {
        paint(selSet.value.has(node) && nodeSel.value.length > 1 ? [...nodeSel.value] : [node]);
        return focusSink();
      }
      const toggle = e.ctrlKey || e.metaKey;
      if (toggle) select({ type: "node", id: node }, "toggle");
      else if (e.shiftKey) select({ type: "node", id: node }, "add");
      else if (!selSet.value.has(node)) select({ type: "node", id: node });
      else {
        selected.value = { type: "node", id: node };
        focusSink();
      }
      if (toggle || props.readonly || !selSet.value.has(node)) return;
      const origin = new Map(nodeSel.value.map((id) => {
        const n = findFlowNode(doc.value, id)!;
        return [id, { x: n.x ?? 0, y: n.y ?? 0 }] as const;
      }));
      const bends = new Map(doc.value.edges.filter((x) => x.bends && origin.has(x.from) && origin.has(x.to)).map((x) => [x.key, x.bends!] as const));
      press = { kind: "move", ...at, start: toCanvas(e), origin, bends, primary: node, moved: false };
    } else if (seg && selEdge.value && !props.readonly) {
      press = startBend(selEdge.value, Number(seg.dataset.seg), e);
      if (!press) return;
    } else if (edge) {
      select({ type: "edge", key: edge });
      const r = routeOf(edge);
      press = r && !props.readonly ? startBend(edge, nearestSegment(r.points, toCanvas(e)), e) : null;
      if (!press) return;
    } else {
      press = { kind: "marquee", ...at, start: toCanvas(e), base: e.ctrlKey || e.metaKey ? [...nodeSel.value] : [], moved: false };
      focusSink();
    }
  }
  mode.value = press.kind;
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
}

/** 拖动节点：对齐网格，靠近其他节点的中线或边时吸附；按住 Alt 不吸附 */
function moveTo(p: Extract<Press, { kind: "move" }>, now: Pt, free: boolean) {
  const dx = now.x - p.start.x;
  const dy = now.y - p.start.y;
  const o = p.origin.get(p.primary)!;
  const me = box(p.primary)!;
  let x = o.x + dx;
  let y = o.y + dy;
  const lines: { x?: number; y?: number }[] = [];
  if (!free) {
    x = snapGrid(x);
    y = snapGrid(y);
    let bestX: { d: number; v: number; line: number } | null = null;
    let bestY: { d: number; v: number; line: number } | null = null;
    for (const b of geo.value.boxes.values()) {
      if (p.origin.has(b.id)) continue;
      for (const [mine, theirs] of [[0, 0], [-me.w / 2, -b.w / 2], [me.w / 2, b.w / 2], [-me.w / 2, b.w / 2], [me.w / 2, -b.w / 2]]) {
        const target = b.cx + theirs;
        const d = Math.abs(o.x + dx + mine - target);
        if (d <= SNAP && (!bestX || d < bestX.d)) bestX = { d, v: target - mine, line: target };
      }
      for (const [mine, theirs] of [[0, 0], [-me.h / 2, -b.h / 2], [me.h / 2, b.h / 2], [-me.h / 2, b.h / 2], [me.h / 2, -b.h / 2]]) {
        const target = b.cy + theirs;
        const d = Math.abs(o.y + dy + mine - target);
        if (d <= SNAP && (!bestY || d < bestY.d)) bestY = { d, v: target - mine, line: target };
      }
    }
    if (bestX) {
      x = bestX.v;
      lines.push({ x: bestX.line });
    }
    if (bestY) {
      y = bestY.v;
      lines.push({ y: bestY.line });
    }
  }
  guides.value = lines;
  const ddx = x - o.x;
  const ddy = y - o.y;
  const d = doc.value;
  for (const [id, pos] of p.origin) {
    const n = findFlowNode(d, id);
    if (!n) continue;
    n.x = Math.round(pos.x + ddx);
    n.y = Math.round(pos.y + ddy);
  }
  for (const [key, bends] of p.bends) {
    const e = d.edges.find((x) => x.key === key);
    if (e?.fromSide) e.bends = shiftBends(bends, e.fromSide, ddx, ddy);
  }
  version.value++;
}

/** 离点 p 最近的那一段折线 */
function nearestSegment(points: Pt[], p: Pt): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2));
    const d = Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** 按住连线的某一段准备拖动；直线走线和连回自己的线不能拖 */
function startBend(key: string, seg: number, e: MouseEvent): Press | null {
  const edge = edgeOf(key);
  const r = routeOf(key);
  if (!edge || !r || edge.from === edge.to || (edge.route ?? "elbow") === "straight") return null;
  const h = bendHandle(r.points, seg);
  if (!h) return null;
  const first = r.points[0];
  const last = r.points[r.points.length - 1];
  return {
    kind: "bend", key, ...h, sides: sidesOf(r.points), start: toCanvas(e), snaps: [first[h.axis], last[h.axis]],
    x: e.clientX, y: e.clientY, moved: false,
  };
}

/** 拖动连线的一段：沿垂直方向平移；靠近两端的位置时吸附（拉直），否则对齐网格；按住 Alt 不吸附 */
function bendTo(p: Extract<Press, { kind: "bend" }>, now: Pt, free: boolean) {
  const e = doc.value.edges.find((x) => x.key === p.key);
  if (!e) return;
  let v = p.bends[p.index] + now[p.axis] - p.start[p.axis];
  if (!free) v = p.snaps.find((s) => Math.abs(s - v) <= SNAP) ?? snapGrid(v);
  e.bends = p.bends.map((c, i) => (i === p.index ? v : c));
  e.fromSide = p.sides.from;
  e.toSide = p.sides.to;
  version.value++;
}

/** 拖动角上的手柄调整大小：对角固定；Shift 保持比例；Alt 不对齐网格 */
function resizeTo(p: Extract<Press, { kind: "resize" }>, now: Pt, keepRatio: boolean, free: boolean) {
  let px = free ? now.x : snapGrid(now.x);
  let py = free ? now.y : snapGrid(now.y);
  let w = Math.max(MIN_W, Math.abs(px - p.fixed.x));
  let h = Math.max(MIN_H, Math.abs(py - p.fixed.y));
  if (keepRatio) {
    if (w / h > p.ratio) h = w / p.ratio;
    else w = h * p.ratio;
  }
  px = p.fixed.x + (p.corner.includes("w") ? -w : w);
  py = p.fixed.y + (p.corner.includes("n") ? -h : h);
  const n = findFlowNode(doc.value, p.id);
  if (!n) return;
  n.w = Math.round(w);
  n.h = Math.round(h);
  n.x = Math.round((p.fixed.x + px) / 2);
  n.y = Math.round((p.fixed.y + py) / 2);
  version.value++;
}

function onMouseMove(e: MouseEvent) {
  if (!press) return;
  const dx = e.clientX - press.x;
  const dy = e.clientY - press.y;
  if (!press.moved && Math.hypot(dx, dy) < 4) return;
  if (!press.moved && (press.kind === "move" || press.kind === "resize" || press.kind === "bend")) snapshot();
  // 拖动快速延伸的箭头：拉连线
  if (press.kind === "arrow") {
    press = { kind: "connect", from: press.from, side: press.side, x: press.x, y: press.y, moved: true };
    mode.value = "connect";
  }
  press.moved = true;
  if (press.kind === "pan") {
    host.value!.scrollLeft = press.sx - dx;
    host.value!.scrollTop = press.sy - dy;
    return;
  }
  const p = toCanvas(e);
  if (press.kind === "move") return moveTo(press, p, e.altKey);
  if (press.kind === "resize") return resizeTo(press, p, e.shiftKey, e.altKey);
  if (press.kind === "bend") return bendTo(press, p, e.altKey);
  if (press.kind === "marquee") {
    const s = press.start;
    const r = { x: Math.min(p.x, s.x), y: Math.min(p.y, s.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
    marquee.value = r;
    const hit = [...geo.value.boxes.values()]
      .filter((b) => b.cx - b.w / 2 < r.x + r.w && b.cx + b.w / 2 > r.x && b.cy - b.h / 2 < r.y + r.h && b.cy + b.h / 2 > r.y)
      .map((b) => b.id);
    const base = press.base;
    selectNodes([...base, ...hit.filter((id) => !base.includes(id))]);
    return;
  }
  pointer.value = p;
  const over = nodeAt(p);
  hover.value = press.kind === "connect" && over === press.from ? null : over;
}

function onMouseUp() {
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
  const p = press;
  const target = hover.value;
  const at = pointer.value;
  press = null;
  mode.value = null;
  hover.value = null;
  marquee.value = null;
  guides.value = [];
  if (!p) return;
  if (p.kind === "move" || p.kind === "resize") {
    if (p.moved) commit();
    // 按住多选中的一个节点没有拖动：只选它
    else if (p.kind === "move" && nodeSel.value.length > 1) select({ type: "node", id: p.primary });
    return focusSink();
  }
  if (p.kind === "bend") {
    // 松开后按实际画出的折线重新记录中间段，去掉拖成一条直线的多余拐点
    const e = p.moved ? doc.value.edges.find((x) => x.key === p.key) : undefined;
    const r = e && routeOf(p.key);
    const a = e && box(e.from);
    const b = e && box(e.to);
    if (e && r && a && b) {
      const bends = bendsOf(r.points);
      const same = JSON.stringify(routePoints(a, b, e.route ?? "elbow", { from: e.fromSide, to: e.toSide, bends })) === JSON.stringify(r.points);
      if (same && bends.length) e.bends = bends;
      else if (same) delete e.bends;
      commit();
    }
    return focusSink();
  }
  if (p.kind === "arrow") {
    extend(p.from, p.side);
    return;
  }
  if (p.kind === "marquee") {
    // 点空白处（没有拖出选框）取消选中；格式刷时把框住的节点都刷上
    if (!p.moved && !p.base.length) select(null);
    else if (p.moved && painter.value !== "off") paint([...nodeSel.value]);
    return focusSink();
  }
  if (p.kind === "pan" || !p.moved) {
    pointer.value = null;
    return focusSink();
  }
  if (p.kind === "connect") {
    if (target && at) {
      pointer.value = null;
      let key: string | null = null;
      const toSide = sideNear(box(target)!, at);
      mutate((d) => {
        key = addFlowEdge(d, p.from, target, newEdgeStyle.value, newEdgeRoute.value, { from: p.side, to: toSide });
      });
      if (key) select({ type: "edge", key });
    } else if (at) {
      picker.value = { from: p.from, side: p.side, at };
    }
    return;
  }
  pointer.value = null;
  if (target && at) mutate((d) => void reconnectEdge(d, p.key, p.end, target, sideNear(box(target)!, at)));
  focusSink();
}

/** 没按键时记录鼠标所在的节点，显示它的快速延伸箭头 */
function onHover(e: MouseEvent) {
  const p = toCanvas(e);
  lastPointer = p;
  if (press || picker.value) return;
  const over = nodeAt(p);
  // 移到箭头上时保持显示
  if (!over && (e.target as Element).closest("[data-arrow]")) return;
  hoverNode.value = over;
}

function onDblClick(e: MouseEvent) {
  const el = e.target as Element;
  const node = el.closest<SVGElement>("[data-id]");
  const edge = el.closest<SVGElement>("[data-edge]");
  if (node?.dataset.id) startEdit({ type: "node", id: node.dataset.id }, null);
  else if (edge?.dataset.edge) startEdit({ type: "edge", key: edge.dataset.edge }, null);
  else if (!el.closest(".flow-handle, [data-arrow], [data-corner]")) addNode(null, toCanvas(e));
}

const ctxMenu = useContextMenuStore();
function onContextMenu(e: MouseEvent) {
  const el = e.target as Element;
  const node = el.closest<SVGElement>("[data-id]")?.dataset.id;
  const edge = el.closest<SVGElement>("[data-edge]")?.dataset.edge;
  e.preventDefault();
  if (editing.value) finishEdit(true);
  const ro = !!props.readonly;
  const at = toCanvas(e);
  if (!node && !edge) {
    ctxMenu.show(e, [
      { kind: "sub", label: "新建图形", items: FLOW_SHAPES.map((s): MenuEntry => ({ kind: "item", label: SHAPE_INFO[s].label, disabled: ro, action: () => addNode(s, at) })) },
      { kind: "item", label: "新建文字", disabled: ro, action: () => addNode(null, at) },
      { kind: "sep" },
      { kind: "item", label: "粘贴", hint: "Ctrl+V", disabled: ro, action: () => pasteFromMenu(at) },
      { kind: "item", label: "全选", hint: "Ctrl+A", action: () => selectAll() },
      { kind: "sep" },
      { kind: "item", label: "适应窗口", command: "diagram.zoomFit" },
    ]);
    return;
  }
  if (ro) return;
  if (edge) {
    select({ type: "edge", key: edge });
    const sideItems = (end: "from" | "to"): MenuEntry[] => {
      const prop = end === "from" ? "fromSide" : "toSide";
      return [
        { kind: "item", label: "自动", checked: () => !edgeOf(edge)?.[prop], action: () => setEdgeSide(edge, end, undefined) },
        { kind: "sep" },
        ...SIDE_LABELS.map(([s, label]): MenuEntry => ({ kind: "item", label, checked: () => edgeOf(edge)?.[prop] === s, action: () => setEdgeSide(edge, end, s) })),
      ];
    };
    ctxMenu.show(e, [
      { kind: "sub", label: "走线", items: ROUTES.map((r): MenuEntry => ({ kind: "item", label: r.label, checked: () => (edgeOf(edge)?.route ?? "elbow") === r.route, action: () => setRoute(r.route) })) },
      { kind: "sub", label: "线型", items: STYLES.map((s): MenuEntry => ({ kind: "item", label: s.label, checked: () => edgeOf(edge)?.style === s.style, action: () => setEdgeStyle(s.style) })) },
      { kind: "sub", label: "起点接在", items: sideItems("from") },
      { kind: "sub", label: "终点接在", items: sideItems("to") },
      { kind: "item", label: "重置走线", disabled: !edgeOf(edge)?.bends || !!props.readonly, action: () => resetBends(edge) },
      { kind: "item", label: "编辑文字", hint: "F2", action: () => startEdit({ type: "edge", key: edge }, null) },
      { kind: "sep" },
      { kind: "item", label: "删除", hint: "Delete", action: () => deleteSelected() },
    ]);
    return;
  }
  const id = node!;
  if (!selSet.value.has(id)) select({ type: "node", id });
  const many = nodeSel.value.length >= 2;
  ctxMenu.show(e, [
    { kind: "sub", label: "改为", items: FLOW_SHAPES.map((s): MenuEntry => ({ kind: "item", label: SHAPE_INFO[s].label, checked: () => { const n = findFlowNode(doc.value, id); return !n?.isText && n?.shape === s; }, action: () => changeShape(s) })) },
    { kind: "item", label: "编辑文字", hint: "F2", action: () => startEdit({ type: "node", id }, null) },
    { kind: "sep" },
    { kind: "item", label: "复制", hint: "Ctrl+C", action: () => copySelection(false) },
    { kind: "item", label: "剪切", hint: "Ctrl+X", action: () => copySelection(true) },
    { kind: "item", label: "粘贴", hint: "Ctrl+V", action: () => pasteFromMenu() },
    { kind: "item", label: "克隆", command: "diagram.duplicate" },
    ...(many
      ? [{ kind: "sub" as const, label: "对齐", items: ALIGNS.map((a): MenuEntry => ({ kind: "item", label: a.label, disabled: (a.mode === "hspace" || a.mode === "vspace") && nodeSel.value.length < 3, action: () => align(a.mode) })) }]
      : []),
    { kind: "sep" },
    { kind: "item", label: "删除", hint: "Delete", action: () => deleteSelected() },
  ]);
}

/* ---------- 工具栏“图形”下拉：点一下新建，或拖到画布上 ---------- */
const shapeMenu = ref(false);
const shapeDrag = ref<{ shape: FlowShape; x: number; y: number; moved: boolean } | null>(null);

function onShapeDown(shape: FlowShape, e: MouseEvent) {
  if (props.readonly || e.button !== 0) return;
  e.preventDefault();
  shapeDrag.value = { shape, x: e.clientX, y: e.clientY, moved: false };
  window.addEventListener("mousemove", onShapeMove);
  window.addEventListener("mouseup", onShapeUp);
}

function onShapeMove(e: MouseEvent) {
  const d = shapeDrag.value;
  if (!d) return;
  if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
  shapeDrag.value = { ...d, x: e.clientX, y: e.clientY, moved: true };
  shapeMenu.value = false;
}

function onShapeUp(e: MouseEvent) {
  window.removeEventListener("mousemove", onShapeMove);
  window.removeEventListener("mouseup", onShapeUp);
  const d = shapeDrag.value;
  shapeDrag.value = null;
  if (!d) return;
  if (!d.moved) return insertShape(d.shape);
  const r = host.value?.getBoundingClientRect();
  if (!r || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
  addNode(d.shape, toCanvas(e));
}

function onMenuOutside(e: MouseEvent) {
  if (shapeMenu.value && !(e.target as Element).closest(".flow-shape-menu, .flow-shape-btn")) shapeMenu.value = false;
}

/* ---------- 缩放与滚动 ---------- */
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
/** 缩放过程中不要因为图的范围变化去改滚动位置 */
let zooming = false;

/** 缩放到 z，at（窗口坐标）处的图保持不动；不给 at 时以画面中心为准 */
function zoomTo(z: number, at?: { clientX: number; clientY: number }) {
  const el = host.value;
  const next = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100;
  if (!el || next === props.zoom) return;
  const r = el.getBoundingClientRect();
  const ax = at ? at.clientX - r.left : el.clientWidth / 2;
  const ay = at ? at.clientY - r.top : el.clientHeight / 2;
  const gx = (el.scrollLeft + ax) / props.zoom - originX.value;
  const gy = (el.scrollTop + ay) / props.zoom - originY.value;
  zooming = true;
  emit("zoom", next);
  void nextTick(() => {
    el.scrollLeft = (originX.value + gx) * next - ax;
    el.scrollTop = (originY.value + gy) * next - ay;
    zooming = false;
  });
}

function stepZoom(dir: 1 | -1) {
  const z = props.zoom;
  const next = dir > 0 ? ZOOMS.find((v) => v > z + 0.001) : [...ZOOMS].reverse().find((v) => v < z - 0.001);
  if (next) zoomTo(next);
}

/** Ctrl+滚轮按档缩放；触控板捏合（小幅度、连续）平滑缩放 */
function onWheel(e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  if (Math.abs(e.deltaY) >= 50) {
    const z = props.zoom;
    const next = e.deltaY < 0 ? ZOOMS.find((v) => v > z + 0.001) : [...ZOOMS].reverse().find((v) => v < z - 0.001);
    if (next) zoomTo(next, e);
  } else zoomTo(props.zoom * Math.exp(-e.deltaY * 0.01), e);
}

/** 适应窗口：整张图放得下，最大 100% */
function zoomFit() {
  const el = host.value;
  if (!el) return;
  const z = Math.min(1, (el.clientWidth - 80) / Math.max(geo.value.width, 1), (el.clientHeight - 80) / Math.max(geo.value.height, 1));
  const next = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100;
  if (next !== props.zoom) emit("zoom", next);
  void nextTick(center);
}

function scrollIntoView(id: string) {
  const b = box(id);
  const el = host.value;
  if (!b || !el) return;
  const z = props.zoom;
  const left = (originX.value + b.cx - b.w / 2) * z;
  const top = (originY.value + b.cy - b.h / 2) * z;
  const pad = 40;
  if (left < el.scrollLeft + pad) el.scrollLeft = left - pad;
  else if (left + b.w * z > el.scrollLeft + el.clientWidth - pad) el.scrollLeft = left + b.w * z - el.clientWidth + pad;
  if (top < el.scrollTop + pad) el.scrollTop = top - pad;
  else if (top + b.h * z > el.scrollTop + el.clientHeight - pad) el.scrollTop = top + b.h * z - el.clientHeight + pad;
}
function scrollToEdge(key: string) {
  const r = routeOf(key);
  const el = host.value;
  if (!r || !el) return;
  const p = r.label ?? r.points[Math.floor(r.points.length / 2)];
  const z = props.zoom;
  const x = (originX.value + p.x) * z;
  const y = (originY.value + p.y) * z;
  if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - el.clientWidth / 2;
  if (y < el.scrollTop + 40 || y > el.scrollTop + el.clientHeight - 40) el.scrollTop = y - el.clientHeight / 2;
}
function center(focus = true) {
  const el = host.value;
  if (!el) return;
  const z = props.zoom;
  el.scrollLeft = (padX.value + geo.value.width / 2) * z - el.clientWidth / 2;
  el.scrollTop = (padY.value + geo.value.height / 2) * z - el.clientHeight / 2;
  if (focus) focusSink();
}

onMounted(() => {
  resize = new ResizeObserver(() => {
    viewW.value = host.value?.clientWidth ?? 800;
    viewH.value = host.value?.clientHeight ?? 600;
  });
  if (host.value) {
    resize.observe(host.value);
    viewW.value = host.value.clientWidth;
    viewH.value = host.value.clientHeight;
  }
  document.addEventListener("mousedown", onMenuOutside, true);
  void nextTick(() => {
    center();
    focusSink();
  });
});

onBeforeUnmount(() => {
  resize?.disconnect();
  document.removeEventListener("mousedown", onMenuOutside, true);
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
  window.removeEventListener("mousemove", onShapeMove);
  window.removeEventListener("mouseup", onShapeUp);
  stopAi();
  if (editing.value) finishEdit(true);
});

/** 从搜索结果打开时选中第一个包含该文字的节点，其次是连线 */
function selectText(text: string): boolean {
  const q = text.toLowerCase();
  const node = doc.value.nodes.find((n) => n.text.toLowerCase().includes(q));
  if (node) {
    select({ type: "node", id: node.id });
    return true;
  }
  const edge = doc.value.edges.find((e) => e.label.toLowerCase().includes(q));
  if (edge) select({ type: "edge", key: edge.key });
  return !!edge;
}

/* ---------- 查找与替换：节点文字和连线文字 ---------- */
const EDGE = "edge:";
const hits = ref<Set<string>>(new Set());

function matchesOf(pattern: RegExp): DiagramMatch[] {
  return findInItems(
    [...doc.value.nodes.map((n) => ({ id: n.id, text: n.text })), ...doc.value.edges.map((e) => ({ id: EDGE + e.key, text: e.label }))],
    pattern,
  );
}

function setText(d: FlowDoc, item: string, fn: (t: string) => string) {
  if (item.startsWith(EDGE)) {
    const e = d.edges.find((x) => x.key === item.slice(EDGE.length));
    if (e) e.label = fn(e.label).replace(/\s*\n\s*/g, " ").trim();
  } else {
    const n = findFlowNode(d, item);
    if (n) n.text = fn(n.text).split("\n").map((l) => l.trim()).filter(Boolean).join("\n") || NEW_TEXT;
  }
}

const find = {
  search(pattern: RegExp | null, current: number, sel: boolean): number {
    const ms = pattern ? matchesOf(pattern) : [];
    hits.value = new Set(ms.map((m) => m.item));
    const m = ms[current];
    if (sel && m) {
      if (m.item.startsWith(EDGE)) {
        const key = m.item.slice(EDGE.length);
        select({ type: "edge", key }, "only", false);
        void nextTick(() => scrollToEdge(key));
      } else select({ type: "node", id: m.item }, "only", false);
    }
    return ms.length;
  },
  replaceOne(current: number, pattern: RegExp, replacement: string, regex: boolean) {
    const m = matchesOf(pattern)[current];
    if (m) mutate((d) => setText(d, m.item, (t) => replaceMatches(t, [m], pattern, replacement, regex)));
  },
  replaceAll(pattern: RegExp, replacement: string, regex: boolean): number {
    const ms = matchesOf(pattern);
    if (!ms.length) return 0;
    mutate((d) => {
      for (const [item, list] of groupMatches(ms)) setText(d, item, (t) => replaceMatches(t, list, pattern, replacement, regex));
    });
    return ms.length;
  },
  clear() {
    hits.value = new Set();
  },
  selectedText: () => "",
  focus: () => focusSink(),
  readonly: () => !!props.readonly,
};

/** 整张图换成 AI 生成的结果，算一步操作 */
function replaceDoc(d: FlowDoc) {
  mutate((x) => {
    x.dir = d.dir;
    x.nodes = structuredClone(d.nodes);
    x.edges = structuredClone(d.edges);
  });
  select(null);
  void nextTick(center);
}

defineExpose({ run, selectText, focus: focusSink, find, replaceDoc, svgElement: () => host.value?.querySelector("svg") ?? null });

/**
 * 拖连线、改接端点时的预览线：按走线样式实时画出。移到节点上时按将要接的那一边画到节点上，
 * 否则画到鼠标处；松开到空白处弹出图形选框时保留。key 为正在改接的那条连线。
 */
const preview = computed<{ points: { x: number; y: number }[]; d: string; fromSide?: Side; key: string | null; dashed: boolean } | null>(() => {
  const p = pointer.value;
  if (!p) return null;
  const target = hover.value ? box(hover.value) : undefined;
  const draw = (points: { x: number; y: number }[], route: EdgeRoute) => polylinePath(points, route === "round");
  const from = picker.value?.from ?? (press?.kind === "connect" ? press.from : null);
  if (from) {
    const a = box(from);
    if (!a) return null;
    const side = picker.value?.side ?? (press?.kind === "connect" ? press.side : undefined) ?? sideNear(a, p);
    const route = newEdgeRoute.value;
    const points = target && !picker.value ? routePoints(a, target, route, { from: side, to: sideNear(target, p) }) : pointRoute(a, side, p, route);
    return { points, d: draw(points, route), fromSide: side, key: null, dashed: newEdgeStyle.value === "dotted" };
  }
  if (press?.kind !== "reconnect") return null;
  const e = edgeOf(press.key);
  if (!e) return null;
  const route = e.route ?? "elbow";
  const toEnd = press.end === "to";
  const fixed = box(toEnd ? e.from : e.to);
  if (!fixed) return null;
  let points: { x: number; y: number }[];
  if (target) {
    const a = toEnd ? fixed : target;
    const b = toEnd ? target : fixed;
    points = routePoints(a, b, route, toEnd ? { from: e.fromSide, to: sideNear(target, p) } : { from: sideNear(target, p), to: e.toSide });
  } else {
    points = pointRoute(fixed, (toEnd ? e.fromSide : e.toSide) ?? sideNear(fixed, p), p, route);
    if (!toEnd) points = [...points].reverse();
  }
  return { points, d: draw(points, route), key: e.key, dashed: e.style === "dotted" };
});

/** 拖连线时目标节点四边的连接点，离鼠标最近的那个高亮 */
const ports = computed(() => {
  const p = pointer.value;
  const b = hover.value ? box(hover.value) : undefined;
  if (!p || !b || (press?.kind !== "connect" && press?.kind !== "reconnect")) return [];
  const near = sideNear(b, p);
  return sidePoints(b).map((s) => ({ ...s, on: s.side === near }));
});

/** 快速延伸的箭头：鼠标所在的节点，或选中的单个节点 */
const arrows = computed(() => {
  if (props.readonly || editing.value || mode.value || picker.value || painter.value !== "off") return [];
  const id = hoverNode.value ?? (nodeSel.value.length === 1 ? selNode.value : null);
  const b = id ? box(id) : undefined;
  if (!b) return [];
  const d = 16;
  return (["top", "right", "bottom", "left"] as Side[]).map((side) => {
    const [nx, ny] = NORMAL[side];
    const x = b.cx + nx * (b.w / 2 + d);
    const y = b.cy + ny * (b.h / 2 + d);
    const path = `M${x + nx * 6} ${y + ny * 6}L${x - ny * 6 - nx * 3} ${y + nx * 6 - ny * 3}L${x + ny * 6 - nx * 3} ${y - nx * 6 - ny * 3}Z`;
    return { id: b.id, side, x, y, path };
  });
});

/** 调整大小的手柄：选中的单个节点的四个角 */
const corners = computed(() => {
  if (props.readonly || editing.value || nodeSel.value.length !== 1 || painter.value !== "off") return [];
  const b = selNode.value ? box(selNode.value) : undefined;
  if (!b) return [];
  const l = b.cx - b.w / 2;
  const r = b.cx + b.w / 2;
  const t = b.cy - b.h / 2;
  const bt = b.cy + b.h / 2;
  return [
    { corner: "nw", x: l, y: t }, { corner: "ne", x: r, y: t }, { corner: "sw", x: l, y: bt }, { corner: "se", x: r, y: bt },
  ];
});

/** 选中连线时每一段中点的小手柄：按住可以平移这一段 */
const segHandles = computed(() => {
  const key = selEdge.value;
  const edge = key ? edgeOf(key) : undefined;
  const r = key ? routeOf(key) : undefined;
  if (!edge || !r || props.readonly || edge.from === edge.to || (edge.route ?? "elbow") === "straight") return [];
  return r.points.slice(0, -1).flatMap((a, i) => {
    const b = r.points[i + 1];
    const horiz = Math.abs(a.y - b.y) < 0.5;
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 24) return [];
    return [{ seg: i, horiz, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }];
  });
});

const edgeEnds = computed(() => {
  const key = selEdge.value;
  const r = key ? routeOf(key) : undefined;
  if (!r || props.readonly) return [];
  return [
    { end: "from", ...r.points[0] },
    { end: "to", ...r.points[r.points.length - 1] },
  ];
});

const pickerStyle = computed(() => {
  const p = picker.value;
  if (!p) return {};
  return { left: `${(originX.value + p.at.x) * props.zoom + 8}px`, top: `${(originY.value + p.at.y) * props.zoom + 8}px` };
});

/** 文字相对图形中心的纵向偏移：圆柱的顶面占掉一点高度 */
const textShift = (b: FlowBox) => (b.shape === "cylinder" && !b.isText ? cylinderRy(b.h) / 2 : 0);
const guideSpan = computed(() => ({ x1: geo.value.minX - 2000, x2: geo.value.minX + geo.value.width + 2000, y1: geo.value.minY - 2000, y2: geo.value.minY + geo.value.height + 2000 }));
</script>

<template>
  <div class="diagram-editor">
    <div v-if="!bare" class="diagram-bar">
      <button class="dbtn flow-shape-btn" :class="{ 'is-active': shapeMenu }" :disabled="readonly" title="新建图形：点一下放在视图中央，或拖到画布上" @mousedown.prevent @click="shapeMenu = !shapeMenu">
        <svg class="shape-ico" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="4" width="12" height="8" /></svg>图形 <Icon name="down" sm />
      </button>
      <button class="dbtn" :disabled="readonly" title="新建文字（也可以双击空白处）" @mousedown.prevent @click="addNode(null, viewCenter())">
        <b class="flow-t">T</b>文字
      </button>
      <span class="dsep" />
      <button class="dbtn icon" :disabled="readonly" :title="tipFor('撤销', 'diagram.undo')" @mousedown.prevent @click="run('undo')"><Icon name="undo" sm /></button>
      <button class="dbtn icon" :disabled="readonly" :title="tipFor('重做', 'diagram.redo')" @mousedown.prevent @click="run('redo')"><Icon name="redo" sm /></button>
      <button class="dbtn icon" :disabled="readonly || !selected" :title="tipFor('删除节点或连线', 'diagram.delete')" @mousedown.prevent @click="run('delete')"><Icon name="trash" sm /></button>
      <span class="dsep" />
      <DiagramFormatBar
        kind="flow"
        :enabled="!readonly && nodeSel.length > 0"
        :style="focusStyle"
        :bold="focusStyle?.bold === true"
        :dark="dark"
        :painter="painter"
        :shape="focusNode && !focusNode.isText ? focusNode.shape : null"
        :count="nodeSel.length"
        :edge="edgeFormat"
        @style="applyStyle"
        @reset="resetStyle"
        @painter="setPainter"
        @shape="changeShape"
        @align="align"
        @route="setRoute"
        @edge-style="setEdgeStyle"
        @done="focusSink"
      />
      <span class="dsep" />
      <button v-if="aiJob" class="dbtn is-active" title="停止 AI 整理 (Esc)" @mousedown.prevent @click="stopAi">
        <span class="gen-spin" />AI 整理中… 停止
      </button>
      <button v-else class="dbtn" :disabled="readonly || !doc.nodes.length" :title="tipFor('AI 根据内容重新排列全部节点', 'ai.arrangeFlow')" @mousedown.prevent @click="aiArrange">
        <Icon name="sparkle" sm />AI 整理
      </button>
      <span class="dflex" />
      <DiagramCanvasMenu
        kind="flow"
        :canvas="doc.canvas"
        :dark="dark"
        :readonly="readonly"
        :edge-style="newEdgeStyle"
        :edge-route="newEdgeRoute"
        @canvas="setCanvas"
        @edge-style="newEdgeStyle = $event"
        @route="newEdgeRoute = $event"
        @done="focusSink"
      />
      <slot name="bar-end" />
      <div v-if="shapeMenu" class="flow-pop flow-shape-menu" @mousedown.stop>
        <div class="flow-pop-cap">点一下在视图中央新建，或拖到画布上</div>
        <div class="flow-pop-grid">
          <button v-for="s in FLOW_SHAPES" :key="s" type="button" class="flow-pop-cell" :title="SHAPE_INFO[s].label" @mousedown="onShapeDown(s, $event)">
            <svg viewBox="0 0 28 22" aria-hidden="true"><path :d="SHAPE_INFO[s].icon" /></svg>
          </button>
        </div>
      </div>
    </div>
    <div class="diagram-work">
      <div
        ref="host"
        class="diagram-canvas"
        :class="{ 'is-connecting': pointer, 'is-moving': mode === 'move', 'is-pan-ready': panReady, 'is-panning': mode === 'pan', 'is-painting': painter !== 'off' }"
        @mousedown="onMouseDown"
        @mousemove="onHover"
        @mouseleave="hoverNode = null; lastPointer = null"
        @dblclick="onDblClick"
        @contextmenu="onContextMenu"
        @wheel="onWheel"
      >
        <svg
          class="flow-svg"
          :width="canvasW * zoom"
          :height="canvasH * zoom"
          :viewBox="`0 0 ${canvasW} ${canvasH}`"
          :style="{ '--d-edge': scheme.edge }"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path class="flow-arrow" d="M0 0L10 5L0 10z" />
            </marker>
            <marker id="flow-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path class="flow-arrow on" d="M0 0L10 5L0 10z" />
            </marker>
          </defs>
          <g :transform="`translate(${originX} ${originY})`">
            <line v-for="(g, i) in guides" :key="`g${i}`" class="flow-guide" :x1="g.x ?? guideSpan.x1" :x2="g.x ?? guideSpan.x2" :y1="g.y ?? guideSpan.y1" :y2="g.y ?? guideSpan.y2" />
            <g
              v-for="r in geo.routes"
              :key="r.key"
              class="flow-edge"
              :class="[`style-${edgeOf(r.key)?.style}`, { 'is-selected': r.key === selEdge, 'is-hit': hits.has(EDGE + r.key), 'is-rewiring': r.key === preview?.key }]"
              :data-edge="r.key"
            >
              <path class="flow-edge-hit" :d="r.d" />
              <path
                class="flow-edge-line"
                :d="r.d"
                :marker-end="edgeOf(r.key)?.style === 'line' ? undefined : r.key === selEdge ? 'url(#flow-arrow-on)' : 'url(#flow-arrow)'"
              />
              <g v-if="r.label && !(editing?.type === 'edge' && editing.key === r.key)" class="flow-label" :transform="`translate(${r.label.x} ${r.label.y})`">
                <rect :width="r.label.w" :height="r.label.h" rx="4" />
                <text :x="r.label.w / 2" :y="14" text-anchor="middle">{{ edgeOf(r.key)?.label }}</text>
              </g>
            </g>
            <g
              v-for="b in geo.boxes.values()"
              :key="b.id"
              class="flow-node"
              :class="[b.isText ? 'is-text' : `shape-${b.shape}`, { 'is-selected': selSet.has(b.id), 'is-target': b.id === hover, 'is-hit': hits.has(b.id) }]"
              :data-id="b.id"
              :transform="`translate(${b.cx} ${b.cy})`"
              :style="nodeVars(b)"
            >
              <rect v-if="b.isText" class="flow-text-box" :x="-b.w / 2" :y="-b.h / 2" :width="b.w" :height="b.h" rx="3" />
              <path v-else class="flow-shape" :d="shapePath(b.shape, b.w, b.h)" />
              <rect v-if="hits.has(b.id)" class="flow-hit" :x="-b.w / 2 + 4" :y="-b.lines.length * b.lineH / 2 - 2 + textShift(b)" :width="b.w - 8" :height="b.lines.length * b.lineH + 4" rx="3" />
              <text v-if="!(editing?.type === 'node' && editing.id === b.id)" class="flow-text" text-anchor="middle" :font-size="b.size" :font-weight="b.weight">
                <tspan v-for="(line, i) in b.lines" :key="i" x="0" :y="(i - (b.lines.length - 1) / 2) * b.lineH + b.size * 0.35 + textShift(b)">{{ line }}</tspan>
              </text>
            </g>
            <g v-if="preview" class="flow-ghost">
              <path
                class="flow-ghost-line"
                :class="{ 'is-dotted': preview.dashed }"
                :d="preview.d"
                :marker-end="preview.key ? (edgeOf(preview.key)?.style === 'line' ? undefined : 'url(#flow-arrow-on)') : newEdgeStyle === 'line' ? undefined : 'url(#flow-arrow-on)'"
              />
              <circle v-if="!preview.key" class="flow-ghost-dot" :cx="preview.points[0].x" :cy="preview.points[0].y" r="3.5" />
            </g>
            <circle v-for="pt in ports" :key="`p${pt.side}`" class="flow-port" :class="{ 'is-on': pt.on }" :cx="pt.x" :cy="pt.y" :r="pt.on ? 5 : 3.5" />
            <g v-for="a in arrows" :key="`a${a.side}`" class="flow-arrow-btn" :data-arrow="a.side" :data-node="a.id">
              <circle :cx="a.x" :cy="a.y" r="11" class="flow-arrow-hit" />
              <path :d="a.path" />
            </g>
            <rect v-for="c in corners" :key="c.corner" class="flow-corner" :class="`is-${c.corner}`" :x="c.x - 4" :y="c.y - 4" width="8" height="8" :data-corner="c.corner" />
            <rect
              v-for="s in segHandles"
              :key="`s${s.seg}`"
              class="flow-seg"
              :class="s.horiz ? 'is-h' : 'is-v'"
              :x="s.x - (s.horiz ? 7 : 3)"
              :y="s.y - (s.horiz ? 3 : 7)"
              :width="s.horiz ? 14 : 6"
              :height="s.horiz ? 6 : 14"
              rx="3"
              :data-seg="s.seg"
            />
            <circle v-for="h in edgeEnds" :key="h.end" class="flow-handle" :cx="h.x" :cy="h.y" r="5" :data-end="h.end" />
            <rect v-if="marquee" class="diagram-marquee" :x="marquee.x" :y="marquee.y" :width="marquee.w" :height="marquee.h" />
          </g>
        </svg>
        <div v-if="!doc.nodes.length && !readonly" class="flow-empty">
          点工具栏上的“图形”新建第一个节点，或双击空白处写一段文字
          <button v-if="!readonly" class="dbtn flow-empty-ai" type="button" @mousedown.stop @click="emit('aiGenerate')"><Icon name="sparkle" sm />用 AI 生成</button>
        </div>
        <div v-if="pointer && mode === 'connect' && !hover" class="flow-tip" :style="{ left: `${(originX + pointer.x) * zoom + 14}px`, top: `${(originY + pointer.y) * zoom + 14}px` }">
          松开到节点上：连线<br />松开到空白处：选择新节点的图形
        </div>
        <div v-if="picker" class="flow-pop flow-picker" :style="pickerStyle" @mousedown.stop>
          <div class="flow-pop-cap">选择新节点的图形</div>
          <div class="flow-pop-grid">
            <button v-for="s in FLOW_SHAPES" :key="s" type="button" class="flow-pop-cell" :title="SHAPE_INFO[s].label" @mousedown.prevent @click="pick(s)">
              <svg viewBox="0 0 28 22" aria-hidden="true"><path :d="SHAPE_INFO[s].icon" /></svg>
            </button>
            <button type="button" class="flow-pop-cell" title="文字" @mousedown.prevent @click="pick(null)">
              <svg viewBox="0 0 28 22" aria-hidden="true"><path :d="TEXT_ICON" stroke-width="2" /></svg>
            </button>
          </div>
        </div>
        <textarea
          ref="sink"
          v-model="draft"
          class="diagram-input"
          :class="{ 'is-editing': editing }"
          :style="sinkStyle"
          :rows="editing ? Math.max(1, draft.split('\n').length) : 1"
          spellcheck="false"
          :readonly="readonly"
          aria-label="节点或连线文字"
          @keydown="onKey"
          @keyup="onKeyUp"
          @copy="onCopy"
          @cut="onCut"
          @paste="onPaste"
          @compositionstart="onCompositionStart"
          @compositionend="composing = false"
          @blur="onBlur"
        />
      </div>
      <DiagramZoom v-if="!bare" :zoom="zoom" @zoom="zoomTo" @step="stepZoom" @fit="zoomFit" />
    </div>
    <div v-if="shapeDrag?.moved" class="flow-drag-ghost" :style="{ left: `${shapeDrag.x + 6}px`, top: `${shapeDrag.y + 6}px` }">
      <svg viewBox="0 0 28 22" aria-hidden="true"><path :d="SHAPE_INFO[shapeDrag.shape].icon" /></svg>
    </div>
  </div>
</template>
