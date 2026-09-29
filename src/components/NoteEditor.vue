<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useSettingsStore } from "../stores/settings";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import BacklinksPanel from "./BacklinksPanel.vue";
import { externalUrl } from "../editor/link";
import { parseWiki } from "../editor/wikilink";
import { goToHeading, goToText } from "../editor/navigate";
import { linkCandidates, resolveLink } from "../lib/links";
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

const props = defineProps<{ tab: Tab }>();

const tabs = useTabsStore();
const settings = useSettingsStore();
const editorStore = useEditorStore();
const host = ref<HTMLElement | null>(null);
let editor: Editor | null = null;
let destroyed = false;
let mountId = 0;
/** 正在用磁盘内容重建编辑器，此期间的回调不能把旧正文写回标签页 */
let applyingDisk = false;
/** Milkdown 载入时会规范化 Markdown；未编辑时不因规范化结果写回文件 */
let baseline: string | null = null;

/** 斜杠菜单的 h1~h3 对应标题级别命令，其余对应格式工具的命令 */
function formatCommandId(id: string): string {
  return /^h\d$/.test(id) ? `format.${id}` : commandIdOf(id);
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

async function destroyEditor() {
  if (!editor) return;
  const old = editor;
  editor = null;
  editorStore.detach(old);
  await old.destroy();
}

/** 用给定正文新建编辑器。同一路径被重新载入时也走这里，避免屏幕上仍是旧正文、再输入时把磁盘内容盖掉。 */
async function mountEditor(markdown: string) {
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
        editorStore.block = info.block;
        editorStore.marks = info.marks;
        editorStore.line = info.line;
        editorStore.col = info.col;
        editorStore.cursor = info.pos;
      },
      onWords: (n) => (editorStore.words = n),
      onOutline: (h) => (editorStore.headings = h),
      onDocChange: () => editorStore.docVersion++,
      onOpenLink: (href) => {
        const url = externalUrl(href);
        if (url) {
          openUrl(url).catch((err) => useNoticeStore().report("打开链接失败", err));
          return;
        }
        const path = resolveLink(href, props.tab.path, vault.notePaths);
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
        candidates: (q) => linkCandidates(q, vault.notePaths, props.tab.path),
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
    editorStore.attach(e, props.tab.path, () => editor && accept(readMarkdown(editor)));
    applyReveal();
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

/* ---------- 双向链接、定位、标签 ---------- */
const ui = useUiStore();
/** 正文里的 #标签（不含已写在 Front Matter 里的），只能在正文中修改 */
const bodyTags = computed(() => {
  const own = new Set(props.tab.tags.map((t) => t.toLowerCase()));
  return mergeTags(inlineTags(props.tab.body)).filter((t) => !own.has(t.toLowerCase()));
});

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
  const path = resolveLink(target, props.tab.path, vault.notePaths);
  if (path) return tabs.openAt(path, heading ? { heading } : {});
  const create = await ask(`笔记“${target}”不存在，是否创建？`, {
    title: "Spark",
    kind: "info",
    okLabel: "创建",
    cancelLabel: "取消",
  });
  if (!create) return;
  const clean = target.replace(/\\/g, "/").replace(/\.md$/i, "");
  const dir = clean.includes("/") ? dirOf(clean) : dirOf(props.tab.path);
  try {
    const rel = await api.createNote(vault.root, dir, baseName(clean));
    await vault.refresh();
    await tabs.open(rel);
  } catch (e) {
    useNoticeStore().report(`创建笔记“${target}”失败`, e);
  }
}

/** 从搜索结果、反向链接或 [[笔记#标题]] 打开时，定位到对应位置 */
function applyReveal() {
  const r = tabs.pendingReveal;
  if (!r || !editor || r.path !== props.tab.path) return;
  tabs.pendingReveal = null;
  const e = editor;
  requestAnimationFrame(() => {
    if (r.heading) goToHeading(e, r.heading);
    else if (r.text) goToText(e, r.text);
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

onBeforeUnmount(() => {
  destroyed = true;
  mountId++;
  if (!editor) return;
  if (!applyingDisk) accept(readMarkdown(editor));
  void destroyEditor();
});
</script>

<template>
  <div class="editor">
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
          list="note-tag-options"
          placeholder="输入标签，回车添加"
          spellcheck="false"
          @keydown.enter.prevent="commitTag()"
          @keydown.esc.prevent.stop="cancelTag()"
          @blur="commitTag()"
        />
        <button v-else class="tag-add" type="button" title="添加标签（多个用空格分隔）" @click="startTag()">+ 标签</button>
        <datalist id="note-tag-options"><option v-for="t in knownTags" :key="t" :value="t" /></datalist>
        <span v-if="tab.created" class="date">创建于 {{ tab.created }}</span>
      </div>
      <div ref="host" />
    </article>
    <BacklinksPanel :path="tab.path" />
  </div>
</template>
