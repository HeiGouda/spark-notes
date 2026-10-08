<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { aiMindDoc, useMindGenStore } from "../stores/mindGen";
import { useFlowGenStore } from "../stores/flowGen";
import { parseAiFlow } from "../diagram/flowGen";
import { docName } from "../lib/doctype";
import { countMind } from "../diagram/mindmap";
import MindEditor from "./MindEditor.vue";
import FlowEditor from "./FlowEditor.vue";
import DiagramIssues from "./DiagramIssues.vue";
import BacklinksPanel from "./BacklinksPanel.vue";
import { parseMind, type MindDoc } from "../diagram/mindmap";
import { parseFlow, type FlowDoc } from "../diagram/flowchart";
import type { ParseResult } from "../diagram/issues";
import type { Tab } from "../stores/tabs";
import { useTabsStore } from "../stores/tabs";
import { useVaultStore } from "../stores/vault";
import { useSettingsStore } from "../stores/settings";
import { useDiagramStore, type DiagramAction, type DiagramFind, type DiagramHandle } from "../stores/diagram";
import { useUiStore } from "../stores/ui";
import { dispatchShortcut, tipFor } from "../lib/commands";
import { useNoticeStore } from "../stores/notice";
import { save } from "@tauri-apps/plugin-dialog";
import MenuList, { type MenuEntry } from "./MenuList.vue";
import Icon from "./Icon.vue";
import { api } from "../lib/api";
import { buildSvg, svgToPng } from "../diagram/export";

/** 思维导图和流程图的标签页：解析文件，能显示时交给对应的编辑器，否则显示原因 */
const props = defineProps<{ tab: Tab }>();
const tabs = useTabsStore();
const vault = useVaultStore();
const settings = useSettingsStore();
const diagram = useDiagramStore();

type Parsed = ParseResult<MindDoc> | ParseResult<FlowDoc>;

function parse(text: string): Parsed {
  return props.tab.kind === "mind" ? parseMind(text, props.tab.name) : parseFlow(text);
}

const result = shallowRef<Parsed>(parse(props.tab.body));

/* ---------- AI 生成思维导图：草稿标签页，或画进空白思维导图 ---------- */
const mindGen = useMindGenStore();
const gen = computed(() => (props.tab.kind === "mind" ? mindGen.gens[props.tab.path] ?? null : null));
const genParsed = computed(() => (gen.value ? aiMindDoc(gen.value.text, props.tab.name, gen.value.layout) : null));
const genNodes = computed(() => (genParsed.value ? countMind(genParsed.value.doc.root) : 0));

async function keepMind() {
  const d = await mindGen.keep(props.tab.path);
  if (!d) return;
  await nextTick();
  editor.value?.replaceDoc?.(d);
}

/* ---------- AI 生成流程图：草稿标签页，或画进空白流程图 ---------- */
const flowGen = useFlowGenStore();
const fgen = computed(() => (props.tab.kind === "flow" ? flowGen.gens[props.tab.path] ?? null : null));
/** 没有完整生成完时只看完整的行；生成中没有新的完整行时不重新解析和排版 */
const fgenSource = computed(() => {
  const g = fgen.value;
  if (!g) return null;
  return g.status === "done" ? g.text : g.text.slice(0, g.text.lastIndexOf("\n") + 1);
});
const fgenParsed = computed(() => {
  const g = fgen.value;
  if (fgenSource.value === null || !g) return null;
  // 生成过程中先不避让，每来一行都重算太慢；结束、停止后再避让，和保留写入的是同一张图
  const r = parseAiFlow(fgenSource.value, g.dir, true, g.status !== "running");
  // 按意见修改时，新的回复还没有节点就先显示修改前的那一版
  if (!r.doc.nodes.length && g.status === "running" && g.prev !== null) return { ...parseAiFlow(g.prev, g.dir), skipped: 0, truncated: false };
  return r;
});
const fgenNodes = computed(() => fgenParsed.value?.doc.nodes.length ?? 0);
const feedback = ref("");

function sendFeedback() {
  if (flowGen.revise(props.tab.path, feedback.value)) feedback.value = "";
}

