<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import Icon from "../Icon.vue";
import { mobileApi, type PageTurnAnim, type ReadPoint } from "../api";
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
const TURN_ANIMS = ["平移", "覆盖", "淡入淡出", "无动画"] as const;
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
  renderer?: HTMLElement & {
    setStyles?: (css: string) => void;
    /** 先在后台排好前一章或后一章（见 paginator.js） */
    preload?: (dir: number) => Promise<boolean>;
    /** 不翻页，只把前一页或后一页显示出来给原生截图；unpeek 换回当前页 */
    peek?: (dir: number) => boolean;
    unpeek?: () => void;
  };
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
  schedulePrefetch(600);
}

/** 状态栏那一条是页面底色露出来的，跟着阅读主题变；图标颜色也跟着深浅换 */
function syncPageColor() {
  document.body.style.background = palette.value.bg;
  void mobileApi.systemBars(!palette.value.dark).catch(() => {});
}

/**
 * 阅读页不许双指缩放：缩放后分页的宽度、翻页和点按的位置都对不上。
 * 只在阅读页里改页面的 viewport，离开时还原，别的页面不受影响。
 */
const NO_ZOOM = "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";
let viewportBefore: string | null = null;

function lockZoom() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta || viewportBefore != null) return;
  viewportBefore = meta.getAttribute("content") ?? "";
  meta.setAttribute("content", NO_ZOOM);
}

function unlockZoom() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta && viewportBefore != null) meta.setAttribute("content", viewportBefore);
  viewportBefore = null;
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
  unpeek();
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
  const x = (e.clientX + frameOffset(doc).left) / (window.innerWidth || 1);
  if (x > 0.3 && x < 0.7) chrome.value = true;
  else void turn(x <= 0.3 ? -1 : 1);
}

/*
 * 左右翻页。动画由安卓原生做（见 PageTurn.kt）：书页停稳后先在后台排好前后两章，原生把前一页、后一页
 * 预先截好（见 schedulePrefetch）。翻页时拿截图做动画，阅读器在截图下面换页，换好后才拿掉截图，
 * 换页和换章的过程都不会露出来。没预截好时先盖上当前画面，等阅读器换好页、截到新页再动。
 * - 平移：旧页滑出、新页从另一侧滑入，两页一起动。
 * - 覆盖：下一页时只有旧页滑走，新页不动；往回翻时只有上一页从旁边盖上来。
 * 点两侧和手指滑动用同一种位移、同一种速度。
 * - 淡入淡出：旧页截图淡出，下面的新页显出来。
 * - 无动画：新页画好后直接拿掉截图。
 * 左右滑动由原生接管、跟着手指走，要换页时通过 window.__sparkTurn 通知这里。
 * 上下滚动、PDF，以及原生用不了的时候（不在安卓上）直接换页。
 */
const ANIM_CODE: Record<(typeof TURN_ANIMS)[number], PageTurnAnim> = { 平移: "slide", 覆盖: "cover", 淡入淡出: "fade", 无动画: "none" };

/** 安卓原生翻页可用（打开阅读页时第一次设置成功才算） */
let nativeTurn = false;
/** 翻页一个接一个做。滑动每一次都排进来；点两侧正在翻时再点不算 */
let turnQueue: Promise<void> = Promise.resolve();
let queuedTurns = 0;
/**
 * 原生翻页动画还在画面上。网页这边的换页任务往往在动画播完之前就结束了，
 * 不能用任务是否还在排队来判断能不能再点
 */
let nativeAnimating = false;
let gesture: { x: number; y: number } | null = null;
const atStart = ref(false);
const atEnd = ref(false);
const selecting = ref(false);
/**
 * 页脚不在翻页截图里，书页一换就跟着变（换章时章节名马上换，不会翻完了再跳一下）。
 * 书签角在截图里，翻页过程中先不动，翻完再变
 */
const shownChapter = ref("");
const shownPercent = ref(0);
const shownRibbon = ref(false);
let footFrozen = false;

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

/** 原生预截前后两页时书页可能还停在旁边那一页，读位置、翻页之前先换回来 */
function unpeek() {
  view?.renderer?.unpeek?.();
}

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

/** 跨章时阅读器先滚到这一章前后的空白页，再换成下一章；停在空白页上的那次 relocate 不算翻好 */
function onBlankPage(): boolean {
  const r = view?.renderer as unknown as { page?: number; pages?: number } | undefined;
  if (scrolled.value || !r || r.page == null || !r.pages) return false;
  return r.page < 1 || r.page > r.pages - 2;
}

