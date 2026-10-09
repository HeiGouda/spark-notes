import { computed, ref } from "vue";
import { docKind } from "../lib/doctype";
import { isBookPath } from "../lib/book";
import { firstSheet } from "./browse";
import { useMobile } from "./store";
import { zhError } from "./errors";

export type Page =
  | { p: "welcome" }
  | { p: "form"; id: string | null }
  | { p: "firstsync"; id: string }
  | { p: "files"; path: string }
  /** 最近打开，从文件页右上角进入 */
  | { p: "recent" }
  /** 搜索，从文件页根目录的搜索框进入 */
  | { p: "search" }
  | { p: "shelf" }
  /** 云端书架，从书架右上角进入 */
  | { p: "cloud" }
  | { p: "assistant" }
  | { p: "me" }
  /** “我的”里的二级页面 */
  | { p: "shelf-settings" }
  | { p: "ai-models" }
  /** 添加或编辑一个模型；id 为空时是添加 */
  | { p: "ai-model"; id: string | null }
  | { p: "reader-settings" }
  | { p: "about" }
  | { p: "note"; path: string; heading?: string }
  | { p: "diagram"; path: string }
  | { p: "ebook"; id: string };

export type Overlay =
  | { t: "libs" }
  | { t: "bulk" }
  | { t: "del"; id: string }
  | { t: "outline" }
  | { t: "readset" }
  | { t: "image"; src: string; alt: string }
  /** 阅读页的 AI 弹窗；quote 是选中的文字，作为引用填进新对话 */
  | { t: "ai"; quote?: string };

export type Tab = "files" | "shelf" | "assistant" | "me";

/** 四个底部标签各自的首页 */
const TAB_HOME: Record<Tab, Page> = {
  files: { p: "files", path: "" },
  shelf: { p: "shelf" },
  assistant: { p: "assistant" },
  me: { p: "me" },
};

/** 页面属于哪个底部标签；阅读页、最近打开、搜索这类二级页面不属于任何标签 */
function tabOf(p: Page): Tab | null {
  switch (p.p) {
    case "files":
    // 搜索是文件页的一个状态（原型图 1-b），底部标签栏仍在，停在“文件”
    case "search":
      return "files";
    case "shelf":
    case "cloud":
      return "shelf";
    case "assistant":
      return "assistant";
    case "me":
    case "shelf-settings":
    case "ai-models":
    case "ai-model":
    case "reader-settings":
    case "about":
      return "me";
    default:
      return null;
  }
}

const stack = ref<Page[]>([{ p: "welcome" }]);
const overlay = ref<Overlay | null>(null);
const toastText = ref("");
let toastTimer = 0;

export const page = computed(() => stack.value[stack.value.length - 1]);
export const currentOverlay = overlay;
export const toastMessage = toastText;
export const activeTab = computed<Tab | null>(() => tabOf(page.value));

export function toast(msg: string) {
  toastText.value = zhError(msg);
  clearTimeout(toastTimer);
  // 长的报错多停一会儿，来得及看完
  toastTimer = window.setTimeout(() => (toastText.value = ""), Math.min(6000, 2000 + toastText.value.length * 60));
}

/** 每震一次加一，界面用它重放一次“弹一下”的动画 */
export const exitBump = ref(0);
const EXIT_WINDOW_MS = 2000;
let hintAt = 0;

function warnBeforeExit(now: number) {
  hintAt = now;
  exitBump.value++;
  try {
    navigator.vibrate?.(30);
  } catch {
    // 不支持震动的设备只有动画和提示
  }
  toast("再按一次返回键退出");
}

/**
 * 返回键或返回手势：先关浮层、退回上一层，一直退到文件页根目录。
 * 在根目录再返回先震一下并提示；2 秒内再返回一次才回到桌面。
 */
export function handleSystemBack(now = Date.now()): "handled" | "hint" | "exit" {
  if (back()) {
    hintAt = 0;
    return "handled";
  }
  if (hintAt && now - hintAt < EXIT_WINDOW_MS) {
    hintAt = 0;
    return "exit";
  }
  warnBeforeExit(now);
  return "hint";
}

/*
 * 安卓上用 Tauri 的返回键事件：注册之后系统不再自己后退或退出，包括各家手机的左右滑动返回。
 * 阅读页的书在 iframe 里，翻页会往 WebView 历史里加记录，用历史记录来接返回键会被它们吞掉。
 * 不在 App 里（浏览器预览、测试）时退回到历史记录的办法：始终多留一条「哨兵」记录。
 */
let native = false;
let armed = false;

function arm() {
  if (native || armed) return;
  history.pushState({ spark: true }, "");
  armed = true;
}

export async function installBackButton() {
  try {
    const { onBackButtonPress } = await import("@tauri-apps/api/app");
    await onBackButtonPress(() => {
      if (handleSystemBack() === "exit") {
        void import("./api").then(({ mobileApi }) => mobileApi.moveToBack()).catch((e) => toast(e instanceof Error ? e.message : String(e)));
      }
    });
    native = true;
  } catch {
    arm();
    window.addEventListener("popstate", () => {
      armed = false;
      // 退到底时不补哨兵，下一次返回交给浏览器
      if (handleSystemBack() !== "exit") arm();
    });
  }
}

/** 页面自己的浮层（菜单、底部面板）先接返回键；返回 true 表示已经处理 */
const interceptors: (() => boolean)[] = [];

export function addBackInterceptor(fn: () => boolean): () => void {
  interceptors.push(fn);
  return () => {
    const i = interceptors.lastIndexOf(fn);
    if (i >= 0) interceptors.splice(i, 1);
  };
}
/** 返回上一层；已经在首页时返回 false */
export function back(): boolean {
  for (let i = interceptors.length - 1; i >= 0; i--) if (interceptors[i]()) return true;
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
  reset(TAB_HOME[t]);
}

export function open(o: Overlay) {
  overlay.value = o;
  arm();
}

export function close() {
  overlay.value = null;
}