/** 输入法选字时的回车不发送 */
function onFeedbackKey(e: KeyboardEvent) {
  if (e.isComposing) return;
  e.preventDefault();
  sendFeedback();
}

async function keepFlow() {
  const d = await flowGen.keep(props.tab.path);
  if (!d) return;
  await nextTick();
  editor.value?.replaceDoc?.(d);
}

function onDraftKey(e: KeyboardEvent) {
  const running = gen.value?.status === "running" || fgen.value?.status === "running";
  if (e.key === "Escape" && running) {
    e.preventDefault();
    e.stopPropagation();
    if (fgen.value) flowGen.stop(props.tab.path);
    else mindGen.stop(props.tab.path);
    return;
  }
  if (fgen.value && !running && fgen.value.prev !== null && !(e.target as Element).closest?.("input") && dispatchShortcut(e, "diagram")?.id === "diagram.undo") {
    e.preventDefault();
    e.stopPropagation();
    flowGen.back(props.tab.path);
  }
}
/** 编辑器最近一次写出的内容；标签页正文变成别的内容说明是外部载入的 */
let lastEmitted = props.tab.body;

watch(
  () => props.tab.body,
  (body) => {
    if (body === lastEmitted) return;
    lastEmitted = body;
    result.value = parse(body);
  },
);

function onChange(text: string) {
  lastEmitted = text;
  diagram.version++;
  tabs.update(props.tab.path, text);
}

const ui = useUiStore();
function openFind() {
  if (ui.findOpen) ui.closeFind();
  else ui.openFind(false, "");
}

const view = vault.root ? settings.diagramView(vault.root, props.tab.path) : {};
const zoom = ref(view.zoom ?? 1);
const collapsed = ref<string[]>(view.collapsed ?? []);

function setZoom(z: number) {
  zoom.value = z;
  diagram.zoom = z;
  if (vault.root) settings.patchDiagramView(vault.root, props.tab.path, { zoom: z });
}

function setCollapsed(paths: string[]) {
  collapsed.value = paths;
  if (vault.root) settings.patchDiagramView(vault.root, props.tab.path, { collapsed: paths });
}

function onStats(nodes: number, edges: number, selected: number) {
  diagram.nodes = nodes;
  diagram.edges = edges;
  diagram.selected = selected;
}

const editor = ref<{
  run: (a: DiagramAction) => void;
  focus: () => void;
  selectText: (t: string) => boolean;
  find: DiagramFind;
  svgElement: () => SVGSVGElement | null;
  replaceDoc?: (d: FlowDoc | MindDoc) => void;
} | null>(null);

/* ---------- 导出 ---------- */
const exportAt = ref<{ x: number; y: number } | null>(null);
const notice = useNoticeStore();

function toggleExport(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  exportAt.value = exportAt.value ? null : { x: r.right - 200, y: r.bottom + 4 };
}

function currentSvg() {
  const svg = editor.value?.svgElement();
  if (!svg) throw new Error("图还没有显示出来");
  return buildSvg(svg);
}