/** 这一页再往 dir 翻会不会出这一章 */
function crossesSection(dir: 1 | -1): boolean {
  const r = view?.renderer as unknown as { page?: number; pages?: number } | undefined;
  if (!r || r.page == null || !r.pages) return true;
  return dir > 0 ? r.page >= r.pages - 2 : r.page <= 1;
}

function showFoot() {
  shownChapter.value = chapter.value;
  shownPercent.value = Math.round(fraction.value * 100);
}

function snapshotFoot() {
  showFoot();
  shownRibbon.value = marks.value.some((b) => b.cfi === currentCfi.value);
}

function freezeFoot() {
  if (!footFrozen) snapshotFoot();
  footFrozen = true;
}

function thawFoot() {
  footFrozen = false;
  snapshotFoot();
}

/**
 * 等新页的字体和排版稳定再让原生截新页，原生截到新页才开始动画。
 * 同一章里字体早已加载好，画没画上屏由原生确认，这里不再多等，免得点了要过一会儿才动
 */
async function settleTurn(crossed: boolean) {
  const fonts = activeDoc?.fonts;
  if (!crossed) {
    if (fonts?.status === "loading") await Promise.race([fonts.ready, wait(60)]);
    return;
  }
  if (fonts) await Promise.race([fonts.ready, wait(700)]);
  await frame();
  await frame();
}

/** 点两侧的翻页和原生滑动的换页走两条队列，换页本身还是一个接一个 */
let jumping: Promise<unknown> = Promise.resolve();

async function jumpPage(dir: 1 | -1): Promise<boolean> {
  const before = jumping;
  let release = () => {};
  jumping = new Promise<void>((r) => (release = r));
  await before;
  try {
    return await jumpOnce(dir);
  } finally {
    release();
  }
}

