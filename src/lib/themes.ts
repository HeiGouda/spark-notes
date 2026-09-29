export type Theme = "light" | "paper" | "green" | "night" | "black";

export interface ThemeInfo {
  id: Theme;
  name: string;
  dark: boolean;
}

/** 顺序即菜单与设置里的显示顺序：浅色系在前，深色系在后 */
export const THEMES: readonly ThemeInfo[] = [
  { id: "light", name: "浅色", dark: false },
  { id: "paper", name: "纸张", dark: false },
  { id: "green", name: "护眼", dark: false },
  { id: "night", name: "夜读", dark: true },
  { id: "black", name: "纯黑", dark: true },
];

export const DEFAULT_LIGHT_THEME: Theme = "light";
export const DEFAULT_DARK_THEME: Theme = "night";

/** 选择某套主题的命令 id，如 view.themePaper */
export function themeCommandId(theme: Theme): string {
  return `view.theme${theme[0].toUpperCase()}${theme.slice(1)}`;
}

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((t) => t.id === value);
}

export function isDarkTheme(theme: Theme): boolean {
  return THEMES.find((t) => t.id === theme)?.dark === true;
}

export function themeName(theme: Theme): string {
  return THEMES.find((t) => t.id === theme)?.name ?? theme;
}

export interface ThemeMemory {
  lastLight: Theme;
  lastDark: Theme;
}

/** 校正记住的浅色 / 深色主题：分组不对就用默认值，当前主题总是它那一侧的记忆 */
export function normalizeThemeMemory(theme: Theme, lastLight: unknown, lastDark: unknown): ThemeMemory {
  const light = isTheme(lastLight) && !isDarkTheme(lastLight) ? lastLight : DEFAULT_LIGHT_THEME;
  const dark = isTheme(lastDark) && isDarkTheme(lastDark) ? lastDark : DEFAULT_DARK_THEME;
  return isDarkTheme(theme) ? { lastLight: light, lastDark: theme } : { lastLight: theme, lastDark: dark };
}

/** 标题栏月亮 / 太阳按钮要切换到的主题 */
export function toggleTarget(theme: Theme, memory: ThemeMemory): Theme {
  return isDarkTheme(theme) ? memory.lastLight : memory.lastDark;
}
