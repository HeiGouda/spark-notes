<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import Icon from "../Icon.vue";
import { mobileApi, type ReadPoint } from "../api";
import { bookStem, useShelf } from "../shelf";
import { decodeTxt, txtBook } from "../reader/txt";
import { parseReadingNote, readingNoteRel, renderReadingNote, toggleBookmark, withAnno, type Anno, type Bookmark } from "../reader/anno";
import { READER_THEMES, isReaderFont, readerCss, tocDepth, type ReaderFont, type ReaderTheme } from "../reader/style";
import serifFont from "../fonts/NotoSerifSC-Regular-gb2312.woff2?url";
import kaiFont from "../fonts/LXGWWenKai-Regular-gb2312.woff2?url";
import { api, type TreeNode } from "../../lib/api";
import { isDarkTheme } from "../../lib/themes";
import { timeLabel } from "../browse";
import { useMobile } from "../store";
import AiSheet from "../chat/AiSheet.vue";
import { addBackInterceptor, back, currentOverlay, open, openDoc, toast } from "../nav";
import { ask } from "../dialog";

const PREFS = "spark-ebook";

const props = defineProps<{ id: string }>();
const shelf = useShelf();
const store = useMobile();

const host = ref<HTMLElement | null>(null);
const error = ref("");
/** 书页准备好之前先不显示（见 revealWhenStyled） */
const ready = ref(false);
const chrome = ref(false);
const fraction = ref(0);
const chapter = ref("");
const chapterHref = ref("");
const title = ref("");
const info = ref("");
/** 底部面板：目录 / 笔记 / 书签三个标签在同一个面板里 */
const sheet = ref<"" | "panel" | "settings" | "info">("");
const tab = ref<"toc" | "notes" | "marks">("toc");
const toc = ref<{ label: string; href: string; depth: number; percent: number | null }[]>([]);
const dragging = ref<number | null>(null);
const backTo = ref<number | null>(null);
const annos = ref<Anno[]>([]);
const summary = ref("");
const marks = ref<Bookmark[]>([]);
const missing = ref(new Set<string>());
/** 选中文字后的菜单；cfi 对应已有划线时是划线菜单 */
const pick = ref<{ cfi: string; text: string; top: number; left: number; below: boolean } | null>(null);
/** 写感悟的输入框：anno 是要写进去的那一条（新的还没存时 isNew 为 true） */
const editing = ref<{ anno: Anno; isNew: boolean } | null>(null);
/** 写读完后的总结，和单条感悟共用同一个输入框 */
const editingSummary = ref(false);
const draft = ref("");
const currentCfi = ref("");
const excerpt = ref("");
const swiped = ref<string | null>(null);
let fileName = "";
let authorName = "";
let noteRel = "";
let pdfBook = false;
let activeDoc: Document | null = null;

const size = ref(18);
const leading = ref<"紧凑" | "标准" | "宽松">("标准");
const margin = ref<"窄" | "标准" | "宽">("标准");
const theme = ref<ReaderTheme>("浅色");
const flow = ref<"左右翻页" | "上下滚动">("左右翻页");
const font = ref<ReaderFont>("书籍自带");
/** 左右翻页时的动画 */
const TURN_ANIMS = ["平移", "淡入淡出", "无动画"] as const;
const turnAnim = ref<(typeof TURN_ANIMS)[number]>("平移");
const FONT_FILES = { serif: new URL(serifFont, location.href).href, kai: new URL(kaiFont, location.href).href };

/** 页边距：左右是页面宽度的百分比，上下留给页眉页脚 */
const GAP = { 窄: "4%", 标准: "7%", 宽: "12%" } as const;

const palette = computed(() => READER_THEMES[theme.value]);
const scrolled = computed(() => flow.value === "上下滚动");
/** 整个阅读页（包括菜单、面板）用阅读主题的颜色，不跟 App 的主题 */
const themeVars = computed(() => {
  const p = palette.value;
  return {
    "--paper": p.bg,
    "--ink": p.fg,
    "--ink-2": p.fg2,
    "--muted": p.muted,
    "--line": p.line,
    "--line-strong": p.lineStrong,
    "--chrome": p.chrome,
    "--hover": p.hover,
    "--accent": p.accent,
    "--accent-soft": p.accentSoft,
    background: p.bg,
    color: p.fg,
  } as Record<string, string>;
});

type FoliateView = HTMLElement & {
  open: (book: unknown) => Promise<void>;
  init: (o: { lastLocation?: string; showTextStart?: boolean }) => Promise<void>;
  goTo: (target: unknown) => Promise<void>;
  goToFraction: (n: number) => Promise<void>;
  goLeft: () => Promise<void>;
  goRight: () => Promise<void>;
  close: () => void;
  deselect: () => void;
  getCFI: (index: number, range: Range) => string;
  addAnnotation: (a: { value: string }) => Promise<unknown>;
  deleteAnnotation: (a: { value: string }) => Promise<unknown>;
  resolveNavigation: (target: string) => { index: number } | undefined;
  getSectionFractions: () => number[];
  book: { toc?: TocItem[]; metadata?: { title?: unknown; author?: unknown } };
  renderer?: HTMLElement & { setStyles?: (css: string) => void };
};
type TocItem = { label?: string; href?: unknown; subitems?: unknown };

let view: FoliateView | null = null;
let pending: ReadPoint | null = null;
let saveTimer = 0;

function flatToc(items: TocItem[] = [], depth = 0, out: { label: string; href: string; depth: number }[] = []) {
  for (const item of items) {
    out.push({ label: (item.label ?? "").trim(), href: String(item.href ?? ""), depth });
    if (Array.isArray(item.subitems)) flatToc(item.subitems as TocItem[], depth + 1, out);
  }
  return out;
}

/** 目录每一项在全书里的位置（百分比），算不出来时不显示 */
function withPercent(items: { label: string; href: string; depth: number }[]) {
  const fractions = view?.getSectionFractions?.() ?? [];
  return items.map((item) => {
    let percent: number | null = null;
    try {
      const index = view?.resolveNavigation(item.href)?.index;
      if (typeof index === "number" && fractions[index] != null) percent = Math.round(fractions[index] * 100);
    } catch {
      percent = null;
    }
    return { ...item, depth: tocDepth(item.depth), percent };
  });
}

