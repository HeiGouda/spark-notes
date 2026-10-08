import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { load, type Store } from "@tauri-apps/plugin-store";
import { useNoticeStore } from "./notice";
import { shortcutOverrides } from "../lib/commands";
import { DEFAULT_TIDY_RULES, normalizeTidyRules, type TidyRuleId, type TidyRules } from "../editor/tidy";
import { api } from "../lib/api";
import { normalizeModels, resolveContext, type AiModelEntry, type LegacyAiSettings, type ModelContext } from "../lib/aiModels";
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
  /** 图的视图状态（不写进文件）：相对路径 → 折叠的节点、缩放 */
  diagrams: Record<string, DiagramViewState>;
  /** 文件树中隐藏的文件和文件夹（相对路径），只影响文件树 */
  hidden: string[];
  /** 表格簿上次停在哪张表：表格簿相对路径 → 表的相对路径（只在本机，不写进 .book.json） */
  bookSheets: Record<string, string>;
}

export interface DiagramViewState {
  /** 折叠的思维导图节点，用从根节点起的文字路径标识 */
  collapsed?: string[];
  zoom?: number;
}

export const DEFAULT_VAULT_UI: VaultUiState = { tabs: [], active: null, expanded: [], sortKey: "name", sortDesc: false, diagrams: {}, hidden: [], bookSheets: {} };

/** 正文宽度：固定像素，或铺满编辑区 */
export type EditorWidthMode = "fixed" | "fill";

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
  editorWidthMode: EditorWidthMode;
  /** 在笔记里按住 Ctrl 滚动滚轮调整正文字号 */
  wheelFontSize: boolean;
  codeLineNumbers: boolean;
  spellcheck: boolean;
  /** 空字符串表示系统界面字体 */
  editorFont: string;
  /** 打开过的笔记库，最近使用的在前。从列表移除不会删除磁盘文件。 */
  vaultList: string[];
  /** 一键整理各条规则的开关 */
  tidyRules: TidyRules;
  /** AI 模型列表：每个模型自带服务商和接口地址（API Key 按接口地址只存系统凭据库） */
  aiModels: AiModelEntry[];
  /** 默认模型的 id；为空或找不到时用列表第一个 */
  aiDefaultModel: string;
  /** 旧版本的 AI 设置（一套接口地址），只用于迁移，迁移后从设置文件删除 */
  legacyAi?: LegacyAiSettings;
}

/** 旧版本 AI 设置在设置文件里的键 */
const LEGACY_AI_KEYS = ["aiPreset", "aiBaseUrl", "aiModel", "aiProviderContexts"] as const;
/** 旧版本接口地址的默认值（用户没改过时设置文件里没有这一项） */
const LEGACY_DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

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
  editorWidthMode: "fixed",
  wheelFontSize: true,
  codeLineNumbers: true,
  spellcheck: false,
  editorFont: "",
  vaultList: [],
  tidyRules: DEFAULT_TIDY_RULES,
  aiModels: [],
  aiDefaultModel: "",
};

const FONT_FAMILY: Record<string, string> = {
  song: '"SimSun", "Songti SC", serif',
  kai: '"KaiTi", "STKaiti", serif',
  yahei: '"Microsoft YaHei", "PingFang SC", sans-serif',
};

