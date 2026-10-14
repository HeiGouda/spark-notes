<script lang="ts">
/** 笔记阅读位置。编辑器被拆掉重建后还要能还原，不能放在某个组件实例上 */
const scrollMemory = new Map<string, number>();
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useSettingsStore } from "../stores/settings";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import BacklinksPanel from "./BacklinksPanel.vue";
import Icon from "./Icon.vue";
import { externalUrl } from "../editor/link";
import { parseWiki } from "../editor/wikilink";
import { goToHeading, goToText, type Heading } from "../editor/navigate";
import { contentCandidates, linkCandidates, linkDisplay, resolveLink } from "../lib/links";
import { DOC_LABEL } from "../lib/doctype";
import { isBookPath } from "../lib/book";
import { inlineTags, mergeTags, parseTagInput } from "../lib/tags";
import { useUiStore } from "../stores/ui";
import { dispatchShortcut, runCommand, shortcutOf } from "../lib/commands";
import { displayShortcut } from "../lib/shortcut";
import { commandIdOf } from "../editor/formatActions";
import { editorViewCtx, type Editor } from "@milkdown/kit/core";
import { Selection } from "@milkdown/kit/prose/state";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useVaultStore } from "../stores/vault";
import { api, baseName, dirOf } from "../lib/api";
import { attachmentName, isImageName, type SavedAttachment } from "../editor/attachments";
import { createEditor, readMarkdown } from "../editor/createEditor";
import { useTabsStore, type Tab } from "../stores/tabs";
import { useEditorStore } from "../stores/editor";
import { useNoticeStore } from "../stores/notice";
import { useContextMenuStore } from "../stores/contextMenu";
import { useFlowGenStore } from "../stores/flowGen";
import { useMindGenStore } from "../stores/mindGen";

const props = defineProps<{ tab: Tab }>();

const tabs = useTabsStore();
const settings = useSettingsStore();
const editorStore = useEditorStore();
const ui = useUiStore();
const host = ref<HTMLElement | null>(null);
let editor: Editor | null = null;
let destroyed = false;
let mountId = 0;
/** 正在用磁盘内容重建编辑器，此期间的回调不能把旧正文写回标签页 */
let applyingDisk = false;
/** Milkdown 载入时会规范化 Markdown；未编辑时不因规范化结果写回文件 */
let baseline: string | null = null;
let cachedWords = 0;
let cachedHeadings: Heading[] = [];
let boundPath = "";
/** 这次切换是跳到搜索命中或标题，不要再用上次的滚动位置盖掉 */
let revealed = false;

function isCurrent() {
  return tabs.activePath === props.tab.path;
}

/** 斜杠菜单的 h1~h3 对应标题级别命令，其余对应格式工具的命令 */
function formatCommandId(id: string): string {
  return /^h\d$/.test(id) ? `format.${id}` : commandIdOf(id);
}

/* ---------- 右键菜单：选中文字时可以用来生成流程图、思维导图，没有选中时保持系统菜单 ---------- */
const ctxMenu = useContextMenuStore();
function onEditorMenu(e: MouseEvent) {
  const text = editorStore.path === props.tab.path ? editorStore.selectionText().trim() : "";
  if (!text) return;
  ctxMenu.show(e, [
    { kind: "item", label: "剪切", command: "edit.cut" },
    { kind: "item", label: "复制", command: "edit.copy" },
    { kind: "item", label: "粘贴", command: "edit.paste" },
    { kind: "sep" },
    { kind: "item", label: "用选中文字生成流程图", action: () => useFlowGenStore().openDialog({ kind: "folder", folder: dirOf(props.tab.path) }, text) },
    { kind: "item", label: "用选中文字生成思维导图", action: () => useMindGenStore().openDialog({ kind: "folder", folder: dirOf(props.tab.path) }, text) },
  ]);
}

/* ---------- 附件 ---------- */
const vault = useVaultStore();

