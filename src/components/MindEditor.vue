<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import Icon from "./Icon.vue";
import DiagramFormatBar from "./DiagramFormatBar.vue";
import DiagramCanvasMenu from "./DiagramCanvasMenu.vue";
import DiagramZoom from "./DiagramZoom.vue";
import MenuList, { type MenuEntry } from "./MenuList.vue";
import {
  addChild, addParent, addSibling, addSiblingBefore, addSummary, cleanMindText, cloneTree, countMind, eachMind, findMind, hasKids,
  moveMany, ownerOf, parentOf, removeMind, serializeMind, textToTrees, treesToText, type MindDoc, type MindNode,
} from "../diagram/mindmap";
import { recall, remember } from "../diagram/clipboard";
import { useContextMenuStore } from "../stores/contextMenu";
import { layoutMind, type MindBox } from "../diagram/mindLayout";
import { mindNodeColors, schemeColors, type NodeColors } from "../diagram/colors";
import { patchStyle, type CanvasStyle, type NodeStyle } from "../diagram/spark";
import { findInItems, groupMatches, replaceMatches, type DiagramMatch } from "../diagram/find";
import { dispatchShortcut, tipFor } from "../lib/commands";
import { isDarkTheme } from "../lib/themes";
import { useSettingsStore } from "../stores/settings";
import { useNoticeStore } from "../stores/notice";
import type { DiagramAction } from "../stores/diagram";

const props = defineProps<{
  doc: MindDoc;
  /** 生成中、历史版本预览等只读场景 */
  readonly?: boolean;
  /** 不显示工具栏和缩放控件（历史版本预览） */
  bare?: boolean;
  zoom: number;
  collapsedPaths: string[];
}>();
const emit = defineEmits<{
  change: [text: string];
  zoom: [value: number];
  collapse: [paths: string[]];
  stats: [nodes: number, edges: number, selected: number];
}>();

const NEW_TEXT = "新节点";
const SUMMARY_TEXT = "概要";
const MARGIN = 80;
const HISTORY = 100;

const settings = useSettingsStore();
const dark = computed(() => isDarkTheme(settings.theme));

/* ---------- 文档与撤销 ---------- */
const doc = shallowRef<MindDoc>(structuredClone(props.doc));
const version = ref(0);
const past: MindDoc[] = [];
const future: MindDoc[] = [];

function commit() {
  version.value++;
  emit("change", serializeMind(doc.value));
}

