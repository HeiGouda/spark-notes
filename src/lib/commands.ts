import { ref } from "vue";
import { isMac } from "./platform";
import { MAC_DEFAULT_SHORTCUTS, matchShortcut, normalizeShortcut, withShortcut } from "./shortcut";

/**
 * 命令注册表。菜单、按钮、快捷键、命令面板都通过命令 id 调用同一实现。
 * 快捷键 = 用户自定义（应用级设置）优先，否则为默认值（需求文档 5.13）。
 */
export type CommandScope = "global" | "editor";

export interface AppCommand {
  id: string;
  title: string;
  /** 命令面板和快捷键设置里的分组 */
  category: string;
  /** global：任何地方都生效；editor：只在编辑器获得焦点时生效 */
  scope?: CommandScope;
  /** 默认快捷键，null 表示默认无 */
  defaultShortcut: string | null;
  run: () => unknown;
  enabled?: () => boolean;
  /** 不在命令面板中列出（例如只供菜单使用的变体） */
  hidden?: boolean;
}

const registry = new Map<string, AppCommand>();

/** 用户自定义的快捷键：命令 id → 快捷键；值为 null 表示设为“无” */
export const shortcutOverrides = ref<Record<string, string | null>>({});

export function registerCommands(commands: AppCommand[]): void {
  for (const c of commands) {
    const macDefault = isMac ? MAC_DEFAULT_SHORTCUTS[c.id] : undefined;
    registry.set(c.id, macDefault ? { ...c, defaultShortcut: macDefault } : c);
  }
}

export function getCommand(id: string): AppCommand | undefined {
  return registry.get(id);
}

export function listCommands(): AppCommand[] {
  return [...registry.values()];
}

export function shortcutOf(id: string): string | null {
  if (Object.prototype.hasOwnProperty.call(shortcutOverrides.value, id)) return shortcutOverrides.value[id];
  return registry.get(id)?.defaultShortcut ?? null;
}

/** 悬停提示：名称加上命令当前的快捷键 */
export function tipFor(title: string, id: string): string {
  return withShortcut(title, shortcutOf(id));
}

export function isCustomized(id: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(shortcutOverrides.value, id)) return false;
  const def = registry.get(id)?.defaultShortcut ?? null;
  const cur = shortcutOverrides.value[id];
  return (cur && normalizeShortcut(cur)) !== (def && normalizeShortcut(def));
}

export function isEnabled(id: string): boolean {
  const c = registry.get(id);
  return !!c && (c.enabled ? c.enabled() : true);
}

export async function runCommand(id: string): Promise<void> {
  const c = registry.get(id);
  if (!c) throw new Error(`未注册的命令：${id}`);
  if (c.enabled && !c.enabled()) return;
  await c.run();
}

/** 按当前快捷键查找命令；scope 为 global 时只查全局命令 */
export function dispatchShortcut(e: KeyboardEvent, scope: CommandScope = "global"): AppCommand | null {
  for (const c of registry.values()) {
    if ((c.scope ?? "global") !== scope) continue;
    const s = shortcutOf(c.id);
    if (s && matchShortcut(e, s)) return c;
  }
  return null;
}

/** 已占用该快捷键的其他命令 */
export function findConflict(spec: string, exceptId?: string): AppCommand | null {
  const want = normalizeShortcut(spec);
  for (const c of registry.values()) {
    if (c.id === exceptId) continue;
    const s = shortcutOf(c.id);
    if (s && normalizeShortcut(s) === want) return c;
  }
  return null;
}