/** 解析 `a/./b/../c` 这类相对路径 */
function normalizeRel(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function resolveSrc(src: string): string {
  if (!src) return src;
  if (/^[a-zA-Z]:[\\/]/.test(src)) return convertFileSrc(src);
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
  let decoded = src;
  try {
    decoded = decodeURI(src);
  } catch {
    // 不是合法的 URI 编码时按原文处理
  }
  const dir = dirOf(props.tab.path);
  return convertFileSrc(vault.absolutePath(normalizeRel(dir ? `${dir}/${decoded}` : decoded)));
}

async function saveFile(file: File): Promise<SavedAttachment> {
  if (!vault.root) throw new Error("未打开笔记库");
  const name = attachmentName(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const link = await api.saveAttachment(vault.root, props.tab.path, name, bytes);
  return { link, name, isImage: file.type.startsWith("image/") || isImageName(name) };
}

function accept(markdown: string) {
  if (applyingDisk) return;
  const tab = tabs.tabs.find((t) => t.path === props.tab.path);
  if (!tab) return;
  if (markdown === baseline && tab.body === tab.savedBody) return;
  tabs.update(tab.path, markdown);
}

function flush() {
  if (editor) accept(readMarkdown(editor));
}

async function destroyEditor() {
  if (!editor) return;
  const old = editor;
  editor = null;
  editorStore.detach(old);
  await old.destroy();
}

/** 这篇笔记重新成为当前项：工具栏和状态栏改看它，不改滚动位置 */
function claim() {
  if (!editor || !isCurrent()) return;
  editorStore.attach(editor, props.tab.path, flush);
  editorStore.words = cachedWords;
  editorStore.headings = cachedHeadings;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setMeta("addToHistory", false));
  });
}

function blurEditor() {
  editor?.action((ctx) => {
    const dom = ctx.get(editorViewCtx).dom as HTMLElement;
    if (dom.contains(document.activeElement)) dom.blur();
  });
}

/** 切走后收起浮层。表格工具条挂在 body 上，编辑器隐藏后还要再排一次才会自己关掉 */
function park() {
  if (!editor) return;
  flush();
  blurEditor();
  editorStore.detach(editor);
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (view.dom instanceof HTMLElement && view.dom.offsetParent === null) {
      view.dispatch(view.state.tr.setMeta("addToHistory", false));
    }
  });
}

function restoreScroll() {
  if (revealed) {
    revealed = false;
    return;
  }
  const top = scrollMemory.get(props.tab.path) ?? 0;
  if (top <= 0) return;
  requestAnimationFrame(() => {
    const el = scroller.value;
    if (!el || el.scrollTop > 0) return;
    el.scrollTop = top;
  });
}