function textOf(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("、");
  if (typeof value === "object") return textOf(Object.values(value as Record<string, unknown>)[0]);
  return "";
}

/** 排版设置写进书页的样式表；翻到新章节时阅读器会自己再套一次 */
function applyLayout() {
  const r = view?.renderer;
  if (r && !pdfBook) {
    r.setAttribute("flow", scrolled.value ? "scrolled" : "paginated");
    r.setAttribute("gap", GAP[margin.value]);
    r.setAttribute("margin", "44px");
    r.setAttribute("max-inline-size", "720px");
    // 翻页动画由这一页自己做（见 turn），阅读器只负责瞬间跳到目标页
    r.removeAttribute("animated");
    r.setStyles?.(readerCss({ palette: palette.value, size: size.value, leading: leading.value, font: font.value, files: FONT_FILES }));
  }
  syncPageColor();
}

/** 状态栏那一条是页面底色露出来的，跟着阅读主题变；图标颜色也跟着深浅换 */
function syncPageColor() {
  document.body.style.background = palette.value.bg;
  void mobileApi.systemBars(!palette.value.dark).catch(() => {});
}

function restorePageColor() {
  document.body.style.background = "";
  void mobileApi.systemBars(!isDarkTheme(store.reader.theme)).catch(() => {});
}

/* 点按：中间呼出或收起菜单，左右两侧翻页。书页在 iframe 里，坐标要加上 iframe 自己的位置 */
let down: { x: number; y: number; t: number } | null = null;

function frameOffset(doc: Document): { left: number; top: number } {
  const frame = doc.defaultView?.frameElement as HTMLElement | null | undefined;
  const rect = frame?.getBoundingClientRect();
  return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
}

function onPointerDown(e: PointerEvent) {
  down = { x: e.screenX, y: e.screenY, t: e.timeStamp };
}

function onPointerUp(e: PointerEvent, doc: Document) {
  const start = down;
  down = null;
  if (!start || !e.isPrimary) return;
  // 拖动（滑动翻页、拖选字的把手）和长按不算点按
  if (Math.hypot(e.screenX - start.x, e.screenY - start.y) > 12 || e.timeStamp - start.t > 500) return;
  if ((e.target as HTMLElement | null)?.closest?.("a[href]")) return;
  const sel = doc.getSelection();
  if (pick.value || (sel && !sel.isCollapsed)) {
    clearPick();
    return;
  }
  if (chrome.value) {
    chrome.value = false;
    return;
  }
  if (turning) return;
  const x = (e.clientX + frameOffset(doc).left) / (window.innerWidth || 1);
  if (x > 0.3 && x < 0.7) chrome.value = true;
  else void turn(x <= 0.3 ? -1 : 1);
}

/*
 * 翻页。阅读器自带的拖动是一帧帧改滚动位置，手机上掉帧，所以由这一页自己做，阅读器只负责瞬间换页：
 * - 平移：同一章里相邻的页本来就排在同一个 iframe 里，拖动和动画只移动 iframe（transform 交给 GPU），
 *   滑到位后在同一帧里让阅读器换页、去掉位移，画面接得上；跨章时下一章还没排版，改成淡入淡出。
 * - 淡入淡出：书页先淡出，换页后淡入。
 * - 无动画：直接换页。
 * 点两侧和左右滑动都走这里。
 */
let turning = false;
let gesture: { x: number; y: number; t: number; dx: number; decided: boolean; horizontal: boolean } | null = null;
const EASE_OUT = "cubic-bezier(.2, .7, .2, 1)";

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** 阅读器换好页时会发 relocate；等到它就可以显示，不用等阅读器内部 100ms 的翻页锁 */
let relocateWaiters: (() => void)[] = [];
function nextRelocate(): Promise<boolean> {
  return new Promise((resolve) => relocateWaiters.push(() => resolve(true)));
}

/**
 * 上一次让阅读器翻页的那个调用。它在翻页锁解开后才结束；锁没解开时再翻页会被阅读器直接忽略，
 * 看起来像翻不动了，所以每次翻页前先等它。
 */
let settling: Promise<unknown> = Promise.resolve();

function goSide(dir: 1 | -1): Promise<unknown> {
  const going = Promise.resolve(dir > 0 ? view!.goRight() : view!.goLeft()).catch((e) => console.warn("翻页失败", e));
  settling = going;
  return going;
}

/** 已经在全书的第一页或最后一页 */
function atEdge(dir: 1 | -1): boolean {
  const edge = view?.renderer as unknown as { atStart?: boolean; atEnd?: boolean } | undefined;
  return !!(dir > 0 ? edge?.atEnd : edge?.atStart);
}

function pageFrame(): HTMLElement | null {
  return (activeDoc?.defaultView?.frameElement as HTMLElement | null | undefined) ?? null;
}

function pageSize(): number {
  const size = (view?.renderer as unknown as { size?: number } | undefined)?.size;
  return size || host.value?.clientWidth || window.innerWidth;
}

function moveFrame(x: number, ms = 0) {
  const el = pageFrame();
  if (!el) return;
  el.style.transition = ms ? `transform ${ms}ms ${EASE_OUT}` : "none";
  el.style.transform = x ? `translate3d(${x}px, 0, 0)` : "";
}

function fadeHost(opacity: number, ms: number) {
  const el = host.value;
  if (!el) return;
  el.style.transition = ms ? `opacity ${ms}ms ease` : "none";
  el.style.opacity = opacity === 1 ? "" : String(opacity);
}

/** 这一页往 dir 方向翻会不会出这一章（下一页不在同一个 iframe 里） */
function crossesSection(dir: 1 | -1): boolean {
  const r = view?.renderer as unknown as { page?: number; pages?: number } | undefined;
  if (!r || r.page == null || !r.pages) return true;
  return dir > 0 ? r.page >= r.pages - 2 : r.page <= 1;
}