async function jumpOnce(dir: 1 | -1): Promise<boolean> {
  await settling;
  unpeek();
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

function enqueue(task: () => Promise<void>) {
  queuedTurns++;
  turnQueue = turnQueue
    .then(task)
    .catch((e) => console.warn("翻页失败", e))
    .finally(() => {
      queuedTurns--;
    });
}

/**
 * 原生滑动要的换页（jump、back）单独排队，不排在点两侧的翻页后面：点两侧的翻页要等原生把这次滑动收完，
 * 原生又在等这次换页，排在一起就互相等住，翻不动了
 */
let nativeQueue: Promise<void> = Promise.resolve();
let nativeTurns = 0;
function enqueueNative(task: () => Promise<void>) {
  nativeTurns++;
  nativeQueue = nativeQueue
    .then(task)
    .catch((e) => console.warn("翻页失败", e))
    .finally(() => {
      nativeTurns--;
    });
}

function edgeToast(dir: 1 | -1) {
  toast(dir > 0 ? "已经是最后一页" : "已经是第一页");
}

/** 书页换好后等 Vue 改完页脚这些，再让原生开始动画 */
async function reveal(moved: boolean) {
  if (moved) await nextTick();
  await mobileApi.pageTurnReady(moved).catch((e) => {
    console.warn("翻页动画收尾失败", e);
    thawFoot();
  });
}

/** 真正换一页。滑动排队时每一页都走这里；点两侧只有空闲时才会进来 */
async function runTurn(dir: 1 | -1) {
  clearPick();
  // 上一章还在加载时 atEnd、atStart 还是旧的，先等上一次翻页结束再判断
  await settling;
  unpeek();
  if (atEdge(dir)) return edgeToast(dir);
  const crossed = crossesSection(dir);
  freezeFoot();
  const animated =
    nativeTurn &&
    !scrolled.value &&
    !pdfBook &&
    (await mobileApi.pageTurnStart(dir).catch((e) => {
      console.warn("翻页动画不可用，直接换页", e);
      return false;
    }));
  // 动画要等原生播完（done）才算结束，不能等这次任务返回
  if (animated) nativeAnimating = true;
  let moved = false;
  try {
    moved = await jumpPage(dir);
    if (moved) await settleTurn(crossed);
  } finally {
    if (animated) await reveal(moved);
    else thawFoot();
  }
  // 没翻动但不在首尾（比如章节没加载出来）时不能说成到头了
  if (!moved && atEdge(dir)) edgeToast(dir);
}

/** 点两侧翻页。这一下还没翻完时再点直接丢掉，松手后不会再慢慢补翻 */
function turn(dir: 1 | -1) {
  if (!view || queuedTurns > 0 || nativeAnimating || nativeTurns > 0) return;
  enqueue(() => runTurn(dir));
}

/** 滑动翻页：滑一次就要翻一页，正忙也排进去，不能并成一次 */
function queueSwipe(dir: 1 | -1) {
  if (!view) return;
  enqueue(() => runTurn(dir));
}

/**
 * 原生接管的滑动：jump 是翻过去，back 是松手时没翻过去、翻回原来那页，edge 是往到头的方向滑，done 是动画结束。
 * turn 是滑动时原生正忙没能跟手，松手后仍要补翻这一页
 */
function onNativeTurn(kind: string, dir: number) {
  if (kind === "done") {
    nativeAnimating = false;
    thawFoot();
    return schedulePrefetch(120);
  }
  const d: 1 | -1 = dir < 0 ? -1 : 1;
  if (kind === "edge") return edgeToast(d);
  if (kind === "turn") return queueSwipe(d);
  nativeAnimating = true;
  const target: 1 | -1 = kind === "back" ? (d > 0 ? -1 : 1) : d;
  enqueueNative(async () => {
    clearPick();
    unpeek();
    const crossed = crossesSection(target);
    freezeFoot();
    let moved = false;
    try {
      moved = await jumpPage(target);
      if (moved) await settleTurn(crossed);
    } finally {
      await reveal(moved);
    }
  });
}

type TurnWindow = Window & {
  __sparkTurn?: (kind: string, dir: number) => void;
  __sparkPeek?: (dir: number) => boolean;
  __sparkUnpeek?: () => void;
};

/** 菜单、面板、选字都收起来的时候才能滑动翻页 */
const swipeOn = computed(
  () =>
    ready.value &&
    !error.value &&
    !pdfBook &&
    !scrolled.value &&
    !chrome.value &&
    !sheet.value &&
    !pick.value &&
    !selecting.value &&
    !editing.value &&
    !editingSummary.value &&
    !currentOverlay.value,
);

/** 页脚的高度：翻页截图不盖住页脚，页脚在网页里直接跟着换页变 */
let footHeight = 0;
function measureFoot(): number {
  const h = document.querySelector(".ebook-foot")?.getBoundingClientRect().height ?? 0;
  if (h > 0) footHeight = Math.ceil(h);
  return footHeight;
}

let sentConfig = "";
function syncTurnConfig() {
  if (!nativeTurn) return;
  const o = { enabled: swipeOn.value, anim: ANIM_CODE[turnAnim.value], canPrev: !atStart.value, canNext: !atEnd.value, footer: measureFoot() };
  const key = JSON.stringify(o);
  if (key === sentConfig) return;
  sentConfig = key;
  void mobileApi.pageTurnConfig(o).catch((e) => console.warn("翻页设置失败", e));
}

/**
 * 书页停稳一会儿后，先在后台排好前后两章，再让原生把前一页、后一页截好。
 * 翻页时直接用截好的图，手指一动页面就跟着走，新页也不会先空一下
 */
let prefetchTimer = 0;
function schedulePrefetch(delay = 300) {
  clearTimeout(prefetchTimer);
  if (!nativeTurn || pdfBook || scrolled.value) return;
  prefetchTimer = window.setTimeout(async () => {
    const busy = () => queuedTurns > 0 || nativeTurns > 0 || footFrozen || !swipeOn.value;
    if (busy()) return;
    const at = currentCfi.value;
    const r = view?.renderer;
    await Promise.race([Promise.all([r?.preload?.(1), r?.preload?.(-1)]), wait(3000)]).catch(() => {});
    if (busy() || at !== currentCfi.value) return;
    void mobileApi.pageTurnPrefetch().catch((e) => console.warn("预截前后页失败", e));
  }, delay);
}

async function startNativeTurn() {
  (window as TurnWindow).__sparkTurn = onNativeTurn;
  (window as TurnWindow).__sparkPeek = (dir: number) => view?.renderer?.peek?.(dir) ?? false;
  (window as TurnWindow).__sparkUnpeek = unpeek;
  try {
    await mobileApi.pageTurnConfig({ enabled: false, anim: ANIM_CODE[turnAnim.value], canPrev: true, canNext: true });
    nativeTurn = true;
    syncTurnConfig();
  } catch (e) {
    console.warn("安卓翻页动画不可用，直接换页", e);
  }
}

function stopNativeTurn() {
  clearTimeout(prefetchTimer);
  nativeAnimating = false;
  unpeek();
  delete (window as TurnWindow).__sparkTurn;
  delete (window as TurnWindow).__sparkPeek;
  delete (window as TurnWindow).__sparkUnpeek;
  if (nativeTurn) void mobileApi.pageTurnStop().catch((e) => console.warn("收起翻页动画失败", e));
  nativeTurn = false;
}

watch([swipeOn, turnAnim, atStart, atEnd], syncTurnConfig);
// 菜单、面板收起后画面回到书页，截好的前后页可能还能用，不能用的话重新截
watch([swipeOn, turnAnim], () => schedulePrefetch());

function hasSelection(doc: Document) {
  const sel = doc.getSelection();
  return !!sel && !sel.isCollapsed;
}

/** 告诉原生这一页正在选字。要在下一次触摸之前设好，拖选区换行才不会被当成翻页 */
function reportSelecting(on: boolean) {
  const bridge = (window as unknown as { SparkSelecting?: { set: (v: boolean) => void } }).SparkSelecting;
  try {
    bridge?.set(on);
  } catch {
    /* 不在安卓里就没有这个接口 */
  }
}

/**
 * 阅读器自带的拖动翻页不用（它一帧帧改滚动位置，会和这里的翻页打架），在它之前把触摸拦下。
 * 原生接管滑动时这里只拦不管；不在安卓上时按松手的位置判断是不是左右滑。上下滚动和 PDF 交给阅读器自己。
 */
function watchSwipe(doc: Document) {
  const opts = { capture: true, passive: true } as const;
  doc.addEventListener("touchstart", (e: TouchEvent) => {
    if (scrolled.value || pdfBook) return;
    e.stopPropagation();
    const t = e.touches[0];
    gesture = nativeTurn || e.touches.length > 1 ? null : { x: t.screenX, y: t.screenY };
  }, opts);
  doc.addEventListener("touchmove", (e: TouchEvent) => {
    if (scrolled.value || pdfBook) return;
    e.stopPropagation();
  }, opts);
  const end = (e: TouchEvent) => {
    if (scrolled.value || pdfBook) return;
    e.stopPropagation();
    const g = gesture;
    gesture = null;
    if (!g || e.type === "touchcancel" || hasSelection(doc)) return;
    const t = e.changedTouches[0];
    const dx = t.screenX - g.x;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(t.screenY - g.y) * 1.5) queueSwipe(dx < 0 ? 1 : -1);
  };
  doc.addEventListener("touchend", end, opts);
  doc.addEventListener("touchcancel", end, opts);
}
function clearPick() {
  pick.value = null;
  reportSelecting(false);
  try {
    activeDoc?.getSelection()?.removeAllRanges();
    view?.deselect?.();
  } catch {
    /* 书页已经换掉时没什么可清的 */
  }
}