/** 用给定正文新建编辑器。同一路径被重新载入时也走这里，避免屏幕上仍是旧正文、再输入时把磁盘内容盖掉。 */
async function mountEditor(markdown: string) {
  const kept = scroller.value?.scrollTop ?? 0;
  if (kept > 0) scrollMemory.set(props.tab.path, kept);
  const id = ++mountId;
  applyingDisk = true;
  await destroyEditor();
  if (destroyed || id !== mountId || !host.value) {
    if (id === mountId) applyingDisk = false;
    return;
  }
  host.value.replaceChildren();
  try {
    const e = await createEditor({
      root: host.value,
      markdown,
      onChange: accept,
      onCursor: (info) => {
        if (!isCurrent()) return;
        editorStore.block = info.block;
        editorStore.marks = info.marks;
        editorStore.line = info.line;
        editorStore.col = info.col;
        editorStore.cursor = info.pos;
      },
      onWords: (n) => {
        cachedWords = n;
        if (isCurrent()) editorStore.words = n;
      },
      onOutline: (h) => {
        cachedHeadings = h;
        if (isCurrent()) editorStore.headings = h;
      },
      onDocChange: () => {
        if (isCurrent()) editorStore.docVersion++;
      },
      onOpenLink: (href) => {
        const url = externalUrl(href);
        if (url) {
          openUrl(url).catch((err) => useNoticeStore().report("打开链接失败", err));
          return;
        }
        const path = resolveLink(href, props.tab.path, vault.linkPaths);
        if (path) {
          void tabs.open(path);
          return;
        }
        useNoticeStore().report("无法打开链接", href);
      },
      onKey: (event) => {
        const cmd = dispatchShortcut(event, "editor");
        if (!cmd) return false;
        runCommand(cmd.id).catch((err) => useNoticeStore().report(`执行“${cmd.title}”失败`, err));
        return true;
      },
      format: {
        run: (id) => {
          runCommand(formatCommandId(id)).catch((err) => useNoticeStore().report("执行格式操作失败", err));
        },
        shortcut: (id) => displayShortcut(shortcutOf(formatCommandId(id))) || null,
      },
      onError: (context, err) => useNoticeStore().report(context, err),
      attachments: { resolve: resolveSrc, save: saveFile },
      wiki: {
        candidates: (q) => linkCandidates(q, vault.linkPaths, props.tab.path),
        search: async (q, limit) => {
          if (!vault.root) return [];
          const hits = await api.search(vault.root, q, limit);
          const snippets = new Map(hits.map((h) => [h.path, h.snippet]));
          return contentCandidates(hits.map((h) => h.path), vault.linkPaths, props.tab.path).map((c) => ({ ...c, snippet: snippets.get(c.path) }));
        },
        open: (value) => void openWiki(value),
      },
    });
    if (destroyed || id !== mountId) {
      e.destroy();
      return;
    }
    editor = e;
    host.value?.querySelector(".pm")?.setAttribute("spellcheck", settings.spellcheck ? "true" : "false");
    baseline = readMarkdown(e);
    if (boundPath && boundPath !== props.tab.path) editorStore.unbind(boundPath, flush);
    boundPath = props.tab.path;
    editorStore.bind(boundPath, flush);
    const reveal = tabs.pendingReveal?.path === props.tab.path;
    if (isCurrent()) claim();
    applyReveal();
    if (!reveal) restoreScroll();
  } catch (err) {
    if (!destroyed && id === mountId) useNoticeStore().report(`编辑器初始化失败 ${props.tab.name}`, err);
  } finally {
    if (id === mountId) applyingDisk = false;
  }
}

onMounted(() => {
  void mountEditor(props.tab.body);
});

watch(
  () => props.tab,
  (tab, prev) => {
    if (!prev || tab === prev || tab.path !== prev.path) return;
    void mountEditor(tab.body);
  },
  { deep: false },
);

watch(
  () => tabs.activePath === props.tab.path,
  (on) => {
    if (on) return;
    const top = scroller.value?.scrollTop ?? 0;
    if (top > 0) scrollMemory.set(props.tab.path, top);
  },
);
watch(
  () => tabs.activePath === props.tab.path,
  (on) => {
    if (!editor) return;
    if (on) {
      claim();
      restoreScroll();
    } else park();
  },
  { flush: "post" },
);

/* ---------- 双向链接、定位、标签 ---------- */
/** 正文里的 #标签（不含已写在 Front Matter 里的），只能在正文中修改 */
const bodyTags = computed(() => {
  const own = new Set(props.tab.tags.map((t) => t.toLowerCase()));
  return mergeTags(inlineTags(props.tab.body)).filter((t) => !own.has(t.toLowerCase()));
});

const tagListId = computed(() => `note-tags-${encodeURIComponent(props.tab.path)}`);
const addingTag = ref(false);
const tagDraft = ref("");
const tagInput = ref<HTMLInputElement | null>(null);
const knownTags = ref<string[]>([]);

async function startTag() {
  addingTag.value = true;
  tagDraft.value = "";
  await nextTick();
  tagInput.value?.focus();
  if (!vault.root) return;
  try {
    knownTags.value = (await api.tags(vault.root)).map((t) => t.tag);
  } catch {
    // 索引还没建好时不提供候选，不影响添加
  }
}