async function jumpPage(dir: 1 | -1): Promise<boolean> {
  await settling;
  const before = `${fraction.value}\n${currentCfi.value}`;
  // 先登记再翻页。阅读器换页时同步发出 relocate，登记晚了就收不到，每一页都会被当成没翻动
  const pending = nextRelocate();
  try {
    const going = goSide(dir);
    const signaled = await Promise.race([pending, going.then(() => false)]);
    return signaled || `${fraction.value}\n${currentCfi.value}` !== before;
  } finally {
    relocateWaiters = [];
  }
}

async function fadeTurn(dir: 1 | -1) {
  fadeHost(0, 110);
  await wait(110);
  const moved = await jumpPage(dir);
  await frame();
  fadeHost(1, 160);
  await wait(160);
  return moved;
}

/** dir 1 是往右翻（下一页），-1 往左；from 是松手时书页已经被拖开的距离 */
async function turn(dir: 1 | -1, from = 0) {
  if (turning || !view) return;
  turning = true;
  clearPick();
  let moved = true;
  try {
    // 上一章还在加载时 atEnd、atStart 还是旧的，先等上一次翻页结束再判断
    await settling;
    if (atEdge(dir)) {
      moveFrame(0, 180);
      await wait(180);
      moved = false;
    } else if (scrolled.value || pdfBook || turnAnim.value === "无动画") {
      moveFrame(0);
      moved = await jumpPage(dir);
    } else if (turnAnim.value === "淡入淡出" || crossesSection(dir)) {
      moveFrame(0);
      moved = await fadeTurn(dir);
    } else {
      const size = pageSize();
      const rest = Math.max(0.3, 1 - Math.abs(from) / size);
      moveFrame(-dir * size, Math.round(240 * rest));
      await wait(Math.round(240 * rest));
      // 同一帧里换页并去掉位移：iframe 回到原位时，阅读器已经滚到了下一页
      moveFrame(0);
      void goSide(dir);
    }
    // 没翻动但不在首尾（比如章节没加载出来）时不能说成到头了
    if (!moved && atEdge(dir)) toast(dir > 0 ? "已经是最后一页" : "已经是第一页");
  } finally {
    moveFrame(0);
    fadeHost(1, 0);
    turning = false;
  }
}

function hasSelection(doc: Document) {
  const sel = doc.getSelection();
  return !!sel && !sel.isCollapsed;
}

/** 拦在阅读器前面接管左右滑动；上下滚动模式和 PDF 交给阅读器自己 */
function watchSwipe(doc: Document) {
  const opts = { capture: true, passive: false } as const;
  doc.addEventListener("touchstart", (e: TouchEvent) => {
    if (scrolled.value || pdfBook) return;
    e.stopPropagation();
    if (e.touches.length > 1 || turning) {
      gesture = null;
      return;
    }
    const t = e.touches[0];
    gesture = { x: t.screenX, y: t.screenY, t: e.timeStamp, dx: 0, decided: false, horizontal: false };
  }, opts);
  doc.addEventListener("touchmove", (e: TouchEvent) => {
    if (scrolled.value || pdfBook) return;
    e.stopPropagation();
    const g = gesture;
    if (!g) return;
    const t = e.touches[0];
    const dx = t.screenX - g.x;
    const dy = t.screenY - g.y;
    if (!g.decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      g.decided = true;
      g.horizontal = Math.abs(dx) > Math.abs(dy) && !hasSelection(doc);
      if (g.horizontal) clearPick();
    }
    if (!g.horizontal) return;
    e.preventDefault();
    g.dx = dx;
    // 只有平移跟着手指走；跨章时下一页还没排版，拖动时只稍微动一点表示有反应
    if (turnAnim.value === "平移") moveFrame(crossesSection(dx < 0 ? 1 : -1) ? dx * 0.25 : dx);
  }, opts);
  const end = (e: TouchEvent) => {
    if (scrolled.value || pdfBook) return;
    e.stopPropagation();
    const g = gesture;
    gesture = null;
    if (!g?.horizontal) return;
    const speed = Math.abs(g.dx) / Math.max(1, e.timeStamp - g.t);
    if (Math.abs(g.dx) > pageSize() * 0.18 || (speed > 0.35 && Math.abs(g.dx) > 24)) {
      const dir = g.dx < 0 ? 1 : -1;
      void turn(dir, crossesSection(dir) ? 0 : g.dx);
    } else if (turnAnim.value === "平移") {
      moveFrame(0, 180);
    }
  };
  doc.addEventListener("touchend", end, opts);
  doc.addEventListener("touchcancel", end, opts);
}
function clearPick() {
  pick.value = null;
  try {
    activeDoc?.getSelection()?.removeAllRanges();
    view?.deselect?.();
  } catch {
    /* 书页已经换掉时没什么可清的 */
  }
}

/** 选字：用 selectionchange 跟着把手更新，菜单放在选区上方，太靠上时放到下方 */
let selTimer = 0;
function watchSelection(doc: Document, index: number) {
  doc.addEventListener("selectionchange", () => {
    clearTimeout(selTimer);
    selTimer = window.setTimeout(() => captureSelection(doc, index), 220);
  });
}

function captureSelection(doc: Document, index: number) {
  const sel = doc.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !view) {
    if (pick.value && !annos.value.some((a) => a.cfi === pick.value?.cfi)) pick.value = null;
    return;
  }
  const range = sel.getRangeAt(0);
  const text = range.toString().replace(/\s+/g, " ").trim();
  if (!text) return;
  activeDoc = doc;
  chrome.value = false;
  const rect = range.getBoundingClientRect();
  const off = frameOffset(doc);
  placePick(view.getCFI(index, range), text, rect, off);
}

function placePick(cfi: string, text: string, rect: DOMRect, off: { left: number; top: number }) {
  const top = rect.top + off.top;
  const bottom = rect.bottom + off.top;
  const below = top < 72;
  const centre = rect.left + off.left + rect.width / 2;
  const half = Math.min(150, window.innerWidth / 2 - 8);
  pick.value = {
    cfi,
    text,
    below,
    top: below ? bottom + 12 : top - 52,
    left: Math.min(Math.max(centre, half + 8), window.innerWidth - half - 8),
  };
}