/** 当前这一页在书页 iframe 里的可见范围。下一页的字排在旁边，手指贴边时会被选进去 */
function pageBox(doc: Document): { left: number; right: number; top: number; bottom: number } | null {
  const frame = doc.defaultView?.frameElement as HTMLElement | null;
  if (!frame) return null;
  const frameRect = frame.getBoundingClientRect();
  let clip: HTMLElement | null = frame.parentElement;
  let clipRect = frameRect;
  while (clip) {
    const style = getComputedStyle(clip);
    const clips = style.overflowX === "hidden" || style.overflowX === "clip" || style.overflow === "hidden";
    const rect = clip.getBoundingClientRect();
    if (clips && rect.width > 0 && rect.width < frameRect.width - 1) {
      clipRect = rect;
      break;
    }
    const root = clip.getRootNode();
    clip = clip.parentElement ?? (root instanceof ShadowRoot ? (root.host as HTMLElement) : null);
  }
  const left = Math.max(clipRect.left, frameRect.left) - frameRect.left;
  const right = Math.min(clipRect.right, frameRect.right) - frameRect.left;
  const top = Math.max(clipRect.top, frameRect.top) - frameRect.top;
  const bottom = Math.min(clipRect.bottom, frameRect.bottom) - frameRect.top;
  if (right - left < 20) return null;
  return { left, right, top, bottom };
}