async function exportFile(format: "png" | "svg") {
  const dest = await save({
    title: `导出 ${format.toUpperCase()}`,
    defaultPath: `${props.tab.name}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (!dest) return;
  const svg = currentSvg();
  if (format === "svg") await api.writeTextFile(dest, svg.text);
  else await api.writeBinaryFile(dest, new Uint8Array(await (await svgToPng(svg)).arrayBuffer()));
  notice.inform(`已导出到 ${dest}`);
}

async function copyImage() {
  const png = await svgToPng(currentSvg());
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  notice.inform("已复制为图片");
}

const exportItems: MenuEntry[] = [
  { kind: "item", label: "导出 PNG…", action: () => exportFile("png") },
  { kind: "item", label: "导出 SVG…", action: () => exportFile("svg") },
  { kind: "sep" },
  { kind: "item", label: "复制为图片", action: () => copyImage() },
];

function onExportOutside(e: MouseEvent) {
  if (exportAt.value && !(e.target as Element).closest(".export-menu, .export-btn")) exportAt.value = null;
}
onMounted(() => document.addEventListener("mousedown", onExportOutside, true));
onBeforeUnmount(() => document.removeEventListener("mousedown", onExportOutside, true));
const handle: DiagramHandle = {
  path: props.tab.path,
  run: (a) => editor.value?.run(a),
  find: {
    search: (p, current, select) => editor.value?.find.search(p, current, select) ?? 0,
    replaceOne: (current, p, r, regex) => editor.value?.find.replaceOne(current, p, r, regex),
    replaceAll: (p, r, regex) => editor.value?.find.replaceAll(p, r, regex) ?? 0,
    clear: () => editor.value?.find.clear(),
    selectedText: () => editor.value?.find.selectedText() ?? "",
    focus: () => editor.value?.focus(),
    readonly: () => editor.value?.find.readonly() ?? true,
  },
};

/** 从搜索结果打开时选中命中的节点 */
function applyReveal() {
  const r = tabs.pendingReveal;
  if (!r || r.path !== props.tab.path || !editor.value) return;
  tabs.pendingReveal = null;
  if (r.text) void nextTick(() => editor.value?.selectText(r.text!));
}
watch(() => tabs.pendingReveal, applyReveal);

onMounted(() => {
  diagram.attach(handle);
  diagram.zoom = zoom.value;
  applyReveal();
});
onBeforeUnmount(() => diagram.detach(handle));
</script>

<template>
  <div class="diagram-view" @keydown.capture="onDraftKey">
    <template v-if="fgen || (tab.draft && tab.kind === 'flow')">
      <div class="gen-bar" :class="{ 'is-error': fgen?.status === 'error' }">
        <template v-if="!fgen">
          <span>这张流程图已丢弃</span>
        </template>
        <template v-else-if="fgen.status === 'running'">
          <span class="gen-spin" />
          <span>{{ fgen.revising ? "AI 正在按意见修改流程图…" : "AI 正在生成流程图…" }} 已画出 {{ fgenNodes }} 个节点</span>
          <span class="dflex" />
          <button class="plain-btn" type="button" @click="flowGen.stop(tab.path)">停止 <kbd>Esc</kbd></button>
        </template>
        <template v-else>
          <span v-if="fgen.status === 'error'" class="gen-msg">生成出错：{{ fgen.error }}</span>
          <span v-else class="gen-msg">{{ fgen.status === "stopped" ? "已停止" : "已生成" }}，共 {{ fgenNodes }} 个节点</span>
          <span v-if="fgenParsed?.skipped || fgenParsed?.truncated" class="gen-warn">
            <template v-if="fgenParsed.truncated">只采用了前 60 个节点</template><template v-if="fgenParsed.truncated && fgenParsed.skipped">，</template><template v-if="fgenParsed.skipped">跳过 {{ fgenParsed.skipped }} 行无法识别的内容</template>
          </span>
          <input
            v-model="feedback"
            class="gen-input"
            :disabled="!fgenNodes"
            spellcheck="false"
            placeholder="修改意见，例如“驳回后回到提交申请”“审批改成两级”"
            @keydown.enter="onFeedbackKey"
          />
          <button class="plain-btn" type="button" :disabled="!fgenNodes || !feedback.trim() || flowGen.saving[tab.path]" @click="sendFeedback">发送</button>
          <button class="plain-btn" type="button" :disabled="fgen.prev === null || flowGen.saving[tab.path]" title="回到按意见修改之前的那一版 (Ctrl+Z)" @click="flowGen.back(tab.path)">回到上一版</button>
          <button class="plain-btn" type="button" :disabled="flowGen.saving[tab.path]" @click="flowGen.openDialog({ kind: 'regen', path: tab.path })">重新生成</button>
          <span class="gen-sep" />
          <button class="plain-btn" type="button" :disabled="flowGen.saving[tab.path]" @click="flowGen.discard(tab.path)">丢弃</button>
          <button class="btn-primary" type="button" :disabled="!fgenNodes || flowGen.saving[tab.path]" :title="fgen.inplace ? '写进这张流程图' : '保存为新的流程图文件'" @click="keepFlow">{{ flowGen.saving[tab.path] ? "正在保存…" : "保留" }}</button>
        </template>
      </div>
      <FlowEditor v-if="fgenParsed" ref="editor" :doc="fgenParsed.doc" readonly :zoom="zoom" @zoom="setZoom" @stats="onStats" />
    </template>
    <template v-else-if="gen || tab.draft">
      <div class="gen-bar" :class="{ 'is-error': gen?.status === 'error' }">
        <template v-if="!gen">
          <span>这张思维导图已丢弃</span>
        </template>
        <template v-else-if="gen.status === 'running'">
          <span class="gen-spin" />
          <span>{{ gen.source ? `AI 正在根据《${docName(gen.source)}》生成思维导图…` : "AI 正在根据你的描述生成思维导图…" }} 已生成 {{ genNodes }} 个节点</span>
          <span class="dflex" />
          <button class="plain-btn" type="button" @click="mindGen.stop(tab.path)">停止 <kbd>Esc</kbd></button>
        </template>
        <template v-else>
          <span v-if="gen.status === 'error'">生成出错：{{ gen.error }}</span>
          <span v-else>{{ gen.status === "stopped" ? "已停止" : "已生成" }}，共 {{ genNodes }} 个节点<template v-if="genParsed?.skipped">（跳过 {{ genParsed.skipped }} 行无法识别的内容）</template>。{{ gen.inplace ? "保留后才会画进这张图。" : "保留后才会写入文件。" }}</span>
          <span class="dflex" />
          <button v-if="gen.status !== 'done' || !gen.source" class="plain-btn" type="button" :disabled="mindGen.saving[tab.path]" @click="mindGen.regenerate(tab.path)">重新生成</button>
          <button class="plain-btn" type="button" :disabled="mindGen.saving[tab.path]" @click="mindGen.discard(tab.path)">丢弃</button>
          <button class="btn-primary" type="button" :disabled="genNodes < 2 || mindGen.saving[tab.path]" :title="gen.inplace ? '写进这张思维导图' : '保存为新的思维导图文件'" @click="keepMind">{{ mindGen.saving[tab.path] ? "正在保存…" : "保留" }}</button>
        </template>
      </div>
      <MindEditor
        v-if="genParsed"
        ref="editor"
        :doc="genParsed.doc"
        readonly
        :zoom="zoom"
        :collapsed-paths="[]"
        @zoom="setZoom"
        @stats="onStats"
      />
    </template>
    <DiagramIssues v-else-if="!result.ok" :kind="tab.kind" :path="tab.path" :issues="result.issues" />
    <MindEditor
      v-else-if="tab.kind === 'mind'"
      ref="editor"
      :doc="result.doc as MindDoc"
      :zoom="zoom"
      :collapsed-paths="collapsed"
      @change="onChange"
      @zoom="setZoom"
      @collapse="setCollapsed"
      @stats="onStats"
      @ai-generate="mindGen.openDialog({ kind: 'inplace', path: tab.path })"
    >
      <template #bar-end>
        <button class="dbtn" :class="{ 'is-active': ui.findOpen }" :title="tipFor('查找与替换', 'edit.find')" @mousedown.prevent @click="openFind"><Icon name="search" sm />查找</button>
        <button class="dbtn export-btn" :class="{ 'is-active': exportAt }" title="导出" @mousedown.prevent @click="toggleExport">导出 <Icon name="down" sm /></button>
      </template>
    </MindEditor>
    <FlowEditor
      v-else
      ref="editor"
      :doc="result.doc as FlowDoc"
      :zoom="zoom"
      @change="onChange"
      @zoom="setZoom"
      @stats="onStats"
      @ai-generate="flowGen.openDialog({ kind: 'inplace', path: tab.path })"
    >
      <template #bar-end>
        <button class="dbtn" :class="{ 'is-active': ui.findOpen }" :title="tipFor('查找与替换', 'edit.find')" @mousedown.prevent @click="openFind"><Icon name="search" sm />查找</button>
        <button class="dbtn export-btn" :class="{ 'is-active': exportAt }" title="导出" @mousedown.prevent @click="toggleExport">导出 <Icon name="down" sm /></button>
      </template>
    </FlowEditor>
    <MenuList v-if="exportAt" class="export-menu" :items="exportItems" :at="exportAt" @done="exportAt = null" />
    <div v-if="!tab.draft" class="diagram-backlinks"><BacklinksPanel :path="tab.path" /></div>
  </div>
</template>