function scheduleSave(point: ReadPoint) {
  pending = point;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void mobileApi.shelfSavePoint(props.id, point).catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }, 2000);
}

async function flush() {
  clearTimeout(saveTimer);
  if (pending) await mobileApi.shelfSavePoint(props.id, pending).catch(() => {});
  if (shelf.vaultId) await mobileApi.shelfPushPoint(shelf.vaultId, shelf.remoteDir, props.id).catch((e) => toast(e instanceof Error ? e.message : String(e)));
}

function onHide() {
  if (document.visibilityState === "hidden") void flush();
}

/** 返回键先收起选字菜单、面板、菜单，再离开阅读页 */
const removeBack = addBackInterceptor(() => {
  if (pick.value) clearPick();
  else if (editing.value || editingSummary.value) closeEditor();
  else if (sheet.value) sheet.value = "";
  else if (chrome.value) chrome.value = false;
  else return false;
  return true;
});

onMounted(async () => {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS) ?? "{}") as Partial<{ size: number; leading: typeof leading.value; margin: typeof margin.value; theme: ReaderTheme; flow: typeof flow.value; font: unknown; turnAnim: unknown }>;
    if (saved.size) size.value = saved.size;
    if (saved.leading) leading.value = saved.leading;
    if (saved.margin) margin.value = saved.margin;
    if (saved.theme && saved.theme in READER_THEMES) theme.value = saved.theme;
    if (saved.flow) flow.value = saved.flow;
    if (isReaderFont(saved.font)) font.value = saved.font;
    if (TURN_ANIMS.includes(saved.turnAnim as (typeof TURN_ANIMS)[number])) turnAnim.value = saved.turnAnim as (typeof TURN_ANIMS)[number];
  } catch { /* 设置坏了就用默认值 */ }
  document.addEventListener("visibilitychange", onHide);
  void mobileApi.selectionMenu(true).catch(() => {});
  syncPageColor();
  const el = host.value;
  if (!el) return;
  try {
    const opened = await mobileApi.shelfBookFile(props.id);
    title.value = bookStem(opened.name);
    pdfBook = opened.name.toLowerCase().endsWith(".pdf");
    const url = convertFileSrc(opened.path);
    // foliate-js 是没有类型声明的浏览器模块
    // @ts-expect-error 见上一行
    const mod = await import("../../../vendor/foliate-js/view.js");
    const node = document.createElement("foliate-view") as unknown as FoliateView;
    node.style.cssText = "display:block;height:100%;width:100%";
    el.append(node);
    view = node;
    // 先登记 load，第一页加载出来时就能接上点按和选字
    view.addEventListener("load", ((e: Event) => {
      const detail = (e as CustomEvent<{ doc: Document; index: number }>).detail;
      const doc = detail.doc;
      activeDoc = doc;
      doc.addEventListener("pointerdown", onPointerDown);
      doc.addEventListener("pointerup", (ev) => onPointerUp(ev, doc));
      watchSelection(doc, detail.index);
      watchSwipe(doc);
      void paint();
    }) as EventListener);
    if (opened.name.toLowerCase().endsWith(".txt")) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`读取书籍失败：HTTP ${res.status}`);
      await view.open(txtBook(decodeTxt(new Uint8Array(await res.arrayBuffer())), opened.name));
    } else {
      const book = await mod.makeBook(url);
      book.transformTarget?.addEventListener("data", (ev: Event & { detail?: { data?: unknown } }) => {
        if (typeof ev.detail?.data === "string") ev.detail.data = ev.detail.data.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
      });
      await view.open(book);
    }
    info.value = [textOf(view.book.metadata?.title) || title.value, textOf(view.book.metadata?.author)].filter(Boolean).join("\n");
    view.addEventListener("draw-annotation", ((e: Event) => {
      const draw = (e as CustomEvent<{ draw: (fn: unknown, opts: unknown) => void }>).detail.draw;
      draw(underline, { color: palette.value.accent, width: 2 });
    }) as EventListener);
    view.addEventListener("show-annotation", ((e: Event) => {
      const d = (e as CustomEvent<{ value?: string; range?: Range; index?: number }>).detail;
      const cfi = d.value ?? "";
      const anno = annos.value.find((a) => a.cfi === cfi);
      if (!anno) return;
      const rect = d.range?.getBoundingClientRect();
      const doc = d.range?.startContainer.ownerDocument ?? activeDoc;
      const fromRange = d.range?.toString?.().replace(/\s+/g, " ").trim() ?? "";
      const text = fromRange || anno.note;
      if (rect && doc) placePick(cfi, text, rect, frameOffset(doc));
      else pick.value = { cfi, text, top: 80, left: window.innerWidth / 2, below: true };
    }) as EventListener);
    view.addEventListener("relocate", ((e: Event) => {
      const d = (e as CustomEvent<{ fraction?: number; cfi?: string; tocItem?: { label?: string; href?: string }; range?: Range }>).detail;
      fraction.value = d.fraction ?? fraction.value;
      chapter.value = d.tocItem?.label?.trim() ?? chapter.value;
      chapterHref.value = d.tocItem?.href ?? chapterHref.value;
      currentCfi.value = d.cfi ?? currentCfi.value;
      let snippet = d.range?.toString?.().replace(/\s+/g, " ").trim() ?? "";
      // 一章的第一页开头是章节名，书签摘要和页面笔记的引用里不要它
      if (chapter.value && snippet.startsWith(chapter.value)) snippet = snippet.slice(chapter.value.length).trim();
      if (snippet) excerpt.value = snippet.slice(0, 42);
      if (pick.value && !annos.value.some((a) => a.cfi === pick.value?.cfi)) pick.value = null;
      const waiting = relocateWaiters;
      relocateWaiters = [];
      for (const done of waiting) done();
      scheduleSave({ cfi: d.cfi ?? "", fraction: fraction.value, updatedMs: Date.now() });
    }) as EventListener);
    applyLayout();
    toc.value = withPercent(flatToc(view.book.toc));
    // 先用手机上记下的位置打开，不等网络；云端的进度在后台对比，更新时再跳过去
    const local = await mobileApi.shelfReadPoint(props.id).catch(() => null);
    if (local?.cfi) await view.init({ lastLocation: local.cfi });
    else await view.init({ showTextStart: true });
    await revealWhenStyled();
    void mobileApi
      .shelfSyncPoint(shelf.vaultId ?? "", shelf.remoteDir, props.id)
      .then(async (synced) => {
        if (!synced.fromCloud || !synced.point?.cfi || synced.point.cfi === local?.cfi || !view) return;
        await view.goTo(synced.point.cfi);
        toast(`已回到上次读到的位置${chapter.value ? ` · ${chapter.value}` : ""}`);
      })
      .catch(() => {});
    fileName = opened.name;
    authorName = textOf(view.book.metadata?.author);
    await loadNotes().catch((e) => toast(e instanceof Error ? e.message : String(e)));
    await loadMarks().catch((e) => toast(e instanceof Error ? e.message : String(e)));
    await paint();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    ready.value = true;
  }
});