function commitTag() {
  if (!addingTag.value) return;
  addingTag.value = false;
  const { tags, invalid } = parseTagInput(tagDraft.value);
  if (invalid.length) useNoticeStore().inform(`未添加：${invalid.join("、")}。标签只能包含文字、数字、_ - /，且不能全是数字`);
  if (tags.length) tabs.setTags(props.tab.path, mergeTags(props.tab.tags, tags));
}

function cancelTag() {
  addingTag.value = false;
}

function removeTag(tag: string) {
  tabs.setTags(props.tab.path, props.tab.tags.filter((t) => t !== tag));
}

async function openWiki(value: string) {
  const { target, heading } = parseWiki(value);
  if (!vault.root) return;
  if (!target) {
    if (heading && editor) goToHeading(editor, heading);
    return;
  }
  const path = resolveLink(target, props.tab.path, vault.linkPaths);
  if (path) return tabs.openAt(path, heading ? { heading } : {});
  // 表格簿只能在文件树里新建，链接指向不存在的表格簿时不提示创建笔记
  if (isBookPath(target)) {
    useNoticeStore().report("无法打开链接", `表格簿“${linkDisplay(target).label}”不存在`);
    return;
  }
  const { label, kind } = linkDisplay(target.replace(/\.mmd$/i, ""));
  const what = DOC_LABEL[kind ?? "note"];
  const create = await ask(`${what}“${label}”不存在，是否创建？`, {
    title: "Spark",
    kind: "info",
    okLabel: "创建",
    cancelLabel: "取消",
  });
  if (!create) return;
  const clean = label.replace(/\\/g, "/").replace(/\.md$/i, "");
  const dir = clean.includes("/") ? dirOf(clean) : dirOf(props.tab.path);
  try {
    const rel = await api.createNote(vault.root, dir, baseName(clean), kind ?? "note");
    await vault.refresh();
    await tabs.open(rel);
  } catch (e) {
    useNoticeStore().report(`创建${what}“${label}”失败`, e);
  }
}

/** 从搜索结果、反向链接或 [[笔记#标题]] 打开时，定位到对应位置 */
function applyReveal() {
  const r = tabs.pendingReveal;
  if (!r || !editor || r.path !== props.tab.path) return;
  tabs.pendingReveal = null;
  revealed = true;
  const e = editor;
  requestAnimationFrame(() => {
    if (r.heading) goToHeading(e, r.heading);
    else if (r.text) goToText(e, r.text);
    revealed = false;
  });
}
watch(() => tabs.pendingReveal, applyReveal);

/* ---------- 标题即文件名：直接修改标题来重命名 ---------- */
const titleEl = ref<HTMLElement | null>(null);
let titleBusy = false;

function resetTitle() {
  if (titleEl.value) titleEl.value.textContent = props.tab.name;
}

function focusEditorStart() {
  editor?.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setSelection(Selection.atStart(view.state.doc)));
    view.focus();
  });
}

function onTitleKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    titleEl.value?.blur();
    focusEditorStart();
  } else if (e.key === "Escape") {
    e.preventDefault();
    resetTitle();
    titleEl.value?.blur();
  }
}

function onTitlePaste(e: ClipboardEvent) {
  e.preventDefault();
  const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\s*\n\s*/g, " ");
  document.execCommand("insertText", false, text);
}

async function commitTitle() {
  const value = (titleEl.value?.textContent ?? "").trim();
  if (titleBusy || value === props.tab.name) return resetTitle();
  if (!value) return resetTitle();
  titleBusy = true;
  const rel = await vault.rename(props.tab.path, value);
  titleBusy = false;
  // 失败时恢复原名；成功后标签页路径变化，本组件会以新路径重新挂载
  if (!rel) resetTitle();
}

watch(() => settings.spellcheck, (on) => {
  host.value?.querySelector(".pm")?.setAttribute("spellcheck", on ? "true" : "false");
});

