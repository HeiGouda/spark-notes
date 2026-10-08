<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import type { MenuEntry } from "./MenuList.vue";
import { sheetNameProblem } from "../lib/book";
import { DOC_ICON, DOC_LABEL, type DocKind } from "../lib/doctype";
import { useBookStore, type SheetItem } from "../stores/book";
import { useTabsStore } from "../stores/tabs";
import { useContextMenuStore } from "../stores/contextMenu";
import { useMindGenStore } from "../stores/mindGen";
import { useFlowGenStore } from "../stores/flowGen";
import { useNoticeStore } from "../stores/notice";

const book = useBookStore();
const tabs = useTabsStore();
const ctxMenu = useContextMenuStore();
const notice = useNoticeStore();

const listEl = ref<HTMLElement | null>(null);
const overflow = ref(false);
const real = computed(() => book.sheets.filter((s) => !s.draft));

function measure() {
  const el = listEl.value;
  overflow.value = !!el && el.scrollWidth > el.clientWidth + 1;
}

let observer: ResizeObserver | null = null;
onMounted(() => {
  if (listEl.value) {
    observer = new ResizeObserver(measure);
    observer.observe(listEl.value);
  }
  measure();
});
onBeforeUnmount(() => observer?.disconnect());

/** 当前表始终滚动到可见范围内 */
async function revealActive() {
  await nextTick();
  measure();
  listEl.value?.querySelector<HTMLElement>(".sheet.is-active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
}
watch(() => [tabs.activePath, book.sheets.length], revealActive, { flush: "post" });
onMounted(revealActive);

function scrollBy(dir: number) {
  listEl.value?.scrollBy({ left: dir * 160, behavior: "smooth" });
}

function onWheel(e: WheelEvent) {
  if (!overflow.value || !listEl.value) return;
  e.preventDefault();
  listEl.value.scrollLeft += e.deltaY || e.deltaX;
}

/* ---------- 新建 ---------- */
const NEW_KINDS: DocKind[] = ["note", "mind", "flow"];

function onPlus(e: MouseEvent) {
  ctxMenu.show(
    e,
    NEW_KINDS.map((kind): MenuEntry => ({ kind: "item", label: DOC_LABEL[kind], action: () => book.newSheet(kind) })),
  );
}

/* ---------- 右键菜单 ---------- */
function bodyOf(path: string): string {
  return tabs.tabs.find((t) => t.path === path)?.body ?? "";
}

function onMenu(e: MouseEvent, s: SheetItem) {
  if (s.draft) return;
  const only = real.value.length <= 1;
  const items: MenuEntry[] = [
    { kind: "item", label: "重命名", hint: "双击", action: () => (book.renaming = s.path) },
    { kind: "item", label: "复制", action: () => book.duplicateSheet(s.path) },
    {
      kind: "item",
      label: "删除",
      disabled: only,
      title: only ? "表格簿至少保留一张表；要删除整个表格簿，请在侧边栏操作" : undefined,
      action: () => book.deleteSheet(s.path),
    },
  ];
  if (s.kind === "note" && book.activeBook) {
    const folder = book.activeBook;
    items.push(
      { kind: "sep" },
      { kind: "item", label: "用 AI 生成思维导图", action: () => useMindGenStore().start(s.path) },
      {
        kind: "item",
        label: "用 AI 生成流程图",
        action: () => useFlowGenStore().openDialog({ kind: "folder", folder }, bodyOf(s.path).trim()),
      },
    );
  }
  ctxMenu.show(e, items);
}

/* ---------- 就地改名 ---------- */
const draft = ref("");
let input = null as HTMLInputElement | null;
const names = computed(() => real.value.map((s) => s.name));
const problem = computed(() => {
  const cur = book.sheets.find((s) => s.path === book.renaming);
  return cur ? sheetNameProblem(draft.value, names.value, cur.name) : null;
});
let committing = false;
/** 红色提示显示在输入框上方 */
const tipPos = ref<{ x: number; y: number } | null>(null);

watch(
  [problem, draft],
  async () => {
    await nextTick();
    const r = input?.getBoundingClientRect();
    tipPos.value = r ? { x: r.left, y: r.top - 26 } : null;
  },
  { flush: "post" },
);

watch(
  () => book.renaming,
  async (path) => {
    if (!path) return;
    draft.value = book.sheets.find((s) => s.path === path)?.name ?? "";
    await nextTick();
    input?.focus();
    input?.select();
  },
  { flush: "post" },
);

async function commit(s: SheetItem, viaBlur: boolean) {
  if (committing || book.renaming !== s.path) return;
  const err = problem.value;
  if (err) {
    // 回车时保持输入框打开让用户改；点别处离开时放弃改名并说明原因
    if (!viaBlur) return;
    book.renaming = null;
    notice.inform(err);
    return;
  }
  committing = true;
  const value = draft.value.trim();
  book.renaming = null;
  try {
    if (value !== s.name) await book.renameSheet(s.path, value);
  } finally {
    committing = false;
  }
}

function onRenameKey(e: KeyboardEvent, s: SheetItem) {
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    void commit(s, false);
  } else if (e.key === "Escape") {
    e.preventDefault();
    book.renaming = null;
  }
}