export function applyAppearance(s: Pick<AppSettings, "zoom" | "editorFontSize" | "editorLineHeight" | "editorMaxWidth" | "editorWidthMode" | "codeLineNumbers" | "editorFont">): void {
  const root = document.documentElement;
  root.style.zoom = s.zoom === 100 ? "" : String(s.zoom / 100);
  root.style.setProperty("--doc-size", `${s.editorFontSize}px`);
  root.style.setProperty("--doc-lh", String(s.editorLineHeight));
  root.style.setProperty("--doc-w", `${s.editorMaxWidth}px`);
  root.style.setProperty("--note-w", s.editorWidthMode === "fill" ? "none" : `${s.editorMaxWidth}px`);
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
  const [baseUrl, model, providerContexts] = await Promise.all([persist.get("aiBaseUrl"), persist.get("aiModel"), persist.get("aiProviderContexts")]);
  out.legacyAi = { baseUrl: baseUrl ?? LEGACY_DEFAULT_BASE_URL, model, providerContexts };
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
  const editorWidthMode = ref<EditorWidthMode>(DEFAULTS.editorWidthMode);
  const wheelFontSize = ref(DEFAULTS.wheelFontSize);
  const codeLineNumbers = ref(DEFAULTS.codeLineNumbers);
  const spellcheck = ref(DEFAULTS.spellcheck);
  const editorFont = ref(DEFAULTS.editorFont);
  const vaultList = ref<string[]>([]);
  const tidyRules = ref<TidyRules>({ ...DEFAULT_TIDY_RULES });
  const aiModels = ref<AiModelEntry[]>([]);
  const aiDefaultModel = ref("");
  /** 默认模型：AI 指令、总结、整理结构、提交说明、生成图都用它 */
  const defaultModel = computed<AiModelEntry | null>(() => aiModels.value.find((m) => m.id === aiDefaultModel.value) ?? aiModels.value[0] ?? null);
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
    editorWidthMode.value = s.editorWidthMode === "fill" ? "fill" : "fixed";
    wheelFontSize.value = s.wheelFontSize !== false;
    codeLineNumbers.value = s.codeLineNumbers !== false;
    spellcheck.value = s.spellcheck === true;
    editorFont.value = s.editorFont === "song" || s.editorFont === "kai" || s.editorFont === "yahei" ? s.editorFont : "";
    vaultList.value = Array.isArray(s.vaultList) ? s.vaultList.filter((p) => typeof p === "string") : [];
    tidyRules.value = normalizeTidyRules(s.tidyRules);
    const ai = normalizeModels(s.aiModels, s.legacyAi);
    aiModels.value = ai.models;
    aiDefaultModel.value = typeof s.aiDefaultModel === "string" && ai.models.some((m) => m.id === s.aiDefaultModel) ? s.aiDefaultModel : (ai.models[0]?.id ?? "");
    if (ai.migrated) void migrateAi(ai.legacyBaseUrl);
    applyAppearance(appearance());
  }

  /** 旧版本的 AI 设置转成模型列表后：写回新格式，删掉旧的键，把唯一的 API Key 搬到原来的接口地址名下 */
  async function migrateAi(legacyBaseUrl: string | null) {
    await save("aiModels", aiModels.value);
    await save("aiDefaultModel", aiDefaultModel.value);
    try {
      if (legacyBaseUrl) await api.aiMigrateKey(legacyBaseUrl);
      if (!persist) return;
      for (const key of LEGACY_AI_KEYS) await persist.delete(key);
      await persist.save();
    } catch (e) {
      useNoticeStore().report("迁移旧的 AI 设置失败", e);
    }
  }

  function appearance() {
    return {
      zoom: zoom.value,
      editorFontSize: editorFontSize.value,
      editorLineHeight: editorLineHeight.value,
      editorMaxWidth: editorMaxWidth.value,
      editorWidthMode: editorWidthMode.value,
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

  function diagramView(root: string, path: string): DiagramViewState {
    return vaultUi(root).diagrams[path] ?? {};
  }

  function patchDiagramView(root: string, path: string, patch: DiagramViewState) {
    const diagrams = vaultUi(root).diagrams;
    patchVaultUi(root, { diagrams: { ...diagrams, [path]: { ...diagrams[path], ...patch } } });
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

  function patchEditor(patch: Partial<Pick<AppSettings, "editorFontSize" | "editorLineHeight" | "editorMaxWidth" | "editorWidthMode" | "wheelFontSize" | "codeLineNumbers" | "spellcheck" | "editorFont">>) {
    if (patch.editorFontSize !== undefined) editorFontSize.value = clampNum(patch.editorFontSize, 13, 24, 15);
    if (patch.editorLineHeight !== undefined) editorLineHeight.value = clampNum(patch.editorLineHeight, 1.4, 2.2, 1.78);
    if (patch.editorMaxWidth !== undefined) editorMaxWidth.value = clampNum(patch.editorMaxWidth, 560, 1200, 780);
    if (patch.editorWidthMode !== undefined) editorWidthMode.value = patch.editorWidthMode;
    if (patch.wheelFontSize !== undefined) wheelFontSize.value = patch.wheelFontSize;
    if (patch.codeLineNumbers !== undefined) codeLineNumbers.value = patch.codeLineNumbers;
    if (patch.spellcheck !== undefined) spellcheck.value = patch.spellcheck;
    if (patch.editorFont !== undefined) editorFont.value = patch.editorFont;
    applyAppearance(appearance());
    void save("editorFontSize", editorFontSize.value);
    void save("editorLineHeight", editorLineHeight.value);
    void save("editorMaxWidth", editorMaxWidth.value);
    void save("editorWidthMode", editorWidthMode.value);
    void save("wheelFontSize", wheelFontSize.value);
    void save("codeLineNumbers", codeLineNumbers.value);
    void save("spellcheck", spellcheck.value);
    void save("editorFont", editorFont.value);
  }

  function setTidyRule(id: TidyRuleId, on: boolean) {
    tidyRules.value = { ...tidyRules.value, [id]: on };
    void save("tidyRules", tidyRules.value);
  }

  function saveAi() {
    void save("aiModels", aiModels.value);
    void save("aiDefaultModel", aiDefaultModel.value);
  }

  /** 添加或修改一个模型（按 id）；列表原来为空时它成为默认模型 */
  function upsertAiModel(entry: AiModelEntry) {
    const i = aiModels.value.findIndex((m) => m.id === entry.id);
    aiModels.value = i < 0 ? [...aiModels.value, entry] : aiModels.value.map((m) => (m.id === entry.id ? entry : m));
    if (!aiModels.value.some((m) => m.id === aiDefaultModel.value)) aiDefaultModel.value = aiModels.value[0]?.id ?? "";
    saveAi();
  }

  /** 删除模型；删的是默认模型时改用列表第一个 */
  function removeAiModel(id: string) {
    aiModels.value = aiModels.value.filter((m) => m.id !== id);
    if (aiDefaultModel.value === id || !aiModels.value.some((m) => m.id === aiDefaultModel.value)) aiDefaultModel.value = aiModels.value[0]?.id ?? "";
    saveAi();
  }

  function setAiDefaultModel(id: string) {
    if (!aiModels.value.some((m) => m.id === id)) return;
    aiDefaultModel.value = id;
    saveAi();
  }

  /** 按 id 找模型；旧的 AI 对话记的是模型名，按名称找第一个 */
  function findModel(ref: string): AiModelEntry | null {
    if (!ref) return null;
    return aiModels.value.find((m) => m.id === ref) ?? aiModels.value.find((m) => m.name === ref) ?? null;
  }

  /** 模型的上下文长度与来源；找不到模型时按默认 128K */
  function contextOf(entry: AiModelEntry | null): ModelContext {
    return resolveContext(entry ?? { name: "", context: null, providerContext: null });
  }

  return {
    theme, lastLightTheme, lastDarkTheme, toggleThemeTarget, lastVault, sidebarVisible, toolbarVisible, statusbarVisible, vaults, toolbarHidden, recentCommands,
    openLastVault, restoreTabs, zoom, editorFontSize, editorLineHeight, editorMaxWidth, editorWidthMode, wheelFontSize, codeLineNumbers, spellcheck, editorFont, vaultList, tidyRules, aiModels, aiDefaultModel, defaultModel,
    setShortcut, resetShortcut, resetAllShortcuts, replaceShortcuts,
    toggleToolbarButton, resetToolbarButtons, pushRecentCommand,
    hydrate, vaultUi, patchVaultUi, flushVaultUi, diagramView, patchDiagramView, setTheme, toggleDarkTheme, setLastVault, toggleSidebar, toggleToolbar, toggleStatusbar,
    setOpenLastVault, setRestoreTabs, setZoom, patchEditor, rememberVault, forgetVault, setTidyRule, upsertAiModel, removeAiModel, setAiDefaultModel, findModel, contextOf,
  };
});

function clampNum(value: number, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
