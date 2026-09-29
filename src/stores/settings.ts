import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { load, type Store } from "@tauri-apps/plugin-store";
import { useNoticeStore } from "./notice";
import { shortcutOverrides } from "../lib/commands";
import { DEFAULT_TIDY_RULES, normalizeTidyRules, type TidyRuleId, type TidyRules } from "../editor/tidy";
import { AI_PRESETS, type AiPresetId } from "../lib/ai";
import { normalizeModels, resolveContext, type AiModelEntry, type ModelContext } from "../lib/aiModels";
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, THEMES, isDarkTheme, isTheme, normalizeThemeMemory, toggleTarget, type Theme } from "../lib/themes";

export type { Theme };
export type SortKey = "name" | "modified" | "created" | "custom";

/** 每个笔记库在本机的界面状态：上次打开的标签页、展开的文件夹、排序方式 */
export interface VaultUiState {
  tabs: string[];
  active: string | null;
  expanded: string[];
  sortKey: SortKey;
  sortDesc: boolean;
}

export const DEFAULT_VAULT_UI: VaultUiState = { tabs: [], active: null, expanded: [], sortKey: "name", sortDesc: false };

/** 应用级设置（每台电脑各自一份，不随笔记库同步） */
export interface AppSettings {
  theme: Theme;
  /** 标题栏按钮在这两个主题之间切换 */
  lastLightTheme: Theme;
  lastDarkTheme: Theme;
  lastVault: string | null;
  sidebarVisible: boolean;
  toolbarVisible: boolean;
  statusbarVisible: boolean;
  vaults: Record<string, VaultUiState>;
  /** 自定义快捷键：命令 id → 快捷键，null 表示设为“无” */
  keybindings: Record<string, string | null>;
  /** 格式工具栏中隐藏的按钮 id */
  toolbarHidden: string[];
  /** 最近在命令面板执行过的命令 id，最新的在前 */
  recentCommands: string[];
  openLastVault: boolean;
  restoreTabs: boolean;
  /** 界面缩放，100 为原始大小 */
  zoom: number;
  editorFontSize: number;
  editorLineHeight: number;
  editorMaxWidth: number;
  codeLineNumbers: boolean;
  spellcheck: boolean;
  /** 空字符串表示系统界面字体 */
  editorFont: string;
  /** 打开过的笔记库，最近使用的在前。从列表移除不会删除磁盘文件。 */
  vaultList: string[];
  /** 一键整理各条规则的开关 */
  tidyRules: TidyRules;
  /** AI：服务商预设、接口地址、模型列表（API Key 只存系统凭据库） */
  aiPreset: AiPresetId;
  aiBaseUrl: string;
  /** 旧版本的单个模型名，只用于迁移到 aiModels */
  aiModel?: string;
  /** 第一个是默认模型 */
  aiModels: AiModelEntry[];
  /** 从服务商读取到的上下文长度：模型名 → tokens */
  aiProviderContexts: Record<string, number>;
}

/** 默认隐藏的工具栏按钮（原型确认） */
export const DEFAULT_TOOLBAR_HIDDEN = ["clear", "indent", "outdent", "footnote"];
const RECENT_LIMIT = 5;

const DEFAULTS: AppSettings = {
  theme: "light",
  lastLightTheme: DEFAULT_LIGHT_THEME,
  lastDarkTheme: DEFAULT_DARK_THEME,
  lastVault: null,
  sidebarVisible: true,
  toolbarVisible: true,
  statusbarVisible: true,
  vaults: {},
  keybindings: {},
  toolbarHidden: DEFAULT_TOOLBAR_HIDDEN,
  recentCommands: [],
  openLastVault: true,
  restoreTabs: true,
  zoom: 100,
  editorFontSize: 15,
  editorLineHeight: 1.78,
  editorMaxWidth: 780,
  codeLineNumbers: true,
  spellcheck: false,
  editorFont: "",
  vaultList: [],
  tidyRules: DEFAULT_TIDY_RULES,
  aiPreset: "deepseek",
  aiBaseUrl: "https://api.deepseek.com/v1",
  aiModels: [],
  aiProviderContexts: {},
};

const FONT_FAMILY: Record<string, string> = {
  song: '"SimSun", "Songti SC", serif',
  kai: '"KaiTi", "STKaiti", serif',
  yahei: '"Microsoft YaHei", "PingFang SC", sans-serif',
};

export function applyAppearance(s: Pick<AppSettings, "zoom" | "editorFontSize" | "editorLineHeight" | "editorMaxWidth" | "codeLineNumbers" | "editorFont">): void {
  const root = document.documentElement;
  root.style.zoom = s.zoom === 100 ? "" : String(s.zoom / 100);
  root.style.setProperty("--doc-size", `${s.editorFontSize}px`);
  root.style.setProperty("--doc-lh", String(s.editorLineHeight));
  root.style.setProperty("--doc-w", `${s.editorMaxWidth}px`);
  root.style.setProperty("--doc-font", FONT_FAMILY[s.editorFont] ?? "var(--f-body)");
  root.classList.toggle("hide-gutters", !s.codeLineNumbers);
}

