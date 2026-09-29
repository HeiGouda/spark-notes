import { isMac } from "./platform";

/**
 * 快捷键统一用需求文档里的写法，如 "Ctrl+Shift+B"。
 * macOS 上 Ctrl 映射为 Cmd、Alt 映射为 Option（需求文档 5.13）。
 */

const ARROWS: Record<string, string> = { "←": "ArrowLeft", "→": "ArrowRight", "↑": "ArrowUp", "↓": "ArrowDown" };
const ARROW_NAMES: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };

/** 按物理键位识别符号键，避免 Shift 改变 e.key（如 Shift+, 得到 "<"） */
const CODE_KEYS: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Minus: "-", Equal: "=",
  BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Backquote: "`",
  Space: "Space", Tab: "Tab", Enter: "Enter", Backspace: "Backspace", Delete: "Delete",
  Escape: "Escape", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert",
};

interface Parsed {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parse(spec: string): Parsed {
  const parts = spec.split("+");
  // "Ctrl++" 这类写法里最后一段为空，按键本身是 "+"
  const key = parts[parts.length - 1] === "" ? "+" : parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.trim().toLowerCase());
  return {
    ctrl: mods.includes("ctrl") || mods.includes("cmd"),
    shift: mods.includes("shift"),
    alt: mods.includes("alt"),
    key: key.trim(),
  };
}

/** 事件对应的按键名，与快捷键写法中的按键部分一致（字母大写、方向键为箭头符号） */
export function eventKey(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (/^Numpad\d$/.test(e.code)) return e.code.slice(6);
  if (/^F\d{1,2}$/.test(e.code)) return e.code;
  if (ARROW_NAMES[e.code]) return ARROW_NAMES[e.code];
  if (CODE_KEYS[e.code]) return CODE_KEYS[e.code];
  if (ARROW_NAMES[e.key]) return ARROW_NAMES[e.key];
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

export function matchShortcut(e: KeyboardEvent, spec: string): boolean {
  const p = parse(spec);
  const ctrl = isMac ? e.metaKey : e.ctrlKey;
  if (ctrl !== p.ctrl || e.shiftKey !== p.shift || e.altKey !== p.alt) return false;
  const want = ARROWS[p.key] ? ARROW_NAMES[ARROWS[p.key]] : p.key;
  return eventKey(e).toLowerCase() === want.toLowerCase();
}

/** 统一写法：修饰键按 Ctrl、Alt、Shift 排序，单个字母大写 */
export function normalizeShortcut(spec: string): string {
  const p = parse(spec);
  const key = p.key.length === 1 ? p.key.toUpperCase() : p.key;
  return [p.ctrl && "Ctrl", p.alt && "Alt", p.shift && "Shift", key].filter(Boolean).join("+");
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "CapsLock"]);

/** 录入快捷键：把按键事件转成快捷键写法；只按了修饰键时返回 null */
export function eventToShortcut(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const ctrl = isMac ? e.metaKey : e.ctrlKey;
  return normalizeShortcut([ctrl && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", eventKey(e)].filter(Boolean).join("+"));
}

/**
 * 系统或编辑必需的组合键，不允许占用（需求文档 5.13）。
 * macOS 另有退出、隐藏、最小化、切换应用、注销，由系统或菜单栏先处理，网页收不到。
 */
export const RESERVED_SHORTCUTS = isMac
  ? ["Ctrl+C", "Ctrl+X", "Ctrl+V", "Ctrl+A", "Ctrl+Q", "Ctrl+H", "Ctrl+Alt+H", "Ctrl+M", "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+Shift+Q"]
  : ["Ctrl+C", "Ctrl+X", "Ctrl+V", "Ctrl+A", "Alt+F4"];

/** Windows 默认快捷键在 macOS 上被系统占用或不合习惯时，改用的默认值：命令 id → 快捷键 */
export const MAC_DEFAULT_SHORTCUTS: Record<string, string> = {
  "edit.redo": "Ctrl+Shift+Z",
  "edit.replace": "Ctrl+Alt+F",
  "tab.next": "Ctrl+Shift+]",
  "tab.prev": "Ctrl+Shift+[",
  // Option+方向键在 macOS 上是按词移动光标
  "nav.back": "Ctrl+[",
  "nav.forward": "Ctrl+]",
  "format.quote": "Ctrl+Alt+Q",
};

/** 校验能否作为快捷键；不能时返回原因 */
export function shortcutProblem(spec: string): string | null {
  const s = normalizeShortcut(spec);
  if (RESERVED_SHORTCUTS.includes(s)) return `${displayShortcut(s)} 是保留组合键，不能占用`;
  const p = parse(s);
  const fnKey = /^F\d{1,2}$/.test(p.key);
  const editKey = p.key === "Tab" && !p.ctrl && !p.alt;
  if (!p.ctrl && !p.alt && !fnKey && !editKey) {
    return isMac ? "快捷键需要包含 Cmd 或 Option（F1–F12 与 Tab 除外）" : "快捷键需要包含 Ctrl 或 Alt（F1–F12 与 Tab 除外）";
  }
  return null;
}

export function displayShortcut(spec: string | null | undefined): string {
  if (!spec) return "";
  return isMac ? spec.replace(/Ctrl/g, "Cmd").replace(/Alt/g, "Option") : spec;
}

/** 悬停提示里显示的文字，如 "加粗 (Ctrl+B)" */
export function withShortcut(title: string, spec: string | null | undefined): string {
  return spec ? `${title} (${displayShortcut(spec)})` : title;
}
