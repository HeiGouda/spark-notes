import { computed, ref } from "vue";
import { docKind } from "../lib/doctype";
import { isBookPath } from "../lib/book";
import { firstSheet } from "./browse";
import { useMobile } from "./store";

export type Page =
  | { p: "welcome" }
  | { p: "form"; id: string | null }
  | { p: "firstsync"; id: string }
  | { p: "files"; path: string }
  | { p: "recent" }
  | { p: "search" }
  | { p: "me" }
  | { p: "note"; path: string; heading?: string }
  | { p: "diagram"; path: string };

export type Overlay =
  | { t: "libs" }
  | { t: "bulk" }
  | { t: "del"; id: string }
  | { t: "outline" }
  | { t: "readset" }
  | { t: "image"; src: string; alt: string };

export type Tab = "files" | "recent" | "search" | "me";

const stack = ref<Page[]>([{ p: "welcome" }]);
const overlay = ref<Overlay | null>(null);
const toastText = ref("");
let toastTimer = 0;

export const page = computed(() => stack.value[stack.value.length - 1]);
export const currentOverlay = overlay;
export const toastMessage = toastText;
export const activeTab = computed<Tab | null>(() => {
  const p = page.value.p;
  return p === "files" || p === "recent" || p === "search" || p === "me" ? p : null;
});

export function toast(msg: string) {
  toastText.value = msg;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastText.value = ""), 2000);
}

/*
 * 安卓返回键会先让 WebView 后退一步。历史里始终多留一条「哨兵」记录：
 * 返回键弹掉它时由我们自己处理后退，处理完再补一条；已经退到底时不补，再按一次就退出 App。
 */
let armed = false;

function arm() {
  if (armed) return;
  history.pushState({ spark: true }, "");
  armed = true;
}

export function installBackButton() {
  arm();
  window.addEventListener("popstate", () => {
    armed = false;
    if (back()) arm();
    else toast("再按一次返回键退出");
  });
}

/** 返回上一层；已经在首页时返回 false */
export function back(): boolean {
  if (overlay.value) {
    overlay.value = null;
    return true;
  }
  if (stack.value.length > 1) {
    stack.value = stack.value.slice(0, -1);
    return true;
  }
  const p = page.value.p;
  if (p !== "files" && p !== "welcome") {
    stack.value = [{ p: "files", path: "" }];
    return true;
  }
  return false;
}

/** 笔记进阅读页，思维导图和流程图进图页；表格簿打开它的第一张表 */
export function openDoc(path: string, heading?: string) {
  const target = sheetPage(path, heading);
  if (target) go(target);
}

function sheetPage(path: string, heading?: string): Page | null {
  let file = path;
  if (isBookPath(path)) {
    const first = firstSheet(useMobile().tree, path);
    if (!first) {
      toast("这个表格簿里没有表");
      return null;
    }
    file = first.path;
  }
  return (docKind(file) ?? "note") === "note" ? { p: "note", path: file, heading } : { p: "diagram", path: file };
}

/** 在表格簿里切换到另一张表：替换当前页，返回键仍回到列表 */
export function switchSheet(path: string) {
  const target = sheetPage(path);
  if (!target) return;
  overlay.value = null;
  stack.value = [...stack.value.slice(0, -1), target];
}

export function go(next: Page) {
  overlay.value = null;
  stack.value = [...stack.value, next];
  arm();
}

/** 换掉整个页面栈，例如切换标签、保存后跳转 */
export function reset(...pages: Page[]) {
  overlay.value = null;
  stack.value = pages.length ? pages : [{ p: "files", path: "" }];
  arm();
}

export function tab(t: Tab) {
  reset(t === "files" ? { p: "files", path: "" } : { p: t });
}

export function open(o: Overlay) {
  overlay.value = o;
  arm();
}

export function close() {
  overlay.value = null;
}