const VAULT_UI_SAVE_DELAY = 400;

let persist: Store | null = null;

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const t of THEMES) root.classList.toggle(t.id, t.id === theme && t.id !== "light");
}

/** 在挂载界面之前读取设置，保证首帧就是正确主题 */
export async function loadSettings(): Promise<AppSettings> {
  persist = await load("settings.json", { defaults: {}, autoSave: false });
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof AppSettings)[]) {
    const v = await persist.get(key);
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[key] = v;
  }
  if (!isTheme(out.theme)) out.theme = DEFAULTS.theme;
  const memory = normalizeThemeMemory(out.theme, out.lastLightTheme, out.lastDarkTheme);
  out.lastLightTheme = memory.lastLight;
  out.lastDarkTheme = memory.lastDark;
  const legacyModel = await persist.get("aiModel");
  if (typeof legacyModel === "string") out.aiModel = legacyModel;
  return out;
}

export const useSettingsStore = defineStore("settings", () => {
  const theme = ref<Theme>(DEFAULTS.theme);
  const lastLightTheme = ref<Theme>(DEFAULTS.lastLightTheme);
  const lastDarkTheme = ref<Theme>(DEFAULTS.lastDarkTheme);
  const lastVault = ref<string | null>(DEFAULTS.lastVault);
  const sidebarVisible = ref(DEFAULTS.sidebarVisible);
  const toolbarVisible = ref(DEFAULTS.toolbarVisible);
  const statusbarVisible = ref(DEFAULTS.statusbarVisible);
  const vaults = ref<Record<string, VaultUiState>>({});
  const toolbarHidden = ref<string[]>([...DEFAULT_TOOLBAR_HIDDEN]);
  const recentCommands = ref<string[]>([]);
  const openLastVault = ref(DEFAULTS.openLastVault);
  const restoreTabs = ref(DEFAULTS.restoreTabs);
  const zoom = ref(DEFAULTS.zoom);
  const editorFontSize = ref(DEFAULTS.editorFontSize);
  const editorLineHeight = ref(DEFAULTS.editorLineHeight);
  const editorMaxWidth = ref(DEFAULTS.editorMaxWidth);
  const codeLineNumbers = ref(DEFAULTS.codeLineNumbers);
  const spellcheck = ref(DEFAULTS.spellcheck);
  const editorFont = ref(DEFAULTS.editorFont);
  const vaultList = ref<string[]>([]);
  const tidyRules = ref<TidyRules>({ ...DEFAULT_TIDY_RULES });
  const aiPreset = ref<AiPresetId>(DEFAULTS.aiPreset);
  const aiBaseUrl = ref(DEFAULTS.aiBaseUrl);
  const aiModels = ref<AiModelEntry[]>([]);
  const aiProviderContexts = ref<Record<string, number>>({});
  /** 默认模型：模型列表的第一个 */
  const aiModel = computed(() => aiModels.value[0]?.name ?? "");
  let vaultTimer = 0;

  function hydrate(s: AppSettings) {
    theme.value = s.theme;
    lastLightTheme.value = s.lastLightTheme;
    lastDarkTheme.value = s.lastDarkTheme;
    lastVault.value = s.lastVault;
    sidebarVisible.value = s.sidebarVisible;
    toolbarVisible.value = s.toolbarVisible;
    statusbarVisible.value = s.statusbarVisible;
    vaults.value = typeof s.vaults === "object" && s.vaults ? s.vaults : {};
    shortcutOverrides.value = typeof s.keybindings === "object" && s.keybindings ? { ...s.keybindings } : {};
    toolbarHidden.value = Array.isArray(s.toolbarHidden) ? [...s.toolbarHidden] : [...DEFAULT_TOOLBAR_HIDDEN];
    recentCommands.value = Array.isArray(s.recentCommands) ? [...s.recentCommands] : [];
    openLastVault.value = s.openLastVault !== false;
    restoreTabs.value = s.restoreTabs !== false;
    zoom.value = clampNum(s.zoom, 80, 160, 100);
    editorFontSize.value = clampNum(s.editorFontSize, 13, 24, 15);
    editorLineHeight.value = clampNum(s.editorLineHeight, 1.4, 2.2, 1.78);
    editorMaxWidth.value = clampNum(s.editorMaxWidth, 560, 1200, 780);
    codeLineNumbers.value = s.codeLineNumbers !== false;
    spellcheck.value = s.spellcheck === true;
    editorFont.value = s.editorFont === "song" || s.editorFont === "kai" || s.editorFont === "yahei" ? s.editorFont : "";
    vaultList.value = Array.isArray(s.vaultList) ? s.vaultList.filter((p) => typeof p === "string") : [];
    tidyRules.value = normalizeTidyRules(s.tidyRules);
    aiPreset.value = AI_PRESETS.some((p) => p.id === s.aiPreset) ? s.aiPreset : DEFAULTS.aiPreset;
    aiBaseUrl.value = typeof s.aiBaseUrl === "string" ? s.aiBaseUrl : DEFAULTS.aiBaseUrl;
    aiModels.value = normalizeModels(s.aiModels, s.aiModel);
    aiProviderContexts.value = normalizeProviderContexts(s.aiProviderContexts);
    applyAppearance(appearance());
  }

  function appearance() {
    return {
      zoom: zoom.value,
      editorFontSize: editorFontSize.value,
      editorLineHeight: editorLineHeight.value,
      editorMaxWidth: editorMaxWidth.value,
      codeLineNumbers: codeLineNumbers.value,
      editorFont: editorFont.value,
    };
  }

  /* ---------- 快捷键 ---------- */
  function saveKeybindings() {
    void save("keybindings", { ...shortcutOverrides.value });
  }

  /** spec 为 null 表示设为“无” */
  function setShortcut(id: string, spec: string | null) {
    shortcutOverrides.value = { ...shortcutOverrides.value, [id]: spec };
    saveKeybindings();
  }

  function resetShortcut(id: string) {
    const next = { ...shortcutOverrides.value };
    delete next[id];
    shortcutOverrides.value = next;
    saveKeybindings();
  }

  function resetAllShortcuts() {
    shortcutOverrides.value = {};
    saveKeybindings();
  }

  function replaceShortcuts(map: Record<string, string | null>) {
    shortcutOverrides.value = { ...map };
    saveKeybindings();
  }

  /* ---------- 工具栏按钮与最近命令 ---------- */
  function toggleToolbarButton(id: string) {
    const list = toolbarHidden.value;
    toolbarHidden.value = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    void save("toolbarHidden", toolbarHidden.value);
  }

  function resetToolbarButtons() {
    toolbarHidden.value = [...DEFAULT_TOOLBAR_HIDDEN];
    void save("toolbarHidden", toolbarHidden.value);
  }

  function pushRecentCommand(id: string) {
    recentCommands.value = [id, ...recentCommands.value.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
    void save("recentCommands", recentCommands.value);
  }

  function vaultUi(root: string): VaultUiState {
    return { ...DEFAULT_VAULT_UI, ...vaults.value[root] };
  }

  /** 界面状态变化频繁，合并后延迟写盘 */
  function patchVaultUi(root: string, patch: Partial<VaultUiState>) {
    vaults.value = { ...vaults.value, [root]: { ...vaultUi(root), ...patch } };
    clearTimeout(vaultTimer);
    vaultTimer = window.setTimeout(() => void save("vaults", vaults.value), VAULT_UI_SAVE_DELAY);
  }

  /** 退出前立即写入尚在延迟中的界面状态 */
  async function flushVaultUi() {
    if (!vaultTimer) return;
    clearTimeout(vaultTimer);
    vaultTimer = 0;
    await save("vaults", vaults.value);
  }

  async function save<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    try {
      if (!persist) throw new Error("设置存储未初始化");
      await persist.set(key, value);
      await persist.save();
    } catch (e) {
      useNoticeStore().report("保存设置失败", e);
    }
  }

  function setTheme(t: Theme) {
    theme.value = t;
    applyTheme(t);
    void save("theme", t);
    if (isDarkTheme(t)) {
      lastDarkTheme.value = t;
      void save("lastDarkTheme", t);
    } else {
      lastLightTheme.value = t;
      void save("lastLightTheme", t);
    }
  }

  /** 标题栏月亮 / 太阳按钮要切换到的主题 */
  const toggleThemeTarget = computed(() => toggleTarget(theme.value, { lastLight: lastLightTheme.value, lastDark: lastDarkTheme.value }));

  function toggleDarkTheme() {
    setTheme(toggleThemeTarget.value);
  }

  function setLastVault(path: string | null) {
    lastVault.value = path;
    void save("lastVault", path);
    if (path) rememberVault(path);
  }

  function rememberVault(path: string) {
    vaultList.value = [path, ...vaultList.value.filter((p) => p !== path)].slice(0, 20);
    void save("vaultList", vaultList.value);
  }

  function forgetVault(path: string) {
    vaultList.value = vaultList.value.filter((p) => p !== path);
    void save("vaultList", vaultList.value);
  }

  function toggleSidebar() {
    sidebarVisible.value = !sidebarVisible.value;
    void save("sidebarVisible", sidebarVisible.value);
  }

  function toggleToolbar() {
    toolbarVisible.value = !toolbarVisible.value;
    void save("toolbarVisible", toolbarVisible.value);
  }

  function toggleStatusbar() {
    statusbarVisible.value = !statusbarVisible.value;
    void save("statusbarVisible", statusbarVisible.value);
  }

  function setOpenLastVault(on: boolean) {
    openLastVault.value = on;
    void save("openLastVault", on);
  }

  function setRestoreTabs(on: boolean) {
    restoreTabs.value = on;
    void save("restoreTabs", on);
  }

  function setZoom(n: number) {
    zoom.value = clampNum(n, 80, 160, 100);
    applyAppearance(appearance());
    void save("zoom", zoom.value);
  }

  function patchEditor(patch: Partial<Pick<AppSettings, "editorFontSize" | "editorLineHeight" | "editorMaxWidth" | "codeLineNumbers" | "spellcheck" | "editorFont">>) {
    if (patch.editorFontSize !== undefined) editorFontSize.value = clampNum(patch.editorFontSize, 13, 24, 15);
    if (patch.editorLineHeight !== undefined) editorLineHeight.value = clampNum(patch.editorLineHeight, 1.4, 2.2, 1.78);
    if (patch.editorMaxWidth !== undefined) editorMaxWidth.value = clampNum(patch.editorMaxWidth, 560, 1200, 780);
    if (patch.codeLineNumbers !== undefined) codeLineNumbers.value = patch.codeLineNumbers;
    if (patch.spellcheck !== undefined) spellcheck.value = patch.spellcheck;
    if (patch.editorFont !== undefined) editorFont.value = patch.editorFont;
    applyAppearance(appearance());
    void save("editorFontSize", editorFontSize.value);
    void save("editorLineHeight", editorLineHeight.value);
    void save("editorMaxWidth", editorMaxWidth.value);
    void save("codeLineNumbers", codeLineNumbers.value);
    void save("spellcheck", spellcheck.value);
    void save("editorFont", editorFont.value);
  }

  function setTidyRule(id: TidyRuleId, on: boolean) {
    tidyRules.value = { ...tidyRules.value, [id]: on };
    void save("tidyRules", tidyRules.value);
  }

  /** 选择预设时填好接口地址；“自定义”保留当前地址 */
  function setAiPreset(id: AiPresetId) {
    aiPreset.value = id;
    const preset = AI_PRESETS.find((p) => p.id === id);
    if (preset?.baseUrl) aiBaseUrl.value = preset.baseUrl;
    void save("aiPreset", id);
    void save("aiBaseUrl", aiBaseUrl.value);
  }

  function setAiBaseUrl(url: string) {
    aiBaseUrl.value = url.trim();
    void save("aiBaseUrl", aiBaseUrl.value);
  }

  function setAiModels(list: AiModelEntry[]) {
    aiModels.value = normalizeModels(list);
    void save("aiModels", aiModels.value);
  }

  function setAiProviderContexts(map: Record<string, number>) {
    aiProviderContexts.value = normalizeProviderContexts(map);
    void save("aiProviderContexts", aiProviderContexts.value);
  }

  /** 模型的上下文长度与来源；不在列表里的模型按自动规则计算 */
  function contextOf(name: string): ModelContext {
    const entry = aiModels.value.find((m) => m.name === name) ?? { name, context: null };
    return resolveContext(entry, aiProviderContexts.value);
  }

  return {
    theme, lastLightTheme, lastDarkTheme, toggleThemeTarget, lastVault, sidebarVisible, toolbarVisible, statusbarVisible, vaults, toolbarHidden, recentCommands,
    openLastVault, restoreTabs, zoom, editorFontSize, editorLineHeight, editorMaxWidth, codeLineNumbers, spellcheck, editorFont, vaultList, tidyRules, aiPreset, aiBaseUrl, aiModel, aiModels, aiProviderContexts,
    setShortcut, resetShortcut, resetAllShortcuts, replaceShortcuts,
    toggleToolbarButton, resetToolbarButtons, pushRecentCommand,
    hydrate, vaultUi, patchVaultUi, flushVaultUi, setTheme, toggleDarkTheme, setLastVault, toggleSidebar, toggleToolbar, toggleStatusbar,
    setOpenLastVault, setRestoreTabs, setZoom, patchEditor, rememberVault, forgetVault, setTidyRule, setAiPreset, setAiBaseUrl, setAiModels, setAiProviderContexts, contextOf,
  };
});

function normalizeProviderContexts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (k && Number.isFinite(n) && n > 0) out[k] = Math.round(n);
  }
  return out;
}

function clampNum(value: number, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