/**
 * 书页排好、字体加载完才显示，避免先用书自带的字体排一遍、再换成阅读设置的字体时跳一下。
 * 最多等 1.5 秒，字体出问题也不会一直空白
 */
async function revealWhenStyled() {
  const doc = activeDoc;
  if (doc?.fonts) await Promise.race([doc.fonts.ready, wait(1500)]);
  await frame();
  ready.value = true;
}

onBeforeUnmount(() => {
  removeBack();
  document.removeEventListener("visibilitychange", onHide);
  void mobileApi.selectionMenu(false).catch(() => {});
  restorePageColor();
  void flush();
  view?.close();
});

watch([size, leading, margin, theme, font, flow, turnAnim], () => {
  localStorage.setItem(PREFS, JSON.stringify({ size: size.value, leading: leading.value, margin: margin.value, theme: theme.value, flow: flow.value, font: font.value, turnAnim: turnAnim.value }));
  applyLayout();
});

/** 左上角返回：直接离开阅读页（返回键会先收起菜单，这里不用）。进度在离开时保存 */
function leave() {
  pick.value = null;
  closeEditor();
  sheet.value = "";
  chrome.value = false;
  back();
}

function jump(event: Event) {
  const next = Number((event.target as HTMLInputElement).value) / 100;
  const prev = fraction.value;
  dragging.value = null;
  void view?.goToFraction(next);
  backTo.value = prev;
  window.setTimeout(() => {
    if (backTo.value === prev) backTo.value = null;
  }, 4000);
}

function restore() {
  if (backTo.value == null) return;
  void view?.goToFraction(backTo.value);
  backTo.value = null;
}

function goTo(target: string) {
  sheet.value = "";
  chrome.value = false;
  void view?.goTo(target);
}

const currentTocIndex = computed(() => {
  const byHref = toc.value.findIndex((t) => t.href === chapterHref.value);
  return byHref >= 0 ? byHref : toc.value.findIndex((t) => t.label === chapter.value);
});

function stepChapter(dir: number) {
  const items = toc.value;
  if (!items.length) return;
  const i = Math.min(Math.max(currentTocIndex.value + dir, 0), items.length - 1);
  void view?.goTo(items[i].href);
}

const tocList = ref<HTMLElement | null>(null);
async function openPanel(which: "toc" | "notes" | "marks") {
  tab.value = which;
  sheet.value = "panel";
  if (which !== "toc") return;
  await nextTick();
  tocList.value?.querySelector(".toc-row.on")?.scrollIntoView({ block: "center" });
}

/** 写过字的感悟。只划了线、没有写内容的不出现在列表里 */
const thoughts = computed(() => annos.value.filter((a) => a.note.trim()));
const noteCount = computed(() => thoughts.value.length + (summary.value.trim() ? 1 : 0));