function rangeOnPage(range: Range, box: { left: number; right: number; top: number; bottom: number }): boolean {
  const rects = range.getClientRects();
  for (const r of rects) {
    if (r.width < 0.5 || r.height < 0.5) continue;
    // 整块落在这一页左边或右边，就是上一页或下一页的字
    if (r.left >= box.right - 1 || r.right <= box.left + 1) return false;
  }
  return true;
}

/** 选区伸进了旁边那一页时，把末尾收回来，收不回来就用上一次还在这一页里的选区 */
function shrinkOntoPage(range: Range, box: { left: number; right: number; top: number; bottom: number }, backward: boolean): Range | null {
  const next = range.cloneRange();
  for (let guard = 0; guard < 24 && !rangeOnPage(next, box); guard++) {
    if (backward) {
      const node = next.startContainer;
      if (node.nodeType === Node.TEXT_NODE && next.startOffset < (node.textContent?.length ?? 0)) {
        let lo = next.startOffset;
        let hi = node.textContent?.length ?? lo;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          next.setStart(node, mid);
          if (rangeOnPage(next, box)) hi = mid - 1;
          else lo = mid;
        }
        next.setStart(node, Math.min(lo + 1, node.textContent?.length ?? lo));
      } else {
        next.setStart(node, node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : next.startOffset);
        if (next.collapsed) return null;
      }
    } else if (next.endContainer.nodeType === Node.TEXT_NODE && next.endOffset > 0) {
      const node = next.endContainer;
      let lo = 0;
      let hi = next.endOffset;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        next.setEnd(node, mid);
        if (rangeOnPage(next, box)) lo = mid;
        else hi = mid - 1;
      }
      next.setEnd(node, lo);
    } else {
      next.setEnd(next.endContainer, 0);
    }
    if (next.collapsed) return null;
    if (rangeOnPage(next, box)) return next;
  }
  return rangeOnPage(next, box) && !next.collapsed ? next : null;
}

/** 选字：用 selectionchange 跟着把手更新，菜单放在选区上方，太靠上时放到下方 */
let selTimer = 0;
let clampingSel = false;
let keptSel: Range | null = null;
function watchSelection(doc: Document, index: number) {
  doc.addEventListener("selectionchange", () => {
    if (clampingSel) return;
    const sel = doc.getSelection();
    const on = !!sel && !sel.isCollapsed;
    selecting.value = on;
    reportSelecting(on);
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const box = pageBox(doc);
      const range = sel.getRangeAt(0);
      if (box && !rangeOnPage(range, box)) {
        const sameNode = sel.anchorNode === sel.focusNode;
        const backward =
          (sameNode && sel.anchorOffset > sel.focusOffset) ||
          (!sameNode &&
            !!sel.focusNode &&
            !!sel.anchorNode &&
            (sel.focusNode.compareDocumentPosition(sel.anchorNode) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
        const next = keptSel?.cloneRange() ?? shrinkOntoPage(range, box, backward);
        if (next && !next.collapsed) {
          clampingSel = true;
          sel.removeAllRanges();
          sel.addRange(next);
          clampingSel = false;
          keptSel = next.cloneRange();
        }
      } else {
        keptSel = range.cloneRange();
      }
    } else {
      keptSel = null;
    }
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
  void startNativeTurn();
  lockZoom();
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
    // 书页 iframe 外面（页边、跨章时短暂停留的空白页）的点按也一样翻页、呼出菜单，连点时不会丢掉一下
    node.addEventListener("pointerdown", onPointerDown);
    node.addEventListener("pointerup", (ev) => onPointerUp(ev, document));
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
      atStart.value = atEdge(-1);
      atEnd.value = atEdge(1);
      if (!footFrozen) snapshotFoot();
      else if (!onBlankPage()) showFoot();
      if (!onBlankPage()) {
        const waiting = relocateWaiters;
        relocateWaiters = [];
        for (const done of waiting) done();
      }
      schedulePrefetch();
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
  stopNativeTurn();
  thawFoot();
  unlockZoom();
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
  schedulePrefetch();
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
    <div v-if="shownRibbon && !chrome" class="ebook-ribbon" aria-hidden="true"></div>

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

    <div v-if="!chrome" class="ebook-foot"><span>{{ shownChapter }}</span><span>{{ shownPercent }}%</span></div>

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
            <p class="ghint seg-hint">点屏幕两侧或左右滑动都能翻页。覆盖是旧页滑走，或上一页从左边盖上来</p>
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
