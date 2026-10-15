/** 软键盘高度写进 --kb（CSS 像素）。边到边时窗口不缩小，底部输入面板靠它抬上去。 */

let nativeKb = 0;
/** 键盘没收起时的布局高度。窗口自己缩小了就不要再抬一次 */
let fullHeight = 0;

function viewportGap(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
}

function rememberFullHeight() {
  const inner = window.innerHeight;
  if (nativeKb < 1 && viewportGap() < 24) fullHeight = inner;
}

export function keepCaretVisible(el: HTMLElement) {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (!(el instanceof HTMLTextAreaElement)) return;
  const parsed = parseFloat(getComputedStyle(el).lineHeight);
  const lineHeight = Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
  const caret = el.selectionStart ?? 0;
  const line = el.value.slice(0, caret).split("\n").length - 1;
  const top = line * lineHeight;
  const bottom = top + lineHeight;
  if (top < el.scrollTop) el.scrollTop = top;
  else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, bottom - el.clientHeight);
}

function focusedField(): HTMLElement | null {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && el.type !== "range" && el.type !== "checkbox" && el.type !== "button") return el;
  return null;
}

function applyKeyboard() {
  rememberFullHeight();
  const layoutOverlap = fullHeight > 0 ? Math.max(0, Math.round(fullHeight - window.innerHeight)) : 0;
  const px = Math.max(0, Math.min(Math.max(nativeKb, viewportGap()) - layoutOverlap, window.innerHeight));
  document.documentElement.style.setProperty("--kb", `${px}px`);
  const field = focusedField();
  if (field) window.setTimeout(() => keepCaretVisible(field), 0);
}

function setNativeKb(px: number) {
  const n = Number(px);
  nativeKb = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  applyKeyboard();
}

/** 尽早装上。原生可能在页面脚本之前就报过一次高度，先记在 __sparkKb 里 */
export function installKeyboardInset() {
  const w = window as Window & { __sparkKb?: number; __sparkKeyboard?: (px: number) => void };
  fullHeight = window.innerHeight;
  if (typeof w.__sparkKb === "number") nativeKb = Math.max(0, Math.round(w.__sparkKb));
  w.__sparkKeyboard = setNativeKb;
  applyKeyboard();
  window.visualViewport?.addEventListener("resize", applyKeyboard);
  window.visualViewport?.addEventListener("scroll", applyKeyboard);
  window.addEventListener("resize", applyKeyboard);
  const nudge = (e: Event) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) {
      keepCaretVisible(t);
      window.setTimeout(() => keepCaretVisible(t), 280);
    }
  };
  document.addEventListener("focusin", nudge);
  document.addEventListener("input", (e) => {
    if (e.target instanceof HTMLTextAreaElement) keepCaretVisible(e.target);
  });
  document.addEventListener("keyup", (e) => {
    if (e.target instanceof HTMLTextAreaElement) keepCaretVisible(e.target);
  });
}
