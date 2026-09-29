<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import KeysDialog from "./KeysDialog.vue";
import TrashList from "./TrashList.vue";
import { api } from "../lib/api";
import GitRemoteSetup from "./GitRemoteSetup.vue";
import type { SyncDirection } from "../lib/api";
import { firstStep, serializeSyncConfig, useWebdavStore, type SyncMode } from "../stores/webdav";
import { useGitStore } from "../stores/git";
import { useNoticeStore } from "../stores/notice";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { useVaultStore } from "../stores/vault";
import { TIDY_RULES } from "../editor/tidy";
import { AI_PRESETS, type AiPresetId } from "../lib/ai";
import { useAiStore } from "../stores/ai";
import { resolveContext, SOURCE_LABELS, type AiModelEntry } from "../lib/aiModels";
import { shortcutOf } from "../lib/commands";
import { displayShortcut } from "../lib/shortcut";
import { THEMES } from "../lib/themes";
import { credentialStoreName } from "../lib/platform";

const ui = useUiStore();
const settings = useSettingsStore();
const git = useGitStore();
const webdav = useWebdavStore();
const vault = useVaultStore();

const SECTIONS = [
  ["general", "通用"],
  ["look", "外观"],
  ["editor", "编辑器"],
  ["sync", "同步"],
  ["retain", "历史与回收站"],
  ["keys", "快捷键"],
  ["ai", "AI"],
] as const;

const ai = useAiStore();
const aiKey = ref("");
const editingKey = ref(false);
const aiTesting = ref(false);
const aiOk = ref("");
const aiError = ref("");

async function saveAiKey() {
  aiError.value = "";
  try {
    await api.aiSaveKey(aiKey.value);
    aiKey.value = "";
    editingKey.value = false;
    await ai.refreshKey();
  } catch (e) {
    aiError.value = e instanceof Error ? e.message : String(e);
  }
}

async function clearAiKey() {
  aiError.value = "";
  try {
    await api.aiClearKey();
    await ai.refreshKey();
  } catch (e) {
    aiError.value = e instanceof Error ? e.message : String(e);
  }
}

/* ---------- 模型列表（需求文档 5.16） ---------- */
const modelRows = ref<AiModelEntry[]>([]);
const aiReading = ref(false);

function copyModels() {
  modelRows.value = settings.aiModels.map((m) => ({ ...m }));
  if (!modelRows.value.length) modelRows.value.push({ name: "", context: null });
}

function commitModels() {
  settings.setAiModels(modelRows.value.filter((m) => m.name));
}

function editModel(i: number, patch: Partial<AiModelEntry>) {
  modelRows.value[i] = { ...modelRows.value[i], ...patch };
  commitModels();
}

function addModel() {
  modelRows.value.push({ name: "", context: null });
}

function removeModel(i: number) {
  modelRows.value.splice(i, 1);
  commitModels();
  if (!modelRows.value.length) addModel();
}