/** 修改前存一份快照；record 为 false 时并入上一步（例如新节点紧接着的改字） */
function mutate(fn: (d: MindDoc) => void, record = true) {
  if (props.readonly) return;
  if (record) {
    past.push(structuredClone(doc.value));
    if (past.length > HISTORY) past.shift();
    future.length = 0;
  }
  fn(doc.value);
  commit();
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

/** 外部载入了新内容（外部修改、AI 生成中），替换文档并清空撤销 */
watch(
  () => props.doc,
  (d) => {
    doc.value = structuredClone(d);
    past.length = 0;
    future.length = 0;
    collapsed.value = idsFromPaths(props.collapsedPaths);
    fixSelection();
    version.value++;
  },
);

/* ---------- 折叠：按文字路径持久化 ---------- */
function walkPaths(fn: (n: MindNode, path: string) => void) {
  const walk = (n: MindNode, prefix: string) => {
    const p = prefix ? `${prefix}/${n.text}` : n.text;
    fn(n, p);
    n.children.forEach((c) => walk(c, p));
    n.summaries?.forEach((s) => walk(s.node, p));
  };
  walk(doc.value.root, "");
}

function pathsOf(ids: Set<string>): string[] {
  const out: string[] = [];
  walkPaths((n, p) => ids.has(n.id) && out.push(p));
  return out;
}

function idsFromPaths(paths: string[]): Set<string> {
  const want = new Set(paths);
  const out = new Set<string>();
  walkPaths((n, p) => want.has(p) && hasKids(n) && out.add(n.id));
  return out;
}

const collapsed = ref(idsFromPaths(props.collapsedPaths));

function toggleFold(id = selected.value) {
  const node = findMind(doc.value, id);
  if (!node || !hasKids(node)) return;
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
  emit("collapse", pathsOf(next));
}

/** 展开到第 level 层（根节点为第 0 层）；level 为 Infinity 时全部展开 */
function expandTo(level: number) {
  const next = new Set<string>();
  const walk = (n: MindNode, depth: number) => {
    if (depth >= level && hasKids(n)) next.add(n.id);
    n.children.forEach((c) => walk(c, depth + 1));
    n.summaries?.forEach((s) => walk(s.node, depth + 1));
  };
  walk(doc.value.root, 0);
  collapsed.value = next;
  emit("collapse", pathsOf(next));
  if (!layout.value.boxes.has(selected.value)) fixSelection();
}

/** 选中被折叠隐藏的节点时展开它的祖先 */
function revealNode(id: string) {
  let changed = false;
  const next = new Set(collapsed.value);
  for (let p = parentOf(doc.value, id); p; p = parentOf(doc.value, p.id)) {
    if (next.delete(p.id)) changed = true;
  }
  if (changed) {
    collapsed.value = next;
    emit("collapse", pathsOf(next));
  }
}

/* ---------- 排版与配色 ---------- */
const styles = computed(() => {
  void version.value;
  const m = new Map<string, NodeStyle>();
  eachMind(doc.value.root, (n) => n.style && m.set(n.id, n.style));
  return m;
});

const layout = computed(() => {
  void version.value;
  const c = doc.value.canvas;
  return layoutMind(doc.value.root, collapsed.value, { structure: c.structure, look: c.look, line: c.line, spacing: c.spacing, styles: styles.value });
});

const scheme = computed(() => {
  void version.value;
  return schemeColors(doc.value.canvas.scheme, dark.value);
});
const colors = computed(() => {
  const out = new Map<string, NodeColors>();
  for (const b of layout.value.boxes.values()) out.set(b.id, mindNodeColors(scheme.value, b.depth, b.branch, b.summary, styles.value.get(b.id), dark.value, b.boxed));
  return out;
});

function nodeVars(id: string) {
  const c = colors.value.get(id);
  return c ? { "--n-fill": c.fill, "--n-stroke": c.stroke, "--n-text": c.text, "--n-line": c.line } : {};
}

const host = ref<HTMLElement | null>(null);
const viewW = ref(800);
const viewH = ref(600);
let resize: ResizeObserver | null = null;

/** 四周各留出一个窗口大小的空白，图比窗口小时也能拖动画布 */
const padX = computed(() => Math.max(MARGIN, viewW.value / props.zoom));
const padY = computed(() => Math.max(MARGIN, viewH.value / props.zoom));
const canvasW = computed(() => layout.value.width + padX.value * 2);
const canvasH = computed(() => layout.value.height + padY.value * 2);
const offsetX = padX;
const offsetY = padY;

function boxAt(id: string): MindBox | undefined {
  return layout.value.boxes.get(id);
}

/** 折叠数量标记的位置：在子节点展开的那一侧 */
function badgeAt(b: MindBox) {
  const y = b.underline ? b.y + b.h : b.y + b.h / 2;
  if (b.dir === "down") return { x: b.x + b.w / 2, y: b.y + b.h + 12 };
  if (b.dir === "left" || b.dir === "fish") return { x: b.x - 14, y };
  return { x: b.x + b.w + 14, y };
}

/* ---------- 选中：单选、Ctrl 逐个加选、Shift 选一段同级 ---------- */
const selected = ref(doc.value.root.id);
const selection = ref<string[]>([doc.value.root.id]);
const selSet = computed(() => new Set(selection.value));
/** Shift 选区的起点 */
let anchor = doc.value.root.id;
const editing = ref<string | null>(null);
const editIsNew = ref(false);
const draft = ref("");
const composing = ref(false);
const sink = ref<HTMLTextAreaElement | null>(null);

watch([version, selection], () => emit("stats", countMind(doc.value.root), 0, selection.value.length), { immediate: true });

/** 同级的普通节点（概要节点没有可成段选择的同级） */
function siblingsOf(id: string): MindNode[] | null {
  const own = ownerOf(doc.value, id);
  return own && !own.summary ? own.parent.children : null;
}

function rangeBetween(a: string, b: string): string[] | null {
  const list = siblingsOf(a);
  if (!list || !list.some((c) => c.id === b)) return null;
  const i = list.findIndex((c) => c.id === a);
  const j = list.findIndex((c) => c.id === b);
  return list.slice(Math.min(i, j), Math.max(i, j) + 1).map((c) => c.id);
}

function select(id: string, mode: "only" | "toggle" | "range" = "only", focus = true) {
  if (mode === "toggle") {
    if (selSet.value.has(id) && selection.value.length > 1) {
      selection.value = selection.value.filter((x) => x !== id);
      selected.value = selection.value[selection.value.length - 1];
    } else {
      selection.value = [...selection.value.filter((x) => x !== id), id];
      selected.value = id;
    }
    anchor = id;
  } else if (mode === "range") {
    const range = rangeBetween(anchor, id);
    selection.value = range ?? [id];
    if (!range) anchor = id;
    selected.value = id;
  } else {
    selection.value = [id];
    selected.value = id;
    anchor = id;
  }
  revealNode(id);
  void nextTick(() => {
    if (focus) focusSink();
    scrollIntoView(id);
  });
}

/** 撤销、外部修改、切换结构后，去掉已不存在的节点；选中的节点看不见时选它最近的可见祖先 */
function fixSelection() {
  const d = doc.value;
  const alive = selection.value.filter((id) => findMind(d, id));
  if (!alive.length && !selected.value) return;
  let focus = alive.includes(selected.value) ? selected.value : alive[alive.length - 1] ?? d.root.id;
  selection.value = alive.length ? alive : [focus];
  void nextTick(() => {
    const boxes = layout.value.boxes;
    if (boxes.has(focus)) return;
    for (let p = parentOf(doc.value, focus); p; p = parentOf(doc.value, p.id)) {
      if (boxes.has(p.id)) {
        focus = p.id;
        break;
      }
    }
    selected.value = focus;
    selection.value = [focus];
    anchor = focus;
  });
  selected.value = focus;
}

/** 点空白处：一个都不选 */
function clearSelection() {
  selection.value = [];
  selected.value = "";
  anchor = "";
}

function focusSink() {
  sink.value?.focus({ preventScroll: true });
}

function startEdit(id: string, replace: string | null, isNew = false) {
  if (props.readonly || !id) return;
  const node = findMind(doc.value, id);
  if (!node) return;
  selected.value = id;
  selection.value = [id];
  anchor = id;
  editing.value = id;
  editIsNew.value = isNew;
  draft.value = replace ?? node.text;
  void nextTick(() => {
    focusSink();
    if (replace === null || isNew) sink.value?.select();
  });
}

function finishEdit(keep: boolean) {
  const id = editing.value;
  if (!id) return;
  editing.value = null;
  const raw = draft.value.trim();
  draft.value = "";
  const node = findMind(doc.value, id);
  if (!node || !keep) return;
  if (!raw) {
    if (editIsNew.value) mutate((d) => void removeMind(d, id), false);
    return;
  }
  const text = cleanMindText(raw);
  if (text !== node.text) mutate((d) => void (findMind(d, id)!.text = text), !editIsNew.value);
}

function addNode(kind: "child" | "sibling" | "before" | "parent") {
  const from = selected.value;
  if (props.readonly || !from) return;
  if (kind === "parent") {
    const ids = selection.value.length ? [...selection.value] : [from];
    if (ids.includes(doc.value.root.id)) return useNoticeStore().inform("根节点不能插入父主题");
    let id: string | null = null;
    snapshotThen((d) => {
      id = addParent(d, ids, NEW_TEXT);
    });
    if (!id) return useNoticeStore().inform("插入父主题要求选中的是同一父节点下的节点");
    startEdit(id, null, true);
    void nextTick(() => scrollIntoView(id!));
    return;
  }
  let id: string | null = null;
  mutate((d) => {
    id = kind === "child" ? addChild(d, from, NEW_TEXT) : kind === "before" ? addSiblingBefore(d, from, NEW_TEXT) : addSibling(d, from, NEW_TEXT);
  });
  if (!id) return;
  if (kind === "child" && collapsed.value.has(from)) toggleFold(from);
  startEdit(id, null, true);
  void nextTick(() => scrollIntoView(id!));
}

/** 先试着改一份副本，改成了才记入撤销并应用（改不成时不留下空的撤销步骤） */
function snapshotThen(fn: (d: MindDoc) => void) {
  if (props.readonly) return;
  const before = structuredClone(doc.value);
  fn(doc.value);
  if (JSON.stringify(before) === JSON.stringify(doc.value)) return;
  past.push(before);
  if (past.length > HISTORY) past.shift();
  future.length = 0;
  commit();
}

/* ---------- 复制、剪切、粘贴、克隆 ---------- */
function copySelection(cut: boolean, e?: ClipboardEvent) {
  const ids = topSelection().length ? topSelection() : selected.value === doc.value.root.id ? [doc.value.root.id] : [];
  if (!ids.length) return;
  const trees = ids.map((id) => findMind(doc.value, id)!).map((n) => cloneTree(n));
  const text = treesToText(trees);
  remember({ kind: "mind", text, trees });
  if (e?.clipboardData) {
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  } else void navigator.clipboard?.writeText(text).catch(() => {});
  if (cut && !props.readonly) deleteSelected();
}

/** 粘贴为选中节点的子节点（没有选中时粘贴到根节点下） */
function pasteText(text: string) {
  if (props.readonly || !text.trim()) return;
  const target = selected.value || doc.value.root.id;
  const clip = recall("mind", text);
  const trees = clip ? clip.trees.map((t) => cloneTree(t)) : textToTrees(text);
  if (!trees.length) return;
  mutate((d) => {
    const parent = findMind(d, target);
    if (parent) parent.children.push(...trees);
  });
  if (collapsed.value.has(target)) toggleFold(target);
  selection.value = trees.map((t) => t.id);
  selected.value = trees[trees.length - 1].id;
  void nextTick(() => scrollIntoView(selected.value));
}

function onCopy(e: ClipboardEvent) {
  if (editing.value) return;
  copySelection(false, e);
}

function onCut(e: ClipboardEvent) {
  if (editing.value) return;
  copySelection(true, e);
}

function onPaste(e: ClipboardEvent) {
  if (editing.value) return;
  e.preventDefault();
  pasteText(e.clipboardData?.getData("text/plain") ?? "");
}

/** 右键菜单里的“粘贴”拿不到粘贴事件，直接读系统剪贴板 */
async function pasteFromMenu() {
  try {
    pasteText(await navigator.clipboard.readText());
  } catch (err) {
    useNoticeStore().report("读取剪贴板失败", err);
  }
}

/** 克隆：复制一份放在原节点后面作为同级节点 */
function duplicate() {
  const ids = topSelection();
  if (props.readonly || !ids.length) return;
  const made: string[] = [];
  mutate((d) => {
    for (const id of ids) {
      const own = ownerOf(d, id);
      if (!own) continue;
      const copy = cloneTree(findMind(d, id)!);
      const after = own.summary ? own.summary.to : id;
      own.parent.children.splice(own.parent.children.findIndex((c) => c.id === after) + 1, 0, copy);
      made.push(copy.id);
    }
  });
  if (!made.length) return;
  selection.value = made;
  selected.value = made[made.length - 1];
  void nextTick(() => scrollIntoView(selected.value));
}

function selectAll() {
  selection.value = [...layout.value.order];
  selected.value = doc.value.root.id;
  anchor = selected.value;
}

/** 选中的节点里去掉根节点，以及祖先也被选中的节点 */
function topSelection(): string[] {
  const d = doc.value;
  const set = selSet.value;
  return selection.value.filter((id) => {
    if (id === d.root.id) return false;
    for (let p = parentOf(d, id); p; p = parentOf(d, p.id)) if (set.has(p.id)) return false;
    return true;
  });
}

function deleteSelected() {
  const ids = topSelection();
  if (!ids.length) return;
  let next: string | null = null;
  mutate((d) => {
    for (const id of ids) next = removeMind(d, id) ?? next;
  });
  const target = next && findMind(doc.value, next) ? next : doc.value.root.id;
  select(target);
}

const isFish = computed(() => {
  void version.value;
  return doc.value.canvas.structure === "fishbone";
});

/** 概要：选中的节点都是同一父节点下的普通子节点 */
const summaryProblem = computed(() => {
  void version.value;
  if (isFish.value) return "鱼骨图不显示概要";
  const ids = selection.value;
  if (!ids.length) return "先选中要概括的节点";
  if (ids.includes(doc.value.root.id)) return "根节点不能加概要";
  const owners = ids.map((id) => ownerOf(doc.value, id));
  if (owners.some((o) => !o || o.summary)) return "概要节点不能再加概要";
  if (owners.some((o) => o!.parent !== owners[0]!.parent)) return "概要只能加在同一层的相邻节点上";
  return null;
});

function makeSummary() {
  if (props.readonly) return;
  if (summaryProblem.value) {
    useNoticeStore().inform(summaryProblem.value);
    return;
  }
  const ids = [...selection.value];
  let id: string | null = null;
  mutate((d) => {
    id = addSummary(d, ids, SUMMARY_TEXT);
  });
  if (!id) return;
  startEdit(id, null, true);
  void nextTick(() => scrollIntoView(id!));
}

/* ---------- 样式 ---------- */
function applyStyle(patch: Partial<NodeStyle>) {
  const ids = [...selection.value];
  mutate((d) => {
    for (const id of ids) {
      const n = findMind(d, id);
      if (n) n.style = patchStyle(n.style, patch);
    }
  });
}

function resetStyle() {
  const ids = selection.value.filter((id) => findMind(doc.value, id)?.style);
  if (!ids.length) return;
  mutate((d) => {
    for (const id of ids) delete findMind(d, id)!.style;
  });
}

function setCanvas(patch: Partial<CanvasStyle>) {
  const next: CanvasStyle = { ...doc.value.canvas, ...patch };
  for (const k of Object.keys(next) as (keyof CanvasStyle)[]) if (next[k] === undefined) delete next[k];
  if (JSON.stringify(next) === JSON.stringify(doc.value.canvas)) return;
  mutate((d) => void (d.canvas = next));
  fixSelection();
  void nextTick(() => scrollIntoView(selected.value));
}

/* ---------- 格式刷：单击刷一次，双击连续刷 ---------- */
const painter = ref<"off" | "once" | "sticky">("off");
let painterStyle: NodeStyle | undefined;

function setPainter(mode: "off" | "once" | "sticky") {
  if (mode !== "off") {
    const src = findMind(doc.value, selected.value);
    if (!src) return;
    painterStyle = src.style ? { ...src.style } : undefined;
  }
  painter.value = mode;
  focusSink();
}

/** 把格式刷记下的样式刷到这些节点上 */
function paint(ids: string[]) {
  if (!ids.length) return;
  const style = painterStyle;
  mutate((d) => {
    for (const id of ids) {
      const n = findMind(d, id);
      if (!n) continue;
      if (style) n.style = { ...style };
      else delete n.style;
    }
  });
  if (painter.value === "once") painter.value = "off";
}

const focusStyle = computed(() => {
  void version.value;
  return findMind(doc.value, selected.value)?.style;
});

/* ---------- 键盘导航 ---------- */
function nearest(key: string, filter: (b: MindBox) => boolean): MindBox | null {
  const me = boxAt(selected.value);
  if (!me) return null;
  const v = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
  if (!v) return null;
  const cx = me.x + me.w / 2;
  const cy = me.y + me.h / 2;
  let best: MindBox | null = null;
  let bestScore = Infinity;
  for (const b of layout.value.boxes.values()) {
    if (b.id === me.id || !filter(b)) continue;
    const dx = b.x + b.w / 2 - cx;
    const dy = b.y + b.h / 2 - cy;
    const along = dx * v[0] + dy * v[1];
    if (along <= 1) continue;
    const score = along + (Math.abs(dx * v[1]) + Math.abs(dy * v[0])) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best;
}

function navigate(key: string, extend: boolean) {
  const id = selected.value;
  if (!id) return select(doc.value.root.id);
  const node = findMind(doc.value, id);
  const me = boxAt(id);
  if (!node || !me) return;
  const pick = (b: MindBox | null | undefined) => b && select(b.id, extend ? "range" : "only");
  if (me.dir === "fish" || (isFish.value && me.depth <= 1)) return pick(nearest(key, () => true));
  const isRoot = id === doc.value.root.id;
  const outKey = { right: "ArrowRight", left: "ArrowLeft", down: "ArrowDown", fish: "" }[me.dir];
  const inKey = { right: "ArrowLeft", left: "ArrowRight", down: "ArrowUp", fish: "" }[me.dir];
  const prevKey = me.sib === "h" ? "ArrowLeft" : "ArrowUp";
  const nextKey = me.sib === "h" ? "ArrowRight" : "ArrowDown";
  const kidsOn = (dir: string) => layout.value.order.map((k) => boxAt(k)!).filter((b) => b.parent === id && !b.summary && (isRoot ? b.dir === dir : true));
  const middle = (list: MindBox[]) => list[Math.floor((list.length - 1) / 2)];

  if (isRoot && doc.value.canvas.structure === "balanced" && (key === "ArrowLeft" || key === "ArrowRight")) {
    if (collapsed.value.has(id)) toggleFold(id);
    void nextTick(() => pick(middle(kidsOn(key === "ArrowLeft" ? "left" : "right"))));
    return;
  }
  if (!extend && key === inKey) return pick(boxAt(parentOf(doc.value, id)?.id ?? ""));
  if (!extend && key === outKey) {
    if (!hasKids(node)) return;
    if (collapsed.value.has(id)) toggleFold(id);
    void nextTick(() => pick(middle(kidsOn(me.dir))));
    return;
  }
  if (key !== prevKey && key !== nextKey) return;
  const list = (siblingsOf(id) ?? []).map((c) => boxAt(c.id)).filter((b): b is MindBox => !!b && b.dir === me.dir);
  const at = list.findIndex((b) => b.id === id);
  const sib = at >= 0 ? list[at + (key === prevKey ? -1 : 1)] : undefined;
  if (sib || extend) return pick(sib);
  // 没有同级时，跳到这个方向上最近的同层节点
  pick(nearest(key, (b) => b.depth === me.depth));
}

function run(action: DiagramAction) {
  if (editing.value) finishEdit(true);
  switch (action) {
    case "addChild": return addNode("child");
    case "addSibling": return addNode("sibling");
    case "delete": return deleteSelected();
    case "edit": return startEdit(selected.value, null);
    case "toggleFold": return toggleFold();
    case "undo": return undo();
    case "redo": return redo();
    case "center": return center();
    case "summary": return makeSummary();
    case "addSiblingBefore": return addNode("before");
    case "addParent": return addNode("parent");
    case "duplicate": return duplicate();
    case "zoomFit": return zoomFit();
    case "zoom100": return zoomTo(1);
    case "aiArrange": return;
  }
}

function onKey(e: KeyboardEvent) {
  if (editing.value) {
    if (composing.value || e.isComposing) return;
    // Shift+Enter 换行，交给输入框
    if (e.key === "Enter" && e.shiftKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      finishEdit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishEdit(false);
    } else if (e.key === "Tab") {
      e.preventDefault();
      finishEdit(true);
      addNode("child");
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
  // 空格：按住拖动画布；按下又松开、中间没有拖动时才执行空格对应的命令（默认折叠 / 展开）
  if (e.key === " ") {
    e.preventDefault();
    if (!e.repeat && !space.down) {
      space.down = true;
      space.used = false;
      space.cmd = dispatchShortcut(e, "diagram");
      panReady.value = true;
    }
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
    navigate(e.key, e.shiftKey);
    return;
  }
  if (e.key === "Backspace") {
    e.preventDefault();
    run("delete");
    return;
  }
  if (e.key === "Escape") {
    if (painter.value !== "off") painter.value = "off";
    else if (selection.value.length > 1) select(selected.value);
    else clearSelection();
    return;
  }
  // 直接打字即替换节点文字；输入法开始组字时同样进入编辑
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  if ((printable || e.key === "Process") && !props.readonly && selected.value) startEdit(selected.value, "");
  else e.preventDefault();
}

const space = { down: false, used: false, cmd: null as ReturnType<typeof dispatchShortcut> };
const panReady = ref(false);

function onKeyUp(e: KeyboardEvent) {
  if (e.key !== " " || !space.down) return;
  const cmd = !space.used ? space.cmd : null;
  resetSpace();
  if (cmd) void cmd.run();
}

function resetSpace() {
  space.down = false;
  space.cmd = null;
  panReady.value = false;
}

function onCompositionStart() {
  composing.value = true;
  if (!editing.value && !props.readonly && selected.value) startEdit(selected.value, "");
}

function onBlur() {
  resetSpace();
  if (editing.value && !dragging.value) finishEdit(true);
}

/* ---------- 输入框位置 ---------- */
const sinkStyle = computed(() => {
  const b = boxAt(editing.value ?? selected.value);
  if (!b) return { left: "0px", top: "0px" };
  const z = props.zoom;
  const w = Math.max(b.w, 140);
  return {
    left: `${(offsetX.value + b.x) * z}px`,
    top: `${(offsetY.value + b.y) * z}px`,
    width: `${w * z}px`,
    minHeight: `${b.h * z}px`,
    padding: `${b.padY * z}px ${b.padX * z}px`,
    fontSize: `${b.size * z}px`,
    lineHeight: `${b.lineH * z}px`,
    fontWeight: String(b.weight),
  };
});

/* ---------- 鼠标：选中、拖动节点、拖动画布 ---------- */
type Drop = { id: string; where: "child" | "before" | "after" };
const dragging = ref<string | null>(null);
const dragPos = ref({ x: 0, y: 0 });
const drop = ref<Drop | null>(null);
/** 按下的是节点、拖动画布还是框选；框选时 base 为按下前的选中（Ctrl 框选是加选） */
let press: {
  kind: "node" | "pan" | "marquee";
  id: string | null;
  x: number;
  y: number;
  scrollX: number;
  scrollY: number;
  moved: boolean;
  drag: boolean;
  base: string[];
  start: { x: number; y: number };
} | null = null;
const marquee = ref<{ x: number; y: number; w: number; h: number } | null>(null);
const panning = ref(false);

function toCanvas(e: MouseEvent) {
  const r = host.value!.getBoundingClientRect();
  return {
    x: (e.clientX - r.left + host.value!.scrollLeft) / props.zoom - offsetX.value,
    y: (e.clientY - r.top + host.value!.scrollTop) / props.zoom - offsetY.value,
  };
}

function inSubtree(rootId: string, id: string): boolean {
  const n = findMind(doc.value, rootId);
  let hit = false;
  if (n) eachMind(n, (m) => void (m.id === id && (hit = true)));
  return hit;
}

/** 正在拖动的节点（多选时一起拖） */
const moving = ref<string[]>([]);

function dropAt(p: { x: number; y: number }): Drop | null {
  for (const b of layout.value.boxes.values()) {
    if (p.x < b.x - 4 || p.x > b.x + b.w + 4 || p.y < b.y - 4 || p.y > b.y + b.h + 4) continue;
    if (moving.value.some((id) => inSubtree(id, b.id))) return null;
    if (!b.parent || b.summary) return { id: b.id, where: "child" };
    const r = b.sib === "h" ? (p.x - b.x) / b.w : (p.y - b.y) / b.h;
    if (r < 0.25) return { id: b.id, where: "before" };
    if (r > 0.75) return { id: b.id, where: "after" };
    return { id: b.id, where: "child" };
  }
  return null;
}

/** 放入位置的预览框：作为子节点时放在最后一个子节点下面，作为同级时放在目标的前面或后面 */
const dropPreview = computed(() => {
  const d = drop.value;
  const t = d ? boxAt(d.id) : undefined;
  if (!d || !t) return null;
  const w = 110;
  const h = 26;
  const label = (() => {
    const first = findMind(doc.value, moving.value[0])?.text.split("\n")[0] ?? "";
    return moving.value.length > 1 ? `${first} 等 ${moving.value.length} 项` : first;
  })();
  if (d.where === "child") {
    const kids = [...layout.value.boxes.values()].filter((b) => b.parent === t.id && !b.summary);
    const last = kids[kids.length - 1];
    if (last) {
      // 放在最后一个子节点整棵子树的外面，免得压住它的子节点
      let right = last.x + last.w;
      let bottom = last.y + last.h;
      const lastNode = findMind(doc.value, last.id);
      if (lastNode) eachMind(lastNode, (n) => {
        const b = boxAt(n.id);
        if (!b) return;
        right = Math.max(right, b.x + b.w);
        bottom = Math.max(bottom, b.y + b.h);
      });
      if (t.dir === "down") return { x: right + 12, y: last.y, w, h, label };
      return { x: t.dir === "left" ? last.x + last.w - w : last.x, y: bottom + 8, w, h, label };
    }
    if (t.dir === "down") return { x: t.x + t.w / 2 - w / 2, y: t.y + t.h + 36, w, h, label };
    if (t.dir === "left") return { x: t.x - 44 - w, y: t.y + t.h / 2 - h / 2, w, h, label };
    return { x: t.x + t.w + 44, y: t.y + t.h / 2 - h / 2, w, h, label };
  }
  const before = d.where === "before";
  if (t.sib === "h") return { x: before ? t.x - w - 8 : t.x + t.w + 8, y: t.y, w, h, label };
  return { x: t.dir === "left" ? t.x + t.w - w : t.x, y: before ? t.y - h - 6 : t.y + t.h + 6, w, h, label };
});

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0 && e.button !== 1) return;
  const target = (e.target as Element).closest<SVGGElement>("[data-id]");
  if (e.button === 0 && (e.target as Element).closest(".mind-badge")) return;
  if (editing.value && (e.button === 1 || target?.dataset.id !== editing.value)) finishEdit(true);
  if (editing.value) return;
  e.preventDefault();
  const pan = e.button === 1 || space.down;
  const id = pan ? null : target?.dataset.id ?? null;
  const multi = e.ctrlKey || e.metaKey || e.shiftKey;
  if (id && painter.value !== "off") {
    paint([id]);
    focusSink();
    return;
  }
  press = {
    kind: pan ? "pan" : id ? "node" : "marquee",
    id, x: e.clientX, y: e.clientY, scrollX: host.value!.scrollLeft, scrollY: host.value!.scrollTop, moved: false, drag: !multi,
    base: e.ctrlKey || e.metaKey ? [...selection.value] : [],
    start: toCanvas(e),
  };
  if (pan) {
    space.used = true;
    panning.value = true;
  }
  // 按住已选中的节点（没按修饰键）时先不改选中，拖动时一起拖；没拖动就在松开时只选它
  if (id && !multi && selSet.value.has(id) && selection.value.length > 1) {
    selected.value = id;
    focusSink();
  } else if (id) select(id, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "only");
  else focusSink();
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (!press) return;
  const dx = e.clientX - press.x;
  const dy = e.clientY - press.y;
  if (!press.moved && Math.hypot(dx, dy) < 4) return;
  press.moved = true;
  if (press.kind === "pan") {
    host.value!.scrollLeft = press.scrollX - dx;
    host.value!.scrollTop = press.scrollY - dy;
    return;
  }
  const p = toCanvas(e);
  if (press.kind === "marquee") {
    const r = { x: Math.min(p.x, press.start.x), y: Math.min(p.y, press.start.y), w: Math.abs(p.x - press.start.x), h: Math.abs(p.y - press.start.y) };
    marquee.value = r;
    const hit = [...layout.value.boxes.values()]
      .filter((b) => b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y)
      .map((b) => b.id);
    const next = [...press.base, ...hit.filter((id) => !press!.base.includes(id))];
    selection.value = next;
    selected.value = next[next.length - 1] ?? "";
    anchor = selected.value;
    return;
  }
  if (props.readonly || !press.drag || press.id === doc.value.root.id) return;
  if (!dragging.value) {
    const top = topSelection();
    moving.value = top.includes(press.id!) ? top : [press.id!];
  }
  dragging.value = press.id;
  dragPos.value = p;
  drop.value = dropAt(p);
}

function onMouseUp() {
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
  const id = dragging.value;
  const target = drop.value;
  const ids = [...moving.value];
  const p = press;
  // 点空白处（没有拖出选框）取消选中；格式刷时把框住的节点都刷上
  if (p?.kind === "marquee" && !p.moved && !p.base.length) clearSelection();
  if (p?.kind === "marquee" && p.moved && painter.value !== "off") paint([...selection.value]);
  // 按住多选中的一个节点没有拖动：只选它
  if (p?.kind === "node" && !p.moved && p.drag && p.id && selection.value.length > 1) select(p.id);
  dragging.value = null;
  drop.value = null;
  moving.value = [];
  marquee.value = null;
  panning.value = false;
  press = null;
  if (!id || !target) return focusSink();
  mutate((d) => void moveMany(d, ids, target.id, target.where));
  if (target.where === "child" && collapsed.value.has(target.id)) toggleFold(target.id);
  selection.value = ids;
  selected.value = id;
  void nextTick(() => scrollIntoView(id));
  focusSink();
}

/* ---------- 右键菜单 ---------- */
const ctxMenu = useContextMenuStore();

function levelItems(): MenuEntry[] {
  return [
    ...[1, 2, 3, 4].map((n): MenuEntry => ({ kind: "item", label: `展开到第 ${n} 层`, action: () => expandTo(n) })),
    { kind: "sep" },
    { kind: "item", label: "全部展开", action: () => expandTo(Infinity) },
    { kind: "item", label: "全部折叠", action: () => expandTo(1) },
  ];
}

function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  if (editing.value) finishEdit(true);
  const id = (e.target as Element).closest<SVGGElement>("[data-id]")?.dataset.id;
  const ro = !!props.readonly;
  if (!id) {
    ctxMenu.show(e, [
      { kind: "item", label: "新建子主题", disabled: ro, action: () => { select(doc.value.root.id); addNode("child"); } },
      { kind: "item", label: "粘贴", hint: "Ctrl+V", disabled: ro, action: () => pasteFromMenu() },
      { kind: "item", label: "全选", hint: "Ctrl+A", action: () => selectAll() },
      { kind: "sep" },
      { kind: "item", label: "适应窗口", command: "diagram.zoomFit" },
    ]);
    return;
  }
  if (!selSet.value.has(id)) select(id);
  const node = findMind(doc.value, id);
  ctxMenu.show(e, [
    { kind: "item", label: "添加子主题", command: "diagram.addChild", disabled: ro },
    { kind: "item", label: "添加同级主题", command: "diagram.addSibling", disabled: ro },
    { kind: "item", label: "插入父主题", command: "diagram.addParent", disabled: ro || id === doc.value.root.id },
    { kind: "item", label: "概要", command: "diagram.summary", disabled: ro || !!summaryProblem.value },
    { kind: "sep" },
    { kind: "item", label: "复制", hint: "Ctrl+C", action: () => copySelection(false) },
    { kind: "item", label: "剪切", hint: "Ctrl+X", disabled: ro || id === doc.value.root.id, action: () => copySelection(true) },
    { kind: "item", label: "粘贴", hint: "Ctrl+V", disabled: ro, action: () => pasteFromMenu() },
    { kind: "item", label: "克隆", command: "diagram.duplicate", disabled: ro || id === doc.value.root.id },
    { kind: "sep" },
    { kind: "item", label: "折叠 / 展开", command: "diagram.toggleFold", disabled: !node || !hasKids(node) },
    { kind: "sub", label: "展开到", items: levelItems() },
    { kind: "sep" },
    { kind: "item", label: "删除", command: "diagram.delete", disabled: ro || id === doc.value.root.id },
  ]);
}

const foldMenuAt = ref<{ x: number; y: number } | null>(null);
function toggleFoldMenu(e: MouseEvent) {
  if (foldMenuAt.value) {
    foldMenuAt.value = null;
    return;
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  foldMenuAt.value = { x: r.left, y: r.bottom + 4 };
}
function foldItems(): MenuEntry[] {
  const node = findMind(doc.value, selected.value);
  return [
    { kind: "item", label: "折叠 / 展开所选", command: "diagram.toggleFold", disabled: !node || !hasKids(node) },
    { kind: "sep" },
    ...levelItems(),
  ];
}
function onFoldOutside(e: MouseEvent) {
  if (foldMenuAt.value && !(e.target as Element).closest(".menu, .fold-btn")) foldMenuAt.value = null;
}

function onDblClick(e: MouseEvent) {
  const target = (e.target as Element).closest<SVGGElement>("[data-id]");
  if (target?.dataset.id) startEdit(target.dataset.id, null);
}

/* ---------- 缩放与滚动 ---------- */
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;

/** 缩放到 z，at（窗口坐标）处的图保持不动；不给 at 时以画面中心为准 */
function zoomTo(z: number, at?: { clientX: number; clientY: number }) {
  const el = host.value;
  const next = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100;
  if (!el || next === props.zoom) return;
  const r = el.getBoundingClientRect();
  const ax = at ? at.clientX - r.left : el.clientWidth / 2;
  const ay = at ? at.clientY - r.top : el.clientHeight / 2;
  const gx = (el.scrollLeft + ax) / props.zoom - offsetX.value;
  const gy = (el.scrollTop + ay) / props.zoom - offsetY.value;
  emit("zoom", next);
  void nextTick(() => {
    el.scrollLeft = (offsetX.value + gx) * next - ax;
    el.scrollTop = (offsetY.value + gy) * next - ay;
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
  const z = Math.min(1, (el.clientWidth - 80) / Math.max(layout.value.width, 1), (el.clientHeight - 80) / Math.max(layout.value.height, 1));
  const next = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100;
  if (next !== props.zoom) emit("zoom", next);
  void nextTick(center);
}

function scrollIntoView(id: string) {
  const b = boxAt(id);
  const el = host.value;
  if (!b || !el) return;
  const z = props.zoom;
  const left = (offsetX.value + b.x) * z;
  const top = (offsetY.value + b.y) * z;
  const right = left + b.w * z;
  const bottom = top + b.h * z;
  const pad = 40;
  if (left < el.scrollLeft + pad) el.scrollLeft = left - pad;
  else if (right > el.scrollLeft + el.clientWidth - pad) el.scrollLeft = right - el.clientWidth + pad;
  if (top < el.scrollTop + pad) el.scrollTop = top - pad;
  else if (bottom > el.scrollTop + el.clientHeight - pad) el.scrollTop = bottom - el.clientHeight + pad;
}

function center() {
  const el = host.value;
  if (!el) return;
  const z = props.zoom;
  el.scrollLeft = (offsetX.value + layout.value.width / 2) * z - el.clientWidth / 2;
  el.scrollTop = (offsetY.value + layout.value.height / 2) * z - el.clientHeight / 2;
  focusSink();
}

onMounted(() => {
  document.addEventListener("mousedown", onFoldOutside, true);
  resize = new ResizeObserver(() => {
    viewW.value = host.value?.clientWidth ?? 800;
    viewH.value = host.value?.clientHeight ?? 600;
  });
  if (host.value) {
    resize.observe(host.value);
    viewW.value = host.value.clientWidth;
    viewH.value = host.value.clientHeight;
  }
  void nextTick(() => {
    center();
    focusSink();
  });
});

onBeforeUnmount(() => {
  resize?.disconnect();
  document.removeEventListener("mousedown", onFoldOutside, true);
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
  if (editing.value) finishEdit(true);
});

/** 从搜索结果打开时选中第一个包含该文字的节点 */
function selectText(text: string): boolean {
  const q = text.toLowerCase();
  let hit: MindNode | null = null;
  eachMind(doc.value.root, (n) => {
    if (!hit && n.text.toLowerCase().includes(q)) hit = n;
  });
  if (hit) select((hit as MindNode).id);
  return !!hit;
}

/* ---------- 查找与替换 ---------- */
const hits = ref<Set<string>>(new Set());

function matchesOf(pattern: RegExp): DiagramMatch[] {
  const items: { id: string; text: string }[] = [];
  eachMind(doc.value.root, (n) => items.push({ id: n.id, text: n.text }));
  return findInItems(items, pattern);
}

const find = {
  search(pattern: RegExp | null, current: number, sel: boolean): number {
    const ms = pattern ? matchesOf(pattern) : [];
    hits.value = new Set(ms.map((m) => m.item));
    const m = ms[current];
    if (sel && m) select(m.item, "only", false);
    return ms.length;
  },
  replaceOne(current: number, pattern: RegExp, replacement: string, regex: boolean) {
    const m = matchesOf(pattern)[current];
    if (!m) return;
    mutate((d) => {
      const n = findMind(d, m.item)!;
      n.text = cleanMindText(replaceMatches(n.text, [m], pattern, replacement, regex));
    });
  },
  replaceAll(pattern: RegExp, replacement: string, regex: boolean): number {
    const ms = matchesOf(pattern);
    if (!ms.length) return 0;
    mutate((d) => {
      for (const [id, list] of groupMatches(ms)) {
        const n = findMind(d, id)!;
        n.text = cleanMindText(replaceMatches(n.text, list, pattern, replacement, regex));
      }
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

defineExpose({ run, selectText, focus: focusSink, find, svgElement: () => host.value?.querySelector("svg") ?? null });

const canDelete = computed(() => !props.readonly && topSelection().length > 0);
const bracketColor = (id: string) => colors.value.get(id)?.line;
</script>

<template>
  <div class="diagram-editor">
    <div v-if="!bare" class="diagram-bar">
      <button class="dbtn" :disabled="readonly || !selected" :title="tipFor('添加子主题', 'diagram.addChild')" @mousedown.prevent @click="run('addChild')">
        <Icon name="child" sm />子主题
      </button>
      <button class="dbtn" :disabled="readonly || !selected" :title="tipFor('添加同级主题', 'diagram.addSibling')" @mousedown.prevent @click="run('addSibling')">
        <Icon name="sibling" sm />同级
      </button>
      <button class="dbtn" :disabled="readonly || !selected || selected === doc.root.id" :title="tipFor('插入父主题', 'diagram.addParent')" @mousedown.prevent @click="run('addParent')">
        <Icon name="parent" sm />父主题
      </button>
      <button class="dbtn" :disabled="readonly || isFish" :title="isFish ? '鱼骨图不显示概要' : tipFor('给选中的相邻同级节点加概要', 'diagram.summary')" @mousedown.prevent @click="run('summary')">
        <Icon name="brace" sm />概要
      </button>
      <span class="dsep" />
      <button class="dbtn icon" :disabled="readonly" :title="tipFor('撤销', 'diagram.undo')" @mousedown.prevent @click="run('undo')"><Icon name="undo" sm /></button>
      <button class="dbtn icon" :disabled="readonly" :title="tipFor('重做', 'diagram.redo')" @mousedown.prevent @click="run('redo')"><Icon name="redo" sm /></button>
      <button class="dbtn icon" :disabled="!canDelete" :title="tipFor('删除节点', 'diagram.delete')" @mousedown.prevent @click="run('delete')"><Icon name="trash" sm /></button>
      <span class="dsep" />
      <DiagramFormatBar
        kind="mind"
        :enabled="!readonly && selection.length > 0"
        :style="focusStyle"
        :bold="(boxAt(selected)?.weight ?? 400) >= 600"
        :dark="dark"
        :painter="painter"
        @style="applyStyle"
        @reset="resetStyle"
        @painter="setPainter"
        @done="focusSink"
      />
      <span class="dsep" />
      <button class="dbtn fold-btn" :class="{ 'is-active': foldMenuAt }" :title="tipFor('折叠 / 展开', 'diagram.toggleFold')" @mousedown.prevent @click="toggleFoldMenu">
        <Icon name="collapse" sm />折叠 <Icon name="down" sm />
      </button>
      <span class="dflex" />
      <DiagramCanvasMenu kind="mind" :canvas="doc.canvas" :dark="dark" :readonly="readonly" @canvas="setCanvas" @done="focusSink" />
      <slot name="bar-end" />
    </div>
    <div class="diagram-work">
      <div
        ref="host"
        class="diagram-canvas"
        :class="{ 'is-dragging': dragging, 'is-pan-ready': panReady, 'is-panning': panning, 'is-painting': painter !== 'off' }"
        @mousedown="onMouseDown"
        @dblclick="onDblClick"
        @contextmenu="onContextMenu"
        @wheel="onWheel"
      >
        <svg
          class="mind-svg"
          :width="canvasW * zoom"
          :height="canvasH * zoom"
          :viewBox="`0 0 ${canvasW} ${canvasH}`"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g :transform="`translate(${offsetX} ${offsetY})`">
            <path v-if="layout.spine" class="mind-spine" :d="layout.spine" :style="{ stroke: scheme.line }" />
            <path v-for="l in layout.links" :key="l.to" class="mind-link" :class="{ 'is-bone': isFish && boxAt(l.to)?.depth === 1 }" :d="l.d" :style="{ stroke: colors.get(l.to)?.line }" />
            <path v-for="br in layout.brackets" :key="`b${br.id}`" class="mind-bracket" :d="br.d" :style="{ stroke: bracketColor(br.id) }" />
            <g
              v-for="id in layout.order"
              :key="id"
              class="mind-node"
              :class="[
                `depth-${Math.min(boxAt(id)!.depth, 2)}`,
                { 'is-selected': selSet.has(id), 'is-editing': id === editing, 'is-dragged': dragging && moving.includes(id) },
                drop?.id === id ? `drop-${drop.where}` : '',
              ]"
              :style="nodeVars(id)"
              :data-id="id"
            >
              <rect
                v-if="selSet.has(id)"
                class="mind-focus"
                :class="{ 'is-anchor': id === selected && selection.length > 1 }"
                :x="boxAt(id)!.x - 3"
                :y="boxAt(id)!.y - 3"
                :width="boxAt(id)!.w + 6"
                :height="boxAt(id)!.h + 6"
                rx="7"
              />
              <rect
                class="mind-box"
                :class="{ 'is-plain': !boxAt(id)!.boxed, 'is-summary': boxAt(id)!.summary }"
                :x="boxAt(id)!.x"
                :y="boxAt(id)!.y"
                :width="boxAt(id)!.w"
                :height="boxAt(id)!.h"
                :rx="boxAt(id)!.depth === 0 ? 8 : 5"
              />
              <rect
                v-if="hits.has(id)"
                class="mind-hit"
                :x="boxAt(id)!.x + 2"
                :y="boxAt(id)!.y + 2"
                :width="boxAt(id)!.w - 4"
                :height="boxAt(id)!.h - 4"
                rx="3"
              />
              <line
                v-if="boxAt(id)!.underline"
                class="mind-underline"
                :x1="boxAt(id)!.x"
                :x2="boxAt(id)!.x + boxAt(id)!.w"
                :y1="boxAt(id)!.y + boxAt(id)!.h"
                :y2="boxAt(id)!.y + boxAt(id)!.h"
              />
              <text
                v-if="id !== editing"
                class="mind-text"
                :font-size="boxAt(id)!.size"
                :font-weight="boxAt(id)!.weight"
              >
                <tspan
                  v-for="(line, i) in boxAt(id)!.lines"
                  :key="i"
                  :x="boxAt(id)!.x + boxAt(id)!.padX"
                  :y="boxAt(id)!.y + boxAt(id)!.padY + i * boxAt(id)!.lineH + boxAt(id)!.lineH * 0.7"
                >{{ line }}</tspan>
              </text>
              <g
                v-if="boxAt(id)!.hidden"
                class="mind-badge"
                @mousedown.stop.prevent
                @click.stop="toggleFold(id)"
              >
                <circle :cx="badgeAt(boxAt(id)!).x" :cy="badgeAt(boxAt(id)!).y" r="10" />
                <text :x="badgeAt(boxAt(id)!).x" :y="badgeAt(boxAt(id)!).y + 3.5" text-anchor="middle">{{ boxAt(id)!.hidden > 99 ? "99+" : `+${boxAt(id)!.hidden}` }}</text>
              </g>
            </g>
            <g v-if="dropPreview" class="mind-preview">
              <rect :x="dropPreview.x" :y="dropPreview.y" :width="dropPreview.w" :height="dropPreview.h" rx="5" />
              <text :x="dropPreview.x + dropPreview.w / 2" :y="dropPreview.y + dropPreview.h / 2 + 4" text-anchor="middle">{{ dropPreview.label }}</text>
            </g>
            <rect v-if="marquee" class="diagram-marquee" :x="marquee.x" :y="marquee.y" :width="marquee.w" :height="marquee.h" />
          </g>
        </svg>
        <textarea
          ref="sink"
          v-model="draft"
          class="diagram-input"
          :class="{ 'is-editing': editing }"
          :style="sinkStyle"
          :rows="editing ? Math.max(1, draft.split('\n').length) : 1"
          spellcheck="false"
          :readonly="readonly"
          aria-label="节点文字"
          @keydown="onKey"
          @keyup="onKeyUp"
          @copy="onCopy"
          @cut="onCut"
          @paste="onPaste"
          @compositionstart="onCompositionStart"
          @compositionend="composing = false"
          @blur="onBlur"
        />
        <div v-if="dragging" class="mind-ghost" :style="{ left: `${(offsetX + dragPos.x) * zoom + 12}px`, top: `${(offsetY + dragPos.y) * zoom + 8}px` }">
          {{ moving.length > 1 ? `拖动 ${moving.length} 个` : findMind(doc, dragging)?.text.split("\n")[0] }}
        </div>
      </div>
      <DiagramZoom v-if="!bare" :zoom="zoom" @zoom="zoomTo" @step="stepZoom" @fit="zoomFit" />
    </div>
    <MenuList v-if="foldMenuAt" :items="foldItems()" :at="foldMenuAt" @done="foldMenuAt = null" />
  </div>
</template>