/* ---------- 回到顶部、Ctrl+滚轮调字号 ---------- */
const scroller = ref<HTMLElement | null>(null);
const showTop = ref(false);
const sizeHint = ref(false);
let hintTimer = 0;
/** 触控板捏合会连续发出很小的 deltaY，累计到一格滚轮的量再调一次 */
let wheelAcc = 0;

function onScroll() {
  const el = scroller.value;
  if (!el) return;
  showTop.value = el.scrollTop > el.clientHeight;
  scrollMemory.set(props.tab.path, el.scrollTop);
}

function toTop() {
  scroller.value?.scrollTo({ top: 0, behavior: "smooth" });
}

function onWheel(e: WheelEvent) {
  if ((!e.ctrlKey && !e.metaKey) || !settings.wheelFontSize) return;
  e.preventDefault();
  if (Math.sign(e.deltaY) !== Math.sign(wheelAcc)) wheelAcc = 0;
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) < 50) return;
  const next = settings.editorFontSize + (wheelAcc < 0 ? 1 : -1);
  wheelAcc = 0;
  if (next >= 13 && next <= 24) settings.patchEditor({ editorFontSize: next });
  sizeHint.value = true;
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => (sizeHint.value = false), 1000);
}

onBeforeUnmount(() => {
  clearTimeout(hintTimer);
  destroyed = true;
  mountId++;
  const top = scroller.value?.scrollTop;
  if (top != null) scrollMemory.set(props.tab.path, top);
  if (editor && !applyingDisk) accept(readMarkdown(editor));
  if (boundPath) editorStore.unbind(boundPath, flush);
  void destroyEditor();
});
</script>

<template>
  <div class="editor-pane">
    <div ref="scroller" class="editor" @scroll.passive="onScroll" @wheel="onWheel">
      <article class="doc">
        <h1
          ref="titleEl"
          class="doc-title"
          contenteditable="plaintext-only"
          spellcheck="false"
          title="修改标题即重命名笔记"
          @keydown="onTitleKey"
          @blur="commitTitle"
          @paste="onTitlePaste"
        >{{ tab.name }}</h1>
        <div class="doc-meta">
          <span v-for="t in tab.tags" :key="`fm:${t}`" class="chip">
            <button class="chip-name" type="button" :title="`搜索带有 #${t} 的笔记`" @click="ui.search(`#${t}`)">{{ t }}</button>
            <button class="chip-x" type="button" :title="`移除标签“${t}”`" @click="removeTag(t)">×</button>
          </span>
          <button v-for="t in bodyTags" :key="`body:${t}`" class="chip" type="button" :title="`搜索带有 #${t} 的笔记\n这个标签写在正文里，在正文中修改或删除`" @click="ui.search(`#${t}`)">{{ t }}</button>
          <input
            v-if="addingTag"
            ref="tagInput"
            v-model="tagDraft"
            class="tag-input"
            :list="tagListId"
            placeholder="输入标签，回车添加"
            spellcheck="false"
            @keydown.enter.prevent="commitTag()"
            @keydown.esc.prevent.stop="cancelTag()"
            @blur="commitTag()"
          />
          <button v-else class="tag-add" type="button" title="添加标签（多个用空格分隔）" @click="startTag()">+ 标签</button>
          <datalist :id="tagListId"><option v-for="t in knownTags" :key="t" :value="t" /></datalist>
          <span v-if="tab.created" class="date">创建于 {{ tab.created }}</span>
        </div>
        <div ref="host" @contextmenu="onEditorMenu" />
      </article>
      <BacklinksPanel :path="tab.path" />
    </div>
    <div v-if="sizeHint" class="doc-size-hint">字号 {{ settings.editorFontSize }}px</div>
    <button v-if="showTop" class="to-top" type="button" title="回到顶部" @click="toTop"><Icon name="up" /></button>
  </div>
</template>