function parseTokens(raw: string): number | null {
  const n = Number(raw.replace(/[,，\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** 不算手动填写时的上下文长度，作为输入框的占位提示 */
function autoContext(row: AiModelEntry): number {
  return resolveContext({ name: row.name, context: null }, settings.aiProviderContexts).tokens;
}

function sourceOf(row: AiModelEntry) {
  return resolveContext(row, settings.aiProviderContexts).source;
}

async function readProviderModels() {
  aiError.value = "";
  aiOk.value = "";
  aiReading.value = true;
  try {
    const list = await api.aiListModels(settings.aiBaseUrl);
    const map: Record<string, number> = {};
    for (const m of list) if (m.context) map[m.id] = m.context;
    settings.setAiProviderContexts(map);
    const count = Object.keys(map).length;
    if (!count) aiError.value = `服务商返回了 ${list.length} 个模型，但没有给出上下文长度，可以手动填写`;
    else aiOk.value = `已读取 ${count} 个模型的上下文长度`;
  } catch (e) {
    aiError.value = e instanceof Error ? e.message : String(e);
  } finally {
    aiReading.value = false;
  }
}

async function testAi() {
  aiError.value = "";
  aiOk.value = "";
  aiTesting.value = true;
  try {
    const ms = await api.aiTest(settings.aiBaseUrl, settings.aiModel);
    aiOk.value = `连接成功，${(ms / 1000).toFixed(1)} 秒内收到回复`;
  } catch (e) {
    aiError.value = e instanceof Error ? e.message : String(e);
  } finally {
    aiTesting.value = false;
  }
}

const tidyKey = computed(() => displayShortcut(shortcutOf("format.tidy")) || "无快捷键");
const auto = ref(false);
const minutes = ref("5");
const historyDays = ref("30");
const trashDays = ref("30");
const trashList = ref<InstanceType<typeof TrashList> | null>(null);
const error = ref("");
/** 就地显示的成功结果 */
const done = ref("");
const syncMode = ref<SyncMode>("off");
const davUrl = ref("");
const davUser = ref("");
const davDir = ref("");
const davPassword = ref("");
const davAutoUpload = ref(false);
const davCheckOnOpen = ref(true);
const davTesting = ref(false);
const hasPassword = ref(false);
const firstHint = ref<SyncDirection | "choose" | null>(null);

function copyGit() {
  auto.value = git.autoCommit;
  minutes.value = String(git.autoCommitMinutes);
  error.value = "";
  done.value = "";
}

async function loadRetention() {
  if (!vault.root) return;
  try {
    const raw = await api.readConfig(vault.root, "retention.json");
    const v = raw ? JSON.parse(raw) as { historyDays?: number; trashDays?: number } : {};
    historyDays.value = String(v.historyDays ?? 30);
    trashDays.value = String(v.trashDays ?? 30);
  } catch {
    historyDays.value = "30";
    trashDays.value = "30";
  }
}

function copyDav() {
  syncMode.value = !webdav.configured && git.isRepo ? "git" : webdav.mode;
  davUrl.value = webdav.url;
  davUser.value = webdav.username;
  davDir.value = webdav.remoteDir;
  davAutoUpload.value = webdav.autoUpload;
  davCheckOnOpen.value = webdav.checkOnOpen;
  davPassword.value = "";
  hasPassword.value = webdav.hasPassword;
  firstHint.value = null;
}

watch(() => ui.settingsOpen, (open) => {
  if (!open) return;
  copyGit();
  copyDav();
  void loadRetention();
  aiOk.value = "";
  aiError.value = "";
  editingKey.value = false;
  copyModels();
  void ai.refreshKey();
});

function close() {
  ui.settingsOpen = false;
}

function daysOk(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 3650) return null;
  return n;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function saveSync() {
  error.value = "";
  done.value = "";
  firstHint.value = null;
  const root = vault.root;
  if (!root) return;
  if (syncMode.value === "webdav" && (!davUrl.value.trim() || !davUser.value.trim())) {
    error.value = "请填写 WebDAV 地址和用户名";
    return;
  }
  if (syncMode.value === "webdav" && !davPassword.value && !hasPassword.value) {
    error.value = "请填写 WebDAV 密码";
    return;
  }
  const n = Number(minutes.value);
  if (syncMode.value === "git" && (!Number.isInteger(n) || n < 1 || n > 240)) {
    error.value = "自动提交的等待时长请填写 1 到 240 的整数";
    return;
  }
  const cfg = {
    mode: syncMode.value,
    url: davUrl.value,
    username: davUser.value,
    remoteDir: davDir.value,
    autoUpload: davAutoUpload.value,
    checkOnOpen: davCheckOnOpen.value,
  };
  try {
    if (syncMode.value === "git") await git.saveSettings({ autoCommit: auto.value, minutes: n });
    if (davPassword.value) {
      await api.webdavSavePassword(root, davPassword.value);
      davPassword.value = "";
      hasPassword.value = true;
    }
    await api.writeConfig(root, "sync.json", serializeSyncConfig(cfg));
    webdav.applyConfig(cfg);
    webdav.hasPassword = hasPassword.value;
    done.value = "已保存同步设置";
  } catch (e) {
    error.value = messageOf(e);
    return;
  }
  if (syncMode.value !== "webdav") return;
  const p = await webdav.check();
  if (p) {
    firstHint.value = firstStep(p);
    if (!firstHint.value) done.value = webdav.downloadCount ? `已保存。云端有 ${webdav.downloadCount} 个更新，可以从云端同步。` : "已保存，已连接云端。";
  } else if (webdav.failed) {
    done.value = "";
    error.value = `已保存，但连接云端失败：${webdav.failed}`;
  }
}

async function testDav() {
  error.value = "";
  done.value = "";
  if (!vault.root) return;
  davTesting.value = true;
  try {
    const info = await api.webdavTest(vault.root, davUrl.value.trim(), davDir.value.trim(), davUser.value.trim(), davPassword.value);
    done.value = info.missing
      ? "连接成功。远程目录还不存在，第一次上传时会自动创建。"
      : `连接成功，云端目录里有 ${info.notes} 篇笔记（共 ${info.files} 个文件）。`;
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    davTesting.value = false;
  }
}

function startFirst(direction: SyncDirection) {
  firstHint.value = null;
  void webdav.start(direction);
}

async function saveRetention() {
  error.value = "";
  const history = daysOk(historyDays.value);
  const trash = daysOk(trashDays.value);
  if (history === null || trash === null) {
    error.value = "保留天数请填写 0 到 3650 的整数，0 表示不自动清理";
    return;
  }
  if (!vault.root) return;
  try {
    await api.writeConfig(vault.root, "retention.json", JSON.stringify({ historyDays: history, trashDays: trash }, null, 2) + "\n");
    await api.retainPrune(vault.root);
    await trashList.value?.load();
    useNoticeStore().inform("已保存保留天数");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function onKey(e: KeyboardEvent) {
  if (!ui.settingsOpen || e.key !== "Escape" || ui.recording) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  close();
}

onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div v-if="ui.settingsOpen" class="mask" @mousedown.self="close()">
    <div class="pop settings" role="dialog" aria-label="设置">
      <div class="keys-head">
        <h3>设置</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="close()"><Icon name="close" sm /></button>
      </div>
      <div class="settings-body">
        <nav class="settings-nav">
          <button v-for="[id, label] in SECTIONS" :key="id" type="button" class="settings-tab" :class="{ on: ui.settingsSection === id }" @click="ui.settingsSection = id">{{ label }}</button>
        </nav>
        <div class="settings-main">
          <div v-if="ui.settingsSection === 'general'" class="git-body">
            <label class="git-check"><input type="checkbox" :checked="settings.openLastVault" @change="settings.setOpenLastVault(($event.target as HTMLInputElement).checked)" />启动时打开上次的笔记库</label>
            <label class="git-check"><input type="checkbox" :checked="settings.restoreTabs" @change="settings.setRestoreTabs(($event.target as HTMLInputElement).checked)" />恢复上次打开的标签页</label>
          </div>
          <div v-else-if="ui.settingsSection === 'look'" class="git-body">
            <div class="git-sec">主题</div>
            <template v-for="(t, i) in THEMES" :key="t.id">
              <div v-if="t.dark && !THEMES[i - 1].dark" class="theme-sep" />
              <label class="git-check"><input type="radio" name="theme" :checked="settings.theme === t.id" @change="settings.setTheme(t.id)" /><span class="sw" :class="`sw-${t.id}`" />{{ t.name }}</label>
            </template>
            <p class="git-hint">标题栏的月亮 / 太阳按钮在上次使用的浅色主题和深色主题之间切换。</p>
            <div class="git-sec">界面</div>
            <label class="git-check"><input type="checkbox" :checked="settings.sidebarVisible" @change="settings.toggleSidebar()" />显示侧栏</label>
            <label class="git-check"><input type="checkbox" :checked="settings.toolbarVisible" @change="settings.toggleToolbar()" />显示格式工具栏</label>
            <label class="git-check"><input type="checkbox" :checked="settings.statusbarVisible" @change="settings.toggleStatusbar()" />显示状态栏</label>
            <div class="git-row">界面缩放
              <select class="set-select" :value="settings.zoom" @change="settings.setZoom(Number(($event.target as HTMLSelectElement).value))">
                <option v-for="n in [80, 90, 100, 110, 125, 150]" :key="n" :value="n">{{ n }}%</option>
              </select>
            </div>
          </div>
          <div v-else-if="ui.settingsSection === 'editor'" class="git-body">
            <div class="git-row">字体
              <select class="set-select" :value="settings.editorFont" @change="settings.patchEditor({ editorFont: ($event.target as HTMLSelectElement).value })">
                <option value="">系统默认</option>
                <option value="yahei">微软雅黑</option>
                <option value="song">宋体</option>
                <option value="kai">楷体</option>
              </select>
            </div>
            <div class="git-row">字号 <input class="git-num" type="text" :value="settings.editorFontSize" @change="settings.patchEditor({ editorFontSize: Number(($event.target as HTMLInputElement).value) })" /> 像素</div>
            <div class="git-row">行高 <input class="git-num" type="text" :value="settings.editorLineHeight" @change="settings.patchEditor({ editorLineHeight: Number(($event.target as HTMLInputElement).value) })" /></div>
            <div class="git-row">正文最大宽度 <input class="git-num" type="text" :value="settings.editorMaxWidth" @change="settings.patchEditor({ editorMaxWidth: Number(($event.target as HTMLInputElement).value) })" /> 像素</div>
            <label class="git-check"><input type="checkbox" :checked="settings.codeLineNumbers" @change="settings.patchEditor({ codeLineNumbers: ($event.target as HTMLInputElement).checked })" />代码块显示行号</label>
            <label class="git-check"><input type="checkbox" :checked="settings.spellcheck" @change="settings.patchEditor({ spellcheck: ($event.target as HTMLInputElement).checked })" />拼写检查</label>
            <p class="git-hint">字号 13–24，行高 1.4–2.2，宽度 560–1200。超出范围时会改回默认值。</p>
            <div class="git-sec">一键整理（{{ tidyKey }}）</div>
            <p class="git-hint">有选中文字时只整理选中部分。代码、链接地址和 Front Matter 不会改动，整理后可以撤销。</p>
            <label v-for="r in TIDY_RULES" :key="r.id" class="git-check">
              <input type="checkbox" :checked="settings.tidyRules[r.id]" @change="settings.setTidyRule(r.id, ($event.target as HTMLInputElement).checked)" />{{ r.title }}<span v-if="r.hint" class="hint">{{ r.hint }}</span>
            </label>
          </div>
          <form v-else-if="ui.settingsSection === 'sync'" class="git-body" @submit.prevent="saveSync">
            <div class="git-sec">同步方式</div>
            <label class="git-check"><input v-model="syncMode" type="radio" value="off" />不同步</label>
            <label class="git-check"><input v-model="syncMode" type="radio" value="webdav" />WebDAV</label>
            <label class="git-check"><input v-model="syncMode" type="radio" value="git" />Git</label>
            <p class="git-hint">每个笔记库只能选一种。本地 Git 提交在选了 WebDAV 时仍然可用，但不会拉取或推送。</p>
            <template v-if="syncMode === 'webdav'">
              <label for="dav-url">地址</label>
              <input id="dav-url" v-model="davUrl" type="text" spellcheck="false" placeholder="https://dav.example.com/dav/" />
              <label for="dav-dir">远端目录</label>
              <input id="dav-dir" v-model="davDir" type="text" spellcheck="false" placeholder="可选，例如 我的笔记" />
              <label for="dav-user">用户名</label>
              <input id="dav-user" v-model="davUser" type="text" spellcheck="false" />
              <label for="dav-pass">密码</label>
              <input id="dav-pass" v-model="davPassword" type="password" :placeholder="hasPassword ? '已保存，留空则不修改' : '应用专用密码'" />
              <p class="git-hint">密码只保存在这台电脑的系统凭据库里，不会写进笔记或同步出去。</p>
              <div class="git-sec">什么时候同步</div>
              <p class="git-hint">云端是正本。点标题栏的同步图标选择“上传本地改动”或“从云端同步”；会覆盖或删除文件时，先列出清单让你确认。</p>
              <label class="git-check"><input v-model="davCheckOnOpen" type="checkbox" />打开笔记库时检查云端更新（只读取文件列表，不下载）</label>
              <label class="git-check"><input v-model="davAutoUpload" type="checkbox" />停止编辑 1 分钟后自动上传</label>
              <p class="git-hint">自动上传只处理新增和修改；需要覆盖云端或删除时，等你在同步菜单里确认。程序不会自动改动本地文件。</p>
            </template>
            <template v-else-if="syncMode === 'git'">
              <GitRemoteSetup />
              <div class="git-sec">自动提交</div>
              <label class="git-check"><input v-model="auto" type="checkbox" />停止编辑后自动提交</label>
              <div class="git-row">等待 <input v-model="minutes" class="git-num" type="text" inputmode="numeric" aria-label="等待分钟" /> 分钟</div>
            </template>
            <p v-if="error" class="inline-err">{{ error }}</p>
            <p v-else-if="done" class="inline-ok">{{ done }}</p>
            <div v-if="firstHint" class="inline-ok">
              <div>
                <p v-if="firstHint === 'upload'">已保存。云端还是空的，把这台电脑上的笔记上传上去吗？</p>
                <p v-else-if="firstHint === 'download'">已保存。云端已有笔记，这台电脑是空的，从云端同步下来吗？</p>
                <p v-else>已保存。本地和云端都有文件，请选择以哪边为准。执行前会列出要改动的文件。</p>
                <div class="git-actions plan-first">
                  <button v-if="firstHint !== 'download'" class="btn-primary" type="button" @click="startFirst('upload')">{{ firstHint === "choose" ? "以本地为准（上传）" : "上传本地笔记" }}</button>
                  <button v-if="firstHint !== 'upload'" class="btn-primary" type="button" @click="startFirst('download')">{{ firstHint === "choose" ? "以云端为准（同步）" : "从云端同步" }}</button>
                </div>
              </div>
            </div>
            <div class="git-actions">
              <button v-if="syncMode === 'webdav'" class="fb-txt" type="button" :disabled="davTesting" @click="testDav()">{{ davTesting ? "正在测试…" : "测试连接" }}</button>
              <button class="btn-primary" type="submit" :disabled="!vault.root || webdav.busy === 'check'">{{ syncMode === "git" ? "保存自动提交设置" : "保存" }}</button>
            </div>
          </form>
          <div v-else-if="ui.settingsSection === 'retain'" class="retain">
            <form class="retain-form" @submit.prevent="saveRetention">
              <div class="git-sec">保留设置</div>
              <div class="git-row">
                历史版本保留 <input v-model="historyDays" class="git-num" type="text" inputmode="numeric" aria-label="历史版本保留天数" /> 天
                <span class="retain-gap" />
                回收站保留 <input v-model="trashDays" class="git-num" type="text" inputmode="numeric" aria-label="回收站保留天数" /> 天
              </div>
              <div class="retain-foot">
                <p class="git-hint">填 0 表示不自动清理。历史版本和回收站都只留在这台电脑上。</p>
                <button class="btn-primary" type="submit" :disabled="!vault.root">保存</button>
              </div>
              <p v-if="error" class="git-error">{{ error }}</p>
            </form>
            <div class="git-sec retain-sec">回收站</div>
            <TrashList v-if="vault.root" ref="trashList" />
            <p v-else class="git-hint retain-none">打开笔记库后可以查看回收站。</p>
          </div>
          <KeysDialog v-else-if="ui.settingsSection === 'keys'" embedded />
          <div v-else-if="ui.settingsSection === 'ai'" class="git-body">
            <p class="git-hint">只在你点击 AI 功能时才发送内容，后台不会自动发送任何笔记。支持所有 OpenAI 兼容接口。</p>
            <div class="git-sec">服务商</div>
            <select class="set-select" aria-label="服务商预设" :value="settings.aiPreset" @change="settings.setAiPreset(($event.target as HTMLSelectElement).value as AiPresetId)">
              <option v-for="p in AI_PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
            <p class="git-hint">预设只负责填好接口地址，可以再修改。</p>
            <label for="ai-url">接口地址</label>
            <input id="ai-url" type="text" spellcheck="false" placeholder="https://…/v1" :value="settings.aiBaseUrl" @change="settings.setAiBaseUrl(($event.target as HTMLInputElement).value)" />
            <label for="ai-key">API Key</label>
            <div v-if="ai.hasKey && !editingKey" class="api-key-row">
              <Icon name="key" sm /><span class="flex">已保存到{{ credentialStoreName }}</span>
              <button class="scm-link" type="button" @click="editingKey = true">修改</button>
              <button class="scm-link" type="button" @click="clearAiKey()">清除</button>
            </div>
            <form v-else class="key-edit" @submit.prevent="saveAiKey">
              <input id="ai-key" v-model="aiKey" type="password" autocomplete="off" placeholder="本机模型（Ollama、LM Studio）可以不填" />
              <button class="fb-txt" type="submit" :disabled="!aiKey.trim()">保存</button>
              <button v-if="ai.hasKey" class="fb-txt" type="button" @click="editingKey = false">取消</button>
            </form>
            <p class="git-hint">API Key 只保存在这台电脑的系统凭据库里，不写入任何配置文件。</p>
            <label>模型</label>
            <div class="model-table">
              <div class="mt-row mt-head"><span>模型名</span><span>上下文（tokens）</span><span>来源</span><span /></div>
              <div v-for="(row, i) in modelRows" :key="i" class="mt-row">
                <input type="text" spellcheck="false" placeholder="例如 deepseek-chat" :value="row.name" aria-label="模型名" @change="editModel(i, { name: ($event.target as HTMLInputElement).value.trim() })" />
                <input type="text" inputmode="numeric" :placeholder="autoContext(row).toLocaleString('zh-CN')" :value="row.context ? row.context.toLocaleString('zh-CN') : ''" aria-label="上下文长度" @change="editModel(i, { context: parseTokens(($event.target as HTMLInputElement).value) })" />
                <span class="mt-src" :class="{ 'mt-unknown': sourceOf(row) === 'default' }">{{ SOURCE_LABELS[sourceOf(row)] }}<em v-if="i === 0" class="mt-def">默认</em></span>
                <button class="btn" type="button" title="移除" @click="removeModel(i)"><Icon name="close" sm /></button>
              </div>
            </div>
            <div class="mt-actions">
              <button class="fb-txt" type="button" @click="addModel()">添加模型</button>
              <button class="fb-txt" type="button" :disabled="aiReading" title="从服务商的模型列表接口读取上下文长度（部分服务商支持）" @click="readProviderModels()">{{ aiReading ? "正在读取…" : "从服务商读取" }}</button>
            </div>
            <p class="git-hint">第一个是默认模型，AI 指令、总结、整理结构、提交说明都用它；AI 对话里可以临时切换。上下文长度留空时依次使用服务商返回的值、内置表，都没有时按 128K；手动填写的值优先。发送图片需要支持识图的模型。</p>
            <div class="test-row">
              <button class="fb-txt" type="button" :disabled="aiTesting" @click="testAi()">{{ aiTesting ? "正在测试…" : "测试连接" }}</button>
              <span v-if="aiOk" class="test-ok"><Icon name="check" sm />{{ aiOk }}</span>
            </div>
            <p v-if="aiError" class="git-error">{{ aiError }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