function findFolder(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.isDir) {
      const hit = findFolder(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

function underline(rects: DOMRect[], options: { color?: string; width?: number } = {}) {
  const svg = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(svg, "g");
  g.setAttribute("fill", options.color ?? "#c4a35a");
  for (const { left, bottom, width } of rects) {
    const el = document.createElementNS(svg, "rect");
    el.setAttribute("x", String(left));
    el.setAttribute("y", String(bottom - (options.width ?? 2)));
    el.setAttribute("height", String(options.width ?? 2));
    el.setAttribute("width", String(width));
    g.append(el);
  }
  return g;
}

/** 页面笔记（底部“笔记”按钮写的）只记位置，不在书里画线 */
const isPageNote = (anno: Anno) => anno.id.startsWith("n");

async function paint() {
  const lost = new Set<string>();
  for (const anno of annos.value) {
    if (isPageNote(anno)) continue;
    try {
      await view?.addAnnotation({ value: anno.cfi });
    } catch {
      lost.add(anno.id);
    }
  }
  missing.value = lost;
}

async function noteRelOf(): Promise<string> {
  const id = shelf.vaultId;
  if (!id) throw new Error("先选择读书笔记库");
  const root = await mobileApi.vaultRoot(id);
  const scan = await api.scanVault(root);
  const folder = findFolder(scan.nodes, "读书笔记");
  const existing: { folder: string; book: string }[] = [];
  for (const child of folder?.children ?? []) {
    if (!child.isDir) continue;
    const md = child.children.find((n) => !n.isDir && (n.name === `${child.name}.md` || n.path.endsWith(`/${child.name}.md`)));
    if (!md) continue;
    try {
      const file = await api.readNote(root, md.path);
      existing.push({ folder: child.name, book: parseReadingNote(file.content).book });
    } catch {
      /* 读不到这篇就不参与重名判断 */
    }
  }
  return readingNoteRel(title.value || bookStem(fileName), fileName, existing);
}

function rememberNote(md: string) {
  const doc = parseReadingNote(md);
  annos.value = doc.annos;
  summary.value = doc.summary;
}

async function loadNotes() {
  if (!shelf.vaultId || !fileName) return;
  noteRel = await noteRelOf();
  const md = await mobileApi.vaultTextRead(shelf.vaultId, noteRel);
  const doc = parseReadingNote(md);
  if (!doc.book) doc.book = fileName;
  if (!doc.title) doc.title = title.value;
  if (!doc.author) doc.author = authorName;
  annos.value = doc.annos;
  summary.value = doc.summary;
  if (!md.trim()) return;
  // 旧笔记里的书名、章节和摘录打开时清掉，只留下自己写的内容
  const cleaned = renderReadingNote(doc);
  if (cleaned.replace(/\r\n/g, "\n").trim() === md.replace(/\r\n/g, "\n").trim()) return;
  await mobileApi.vaultTextWrite(shelf.vaultId, noteRel, cleaned);
  if (store.currentId === shelf.vaultId) await store.loadTree();
}

async function commit(change: (doc: ReturnType<typeof parseReadingNote>) => void) {
  if (!shelf.vaultId) throw new Error("先选择读书笔记库");
  if (!noteRel) noteRel = await noteRelOf();
  const md = await mobileApi.vaultTextRead(shelf.vaultId, noteRel);
  const next = withAnno(md, { book: fileName, title: title.value, author: authorName }, change);
  await mobileApi.vaultTextWrite(shelf.vaultId, noteRel, next);
  rememberNote(next);
  if (store.currentId === shelf.vaultId) await store.loadTree();
}

const pickedAnno = computed(() => (pick.value ? annos.value.find((a) => a.cfi === pick.value?.cfi) ?? null : null));

async function highlight(write: boolean) {
  const chosen = pick.value;
  if (!chosen) return;
  const old = pickedAnno.value;
  if (old) {
    clearPick();
    if (write) startEdit(old, false);
    return;
  }
  const anno: Anno = {
    id: `a${Date.now().toString(36)}`,
    cfi: chosen.cfi,
    time: new Date().toISOString(),
    quote: chosen.text,
    note: "",
    chapter: chapter.value || "正文",
  };
  clearPick();
  try {
    await commit((doc) => doc.annos.push(anno));
    await view?.addAnnotation({ value: anno.cfi });
    if (write) startEdit(anno, false);
    else toast("已划线");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

function closeEditor() {
  editing.value = null;
  editingSummary.value = false;
}

function startEdit(anno: Anno, isNew: boolean) {
  editingSummary.value = false;
  editing.value = { anno, isNew };
  draft.value = anno.note;
}

function editSummary() {
  if (!shelf.vaultId) {
    toast("先选择读书笔记库");
    return;
  }
  sheet.value = "";
  chrome.value = false;
  editing.value = null;
  editingSummary.value = true;
  draft.value = summary.value;
}

/** 底部“笔记”：写一条感悟，不摘录这一页的原文，也不在书里画线 */
function writePageNote() {
  if (!shelf.vaultId) {
    toast("先选择读书笔记库");
    return;
  }
  if (!currentCfi.value) {
    toast("书还没有打开好，稍等一下");
    return;
  }
  chrome.value = false;
  startEdit(
    {
      id: `n${Date.now().toString(36)}`,
      cfi: currentCfi.value,
      time: new Date().toISOString(),
      quote: "",
      note: "",
      chapter: chapter.value || "正文",
    },
    true,
  );
}

async function saveDraft() {
  if (editingSummary.value) {
    const text = draft.value.trim();
    try {
      await commit((doc) => {
        doc.summary = text;
      });
      closeEditor();
      toast(text ? "已保存到读书笔记" : "已清空总结");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  const current = editing.value;
  if (!current) return;
  const text = draft.value.trim();
  if (current.isNew && !text) {
    toast("还没有写内容");
    return;
  }
  try {
    await commit((doc) => {
      if (current.isNew) {
        doc.annos.push({ ...current.anno, note: text, quote: "" });
        return;
      }
      const hit = doc.annos.find((a) => a.id === current.anno.id);
      if (hit) {
        hit.note = text;
        hit.quote = "";
      }
    });
    closeEditor();
    toast("已保存到读书笔记");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

async function removeAnno(anno: Anno) {
  clearPick();
  if (!(await ask({ title: "删除这条划线？", message: "写过的想法会一起删除。", ok: "删除", danger: true }))) return;
  try {
    await commit((doc) => {
      doc.annos = doc.annos.filter((a) => a.id !== anno.id);
    });
    if (!isPageNote(anno)) await view?.deleteAnnotation({ value: anno.cfi });
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

async function loadMarks() {
  if (!shelf.vaultId || !fileName) return;
  const raw = await mobileApi.shelfTextRead(shelf.vaultId, shelf.remoteDir, ".spark/bookmarks.json");
  if (!raw.trim()) {
    marks.value = [];
    return;
  }
  const all = JSON.parse(raw) as Record<string, Bookmark[]>;
  marks.value = Array.isArray(all[fileName]) ? all[fileName] : [];
}

async function saveMarks(next: Bookmark[], prev: Bookmark[]) {
  if (!shelf.vaultId) return;
  try {
    const raw = await mobileApi.shelfTextRead(shelf.vaultId, shelf.remoteDir, ".spark/bookmarks.json");
    const all = raw.trim() ? (JSON.parse(raw) as Record<string, Bookmark[]>) : {};
    all[fileName] = next;
    await mobileApi.shelfTextWrite(shelf.vaultId, shelf.remoteDir, ".spark/bookmarks.json", JSON.stringify(all));
  } catch (e) {
    marks.value = prev;
    toast(e instanceof Error ? e.message : String(e));
  }
}

const marked = computed(() => marks.value.some((b) => b.cfi === currentCfi.value));

async function onBookmark() {
  if (!shelf.vaultId) {
    toast("先选择读书笔记库");
    return;
  }
  if (!currentCfi.value) {
    toast("书还没有打开好，稍等一下");
    return;
  }
  const prev = marks.value;
  const adding = !marked.value;
  const next = toggleBookmark(prev, {
    cfi: currentCfi.value,
    label: chapter.value || "正文",
    excerpt: excerpt.value,
    fraction: fraction.value,
    createdMs: Date.now(),
  });
  marks.value = next;
  toast(adding ? "已添加书签" : "已移除书签");
  await saveMarks(next, prev);
}

async function removeMark(mark: Bookmark) {
  swiped.value = null;
  const prev = marks.value;
  const next = prev.filter((b) => b.id !== mark.id);
  marks.value = next;
  await saveMarks(next, prev);
}

/* 书签左滑：这一行跟着手指走，松手时超过一半就停在露出“删除”的位置 */
const MARK_DEL = 84;
const markDrag = ref<{ id: string; x: number; y: number; dx: number; horizontal: boolean | null } | null>(null);
function markStart(e: TouchEvent, id: string) {
  if (swiped.value && swiped.value !== id) swiped.value = null;
  const t = e.touches[0];
  markDrag.value = { id, x: t.clientX, y: t.clientY, dx: swiped.value === id ? -MARK_DEL : 0, horizontal: null };
}
function markMove(e: TouchEvent) {
  const d = markDrag.value;
  if (!d) return;
  const t = e.touches[0];
  const dx = t.clientX - d.x;
  const dy = t.clientY - d.y;
  if (d.horizontal == null) {
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
    d.horizontal = Math.abs(dx) > Math.abs(dy);
  }
  if (!d.horizontal) return;
  e.preventDefault();
  const base = swiped.value === d.id ? -MARK_DEL : 0;
  d.dx = Math.min(0, Math.max(-MARK_DEL - 24, base + dx));
}
function markEnd() {
  const d = markDrag.value;
  markDrag.value = null;
  if (!d?.horizontal) return;
  swiped.value = d.dx < -MARK_DEL / 2 ? d.id : null;
}
function markShift(id: string): string {
  const d = markDrag.value;
  if (d?.id === id && d.horizontal) return `translateX(${d.dx}px)`;
  return swiped.value === id ? `translateX(-${MARK_DEL}px)` : "";
}

function askAi(text: string) {
  clearPick();
  open({ t: "ai", quote: text });
}

async function copyPick() {
  const text = pick.value?.text ?? "";
  clearPick();
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
  } catch (e) {
    toast(`复制失败：${e instanceof Error ? e.message : e}`);
  }
}

async function openNoteFile() {
  if (!shelf.vaultId || !noteRel) {
    toast("还没有读书笔记");
    return;
  }
  if (store.currentId !== shelf.vaultId) await store.selectVault(shelf.vaultId);
  openDoc(noteRel);
}

function toggleNight() {
  theme.value = palette.value.dark ? "浅色" : "夜读";
}

function dateLabel(iso: string) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? timeLabel(ms) : "";
}
</script>

<template>
  <div class="page bare ebook" :class="{ scrolled, chromed: chrome }" :style="themeVars">
    <div ref="host" class="ebook-view" :class="{ hidden: !ready }"></div>
    <div v-if="!ready && !error" class="ebook-loading">正在打开…</div>
    <div v-if="error" class="m-empty">打不开这本书：{{ error }}</div>
    <div v-if="marked && !chrome" class="ebook-ribbon" aria-hidden="true"></div>

    <Transition name="ebook-top">
      <div v-if="chrome" class="ebook-top">
        <button class="ib" title="返回书架" @click="leave"><Icon name="back" /></button>
        <b class="grow">{{ title }}</b>
        <button class="ib" :class="{ on: marked }" :title="marked ? '去掉书签' : '加书签'" @click="onBookmark">
          <Icon name="bookmark" :style="{ fill: marked ? 'currentColor' : 'none' }" />
        </button>
        <button class="ib" title="问 AI" @click="open({ t: 'ai' })"><Icon name="spark" /></button>
        <button class="ib" title="书籍信息" @click="sheet = 'info'"><Icon name="more" /></button>
      </div>
    </Transition>

    <Transition name="ebook-bottom">
      <div v-if="chrome" class="ebook-bottom">
        <div class="ebook-slider">
          <button @click="stepChapter(-1)">上一章</button>
          <span class="track">
            <input
              type="range"
              min="0"
              max="100"
              :value="dragging ?? Math.round(fraction * 100)"
              @input="dragging = Number(($event.target as HTMLInputElement).value)"
              @change="jump"
            />
            <span v-if="dragging != null" class="ebook-bub" :style="{ left: dragging + '%' }">{{ chapter || "进度" }} · {{ dragging }}%</span>
          </span>
          <button @click="stepChapter(1)">下一章</button>
        </div>
        <button v-if="backTo != null" class="ebook-back" @click="restore">↩ 回到 {{ Math.round(backTo * 100) }}%</button>
        <div class="ebook-tools">
          <button @click="openPanel('toc')"><Icon name="outline" />目录</button>
          <button @click="writePageNote"><Icon name="pen" />笔记</button>
          <button @click="sheet = 'settings'"><Icon name="aa" />设置</button>
          <button @click="toggleNight"><Icon :name="palette.dark ? 'sun' : 'moon'" />{{ palette.dark ? "日间" : "夜读" }}</button>
        </div>
      </div>
    </Transition>

    <div v-if="!chrome" class="ebook-foot"><span>{{ chapter }}</span><span>{{ Math.round(fraction * 100) }}%</span></div>

    <div v-if="pick" class="sel-menu" :class="{ below: pick.below }" :style="{ top: pick.top + 'px', left: pick.left + 'px' }">
      <template v-if="pickedAnno">
        <button @click="highlight(true)">{{ pickedAnno.note ? "编辑想法" : "写想法" }}</button>
        <button @click="copyPick">复制</button>
        <button @click="askAi(pick.text)">问 AI</button>
        <button class="dgr" @click="removeAnno(pickedAnno)">删除划线</button>
      </template>
      <template v-else>
        <button @click="highlight(false)">划线</button>
        <button @click="highlight(true)">写想法</button>
        <button @click="copyPick">复制</button>
        <button @click="askAi(pick.text)">问 AI</button>
      </template>
    </div>

    <div v-if="editing || editingSummary" class="m-ovl">
      <div class="mask" @click="closeEditor"></div>
      <div class="sheet note-sheet">
        <div class="grab"></div>
        <textarea v-model="draft" class="note-input" rows="5" :placeholder="editingSummary ? '写下读完后的总结' : '写下感悟'" autofocus></textarea>
        <p class="note-hint">保存到 {{ noteRel ? noteRel.replace(/\/[^/]+$/, "") : "读书笔记" }}</p>
        <div class="note-btns">
          <button class="btn" @click="closeEditor">取消</button>
          <button class="btn pri" @click="saveDraft">保存</button>
        </div>
      </div>
    </div>

    <div v-if="sheet" class="m-ovl">
      <div class="mask" @click="sheet = ''"></div>
      <div class="sheet" :class="{ 'panel-sheet': sheet === 'panel' }">
        <div class="grab"></div>
        <template v-if="sheet === 'panel'">
          <div class="seg panel-tabs">
            <button :class="{ on: tab === 'toc' }" @click="openPanel('toc')">目录</button>
            <button :class="{ on: tab === 'notes' }" @click="tab = 'notes'">笔记 {{ noteCount }}</button>
            <button :class="{ on: tab === 'marks' }" @click="tab = 'marks'">书签 {{ marks.length }}</button>
          </div>
          <div class="panel-body">
            <div v-if="tab === 'toc'" ref="tocList">
              <button
                v-for="(item, i) in toc"
                :key="item.href + i"
                class="toc-row"
                :class="{ on: i === currentTocIndex }"
                :style="{ paddingLeft: 16 + item.depth * 16 + 'px' }"
                @click="goTo(item.href)"
              >
                <span class="t"><i v-if="i === currentTocIndex">●</i>{{ item.label }}</span>
                <span v-if="item.percent != null" class="pct">{{ item.percent }}%</span>
              </button>
              <p v-if="!toc.length" class="ghint">这本书没有目录</p>
            </div>
            <div v-else-if="tab === 'notes'">
              <div class="sec">总结</div>
              <button class="note-row" @click="editSummary">
                <span :class="summary.trim() ? 'n' : 'hint'">{{ summary.trim() || "读完后写一段总结" }}</span>
              </button>
              <div class="sec">感悟</div>
              <button
                v-for="anno in thoughts"
                :key="anno.id"
                class="note-row"
                :class="{ lost: missing.has(anno.id) }"
                @click="missing.has(anno.id) ? null : goTo(anno.cfi)"
              >
                <span class="n">{{ anno.note }}</span>
                <span class="hint">{{ missing.has(anno.id) ? "在书中找不到这段文字" : dateLabel(anno.time) }}</span>
              </button>
              <p v-if="!thoughts.length" class="ghint">还没有感悟。点底部「笔记」记下来。</p>
              <button v-if="noteCount" class="panel-link" @click="openNoteFile">在文件页打开读书笔记 ›</button>
            </div>
            <div v-else>
              <div v-for="mark in marks" :key="mark.id" class="mark-row" :class="{ open: swiped === mark.id, dragging: markDrag?.id === mark.id && markDrag.horizontal }">
                <button class="mark-del" @click="removeMark(mark)"><Icon name="x" :size="18" />删除</button>
                <button
                  class="mark-main"
                  :style="{ transform: markShift(mark.id) }"
                  @touchstart.passive="markStart($event, mark.id)"
                  @touchmove="markMove"
                  @touchend="markEnd"
                  @touchcancel="markEnd"
                  @click="swiped === mark.id ? (swiped = null) : goTo(mark.cfi)"
                >
                  <span class="t">{{ mark.label }} · {{ Math.round(mark.fraction * 100) }}%</span>
                  <span class="hint">{{ mark.excerpt ? `“${mark.excerpt}…” · ` : "" }}{{ timeLabel(mark.createdMs) }}</span>
                </button>
              </div>
              <p v-if="!marks.length" class="ghint">还没有书签。点顶部的书签图标给当前页加书签。</p>
            </div>
          </div>
        </template>
        <template v-else-if="sheet === 'settings'">
          <h2>阅读设置</h2>
          <div class="seglabel">字号</div>
          <div class="seg"><button @click="size = Math.max(12, size - 1)">A−</button><button class="on">{{ size }}</button><button @click="size = Math.min(32, size + 1)">A＋</button></div>
          <div class="seglabel">行距</div>
          <div class="seg"><button v-for="n in (['紧凑', '标准', '宽松'] as const)" :key="n" :class="{ on: leading === n }" @click="leading = n">{{ n }}</button></div>
          <div class="seglabel">页边距</div>
          <div class="seg"><button v-for="n in (['窄', '标准', '宽'] as const)" :key="n" :class="{ on: margin === n }" @click="margin = n">{{ n }}</button></div>
          <div class="seglabel">主题</div>
          <div class="seg theme-seg">
            <button v-for="(p, n) in READER_THEMES" :key="n" :class="{ on: theme === n }" :style="{ background: p.bg, color: p.fg }" @click="theme = n">{{ n }}</button>
          </div>
          <div class="seglabel">翻页方式</div>
          <div class="seg"><button v-for="n in (['左右翻页', '上下滚动'] as const)" :key="n" :class="{ on: flow === n }" @click="flow = n">{{ n }}</button></div>
          <template v-if="flow === '左右翻页' && !pdfBook">
            <div class="seglabel">翻页动画</div>
            <div class="seg"><button v-for="n in TURN_ANIMS" :key="n" :class="{ on: turnAnim === n }" @click="turnAnim = n">{{ n }}</button></div>
            <p class="ghint seg-hint">点屏幕两侧或左右滑动都能翻页</p>
          </template>
          <div class="seglabel">字体</div>
          <div class="seg"><button v-for="n in (['书籍自带', '宋体', '楷体'] as const)" :key="n" :class="{ on: font === n }" @click="font = n">{{ n }}</button></div>
          <p v-if="pdfBook" class="ghint">PDF 按原样显示，字号、行距、页边距、字体和翻页方式对它不起作用。</p>
        </template>
        <template v-else-if="sheet === 'info'">
          <h2>书籍信息</h2>
          <p class="ebook-info">{{ info }}</p>
        </template>
      </div>
    </div>
    <div v-if="currentOverlay?.t === 'ai'" class="m-ovl"><AiSheet :quote="currentOverlay.quote" /></div>
  </div>
</template>