function onSheetClick(s: SheetItem) {
  if (book.renaming === s.path) return;
  if (s.draft) tabs.activate(s.path);
  else void book.openSheet(s.path);
}

/* ---------- 拖动排序 ---------- */
const dragFrom = ref<number | null>(null);
const dropAt = ref<number | null>(null);

function onDragStart(e: DragEvent, i: number, s: SheetItem) {
  if (s.draft || book.renaming) return e.preventDefault();
  dragFrom.value = i;
  e.dataTransfer?.setData("application/x-spark-sheet", String(i));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

function onDragOver(e: DragEvent, i: number, s: SheetItem) {
  if (dragFrom.value === null || s.draft) return;
  e.preventDefault();
  dropAt.value = i;
}

function onDrop(i: number) {
  const from = dragFrom.value;
  dragFrom.value = dropAt.value = null;
  if (from !== null) void book.reorder(from, i);
}

/* ---------- 全部表 ---------- */
function onAll(e: MouseEvent) {
  ctxMenu.show(
    e,
    book.sheets.map((s): MenuEntry => ({
      kind: "item",
      label: s.draft ? `${s.name}（草稿）` : s.name,
      checked: () => s.path === tabs.activePath,
      action: () => onSheetClick(s),
    })),
  );
}

const unsupportedTip = computed(() => `这些项目无法显示成表：\n${book.unsupported.join("\n")}\n点击在文件管理器中打开这个文件夹`);
</script>

<template>
  <footer class="sheetbar" role="tablist" aria-label="表格簿里的表">
    <button class="sheet-btn sheet-plus" title="新建表" @click="onPlus($event)"><Icon name="plus" sm /></button>
    <button v-if="overflow" class="sheet-btn" title="向左滚动" @click="scrollBy(-1)"><Icon name="left" sm /></button>
    <div ref="listEl" class="sheet-list" @wheel="onWheel">
      <template v-for="(s, i) in book.sheets" :key="s.path">
        <span v-if="dropAt === i && dragFrom !== null && dragFrom !== i" class="sheet-ins" />
        <div
          class="sheet"
          :class="{ 'is-active': s.path === tabs.activePath, 'is-draft': s.draft, 'is-drag': dragFrom === i, 'is-renaming': book.renaming === s.path }"
          role="tab"
          :aria-selected="s.path === tabs.activePath"
          :title="s.draft ? `${s.name}（AI 生成中的草稿）` : s.name"
          :draggable="!s.draft && book.renaming !== s.path"
          @click="onSheetClick(s)"
          @dblclick="!s.draft && (book.renaming = s.path)"
          @contextmenu="onMenu($event, s)"
          @dragstart="onDragStart($event, i, s)"
          @dragover="onDragOver($event, i, s)"
          @drop.prevent="onDrop(i)"
          @dragend="dragFrom = dropAt = null"
        >
          <Icon :name="DOC_ICON[s.kind]" sm />
          <template v-if="book.renaming === s.path">
            <input
              :ref="(el) => (input = el as HTMLInputElement | null)"
              v-model="draft"
              class="sheet-rename"
              :class="{ 'is-bad': problem }"
              spellcheck="false"
              @click.stop
              @dblclick.stop
              @keydown="onRenameKey($event, s)"
              @blur="commit(s, true)"
            />
          </template>
          <template v-else>
            <span class="name">{{ s.name }}</span>
            <span v-if="s.draft" class="sheet-badge">草稿</span>
          </template>
        </div>
      </template>
    </div>
    <button v-if="overflow" class="sheet-btn" title="向右滚动" @click="scrollBy(1)"><Icon name="right" sm /></button>
    <button v-if="overflow" class="sheet-btn" title="全部表" @click="onAll($event)"><Icon name="menu" sm /></button>
    <span class="sheet-flex" />
    <!-- 提示放在标签列表外面：列表横向滚动时会裁掉超出它的内容 -->
    <span v-if="problem && book.renaming && tipPos" class="sheet-tip" role="alert" :style="{ left: `${tipPos.x}px`, top: `${tipPos.y}px` }">{{ problem }}</span>
    <span v-if="book.warning" class="sheet-warn" :title="book.warning">
      <Icon name="alert" sm />{{ book.warning }}
    </span>
    <button v-if="book.unsupported.length" class="sheet-warn" :title="unsupportedTip" @click="book.revealBook()">
      <Icon name="alert" sm />有 {{ book.unsupported.length }} 个项目无法显示
    </button>
  </footer>
</template>
