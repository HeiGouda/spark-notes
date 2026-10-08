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
import { useSettingsStore, type EditorWidthMode } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { NEED_VAULT_FOR_SYNC, useVaultStore } from "../stores/vault";
import { TIDY_RULES } from "../editor/tidy";
import { ask } from "@tauri-apps/plugin-dialog";
import AiModelDialog from "./AiModelDialog.vue";
import { presetOf, sameBaseUrl } from "../lib/ai";
import { formatTokens, modelLabel, SOURCE_LABELS, type AiModelEntry } from "../lib/aiModels";
import { shortcutOf } from "../lib/commands";
import { displayShortcut } from "../lib/shortcut";
import { THEMES } from "../lib/themes";
import { credentialStoreName, isMac } from "../lib/platform";
import { DOC_ICON, docKind } from "../lib/doctype";

const ui = useUiStore();
const settings = useSettingsStore();
const git = useGitStore();
const webdav = useWebdavStore();
const vault = useVaultStore();

const SECTIONS = [
  ["general", "通用"],
  ["hidden", "已隐藏"],
  ["look", "外观"],
  ["editor", "编辑器"],
  ["sync", "同步"],
  ["retain", "历史与回收站"],
  ["keys", "快捷键"],
  ["ai", "AI"],
] as const;

function hiddenIcon(path: string): string {
  const n = vault.node(path);
  if (n?.book) return "book";
  return n?.isDir ? "folder" : DOC_ICON[docKind(path) ?? "note"];
}

/* ---------- AI 模型列表（需求文档 5.16） ---------- */
/** 正在添加（null）或编辑的模型；undefined 表示对话框没打开 */
const editingModel = ref<AiModelEntry | null | undefined>(undefined);
const aiError = ref("");

async function removeModel(m: AiModelEntry) {
  const ok = await ask(`确定删除模型“${modelLabel(m)}”吗？`, { title: "删除模型", kind: "warning", okLabel: "删除", cancelLabel: "取消" });
  if (!ok) return;
  aiError.value = "";
  settings.removeAiModel(m.id);
  // 这个接口地址已没有模型使用时，一并清除它的 API Key
  if (!settings.aiModels.some((x) => sameBaseUrl(x.baseUrl, m.baseUrl))) {
    try {
      await api.aiClearKey(m.baseUrl);
    } catch (e) {
      aiError.value = `模型已删除，但清除 API Key 失败：${messageOf(e)}`;
    }
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
  aiError.value = "";
  editingModel.value = undefined;
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
  // 添加 / 编辑模型的对话框开着时，Esc 只关它
  if (!ui.settingsOpen || e.key !== "Escape" || ui.recording || editingModel.value !== undefined) return;
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
          <div v-else-if="ui.settingsSection === 'hidden'" class="retain">
            <p v-if="!vault.root" class="git-hint retain-none">未打开笔记库</p>
            <div v-else class="tl">
              <div class="tl-bar">
                <span class="tl-count">{{ vault.hidden.length ? `共 ${vault.hidden.length} 项` : "" }}</span>
                <button class="fb-txt" type="button" :disabled="!vault.hidden.length" @click="vault.unhideAll()">全部恢复</button>
              </div>
              <div v-if="!vault.hidden.length" class="tl-empty">
                <p>没有隐藏的文件或文件夹</p>
                <p class="git-hint">在文件树里右键文件或文件夹，选择“隐藏”。隐藏只影响文件树，搜索和链接照常可用。</p>
              </div>
              <ul v-else class="tl-list">
                <li v-for="p in vault.hidden" :key="p" class="tl-row">
                  <Icon :name="hiddenIcon(p)" sm />
                  <div class="tl-main" :title="p">
                    <div class="log-msg">{{ p }}</div>
                  </div>
                  <div class="tl-acts">
                    <button class="fb-txt" type="button" @click="vault.unhide(p)">恢复</button>
                  </div>
                </li>
              </ul>
            </div>
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
            <label class="git-check"><input type="checkbox" :checked="settings.wheelFontSize" @change="settings.patchEditor({ wheelFontSize: ($event.target as HTMLInputElement).checked })" />{{ isMac ? "Cmd" : "Ctrl" }}+滚轮调整字号</label>
            <div class="git-row">行高 <input class="git-num" type="text" :value="settings.editorLineHeight" @change="settings.patchEditor({ editorLineHeight: Number(($event.target as HTMLInputElement).value) })" /></div>
            <div class="git-row">正文宽度
              <select class="set-select" aria-label="正文宽度" :value="settings.editorWidthMode" @change="settings.patchEditor({ editorWidthMode: ($event.target as HTMLSelectElement).value as EditorWidthMode })">
                <option value="fixed">固定</option>
                <option value="fill">自适应</option>
              </select>
              <input class="git-num" type="text" aria-label="正文宽度像素" :disabled="settings.editorWidthMode === 'fill'" :value="settings.editorMaxWidth" @change="settings.patchEditor({ editorMaxWidth: Number(($event.target as HTMLInputElement).value) })" /> 像素
            </div>
            <label class="git-check"><input type="checkbox" :checked="settings.codeLineNumbers" @change="settings.patchEditor({ codeLineNumbers: ($event.target as HTMLInputElement).checked })" />代码块显示行号</label>
            <label class="git-check"><input type="checkbox" :checked="settings.spellcheck" @change="settings.patchEditor({ spellcheck: ($event.target as HTMLInputElement).checked })" />拼写检查</label>
            <p class="git-hint">字号 13–24，行高 1.4–2.2，宽度 560–1200。超出范围时会改回默认值。自适应时正文铺满编辑区。</p>
            <div class="git-sec">一键整理（{{ tidyKey }}）</div>
            <p class="git-hint">有选中文字时只整理选中部分。代码、链接地址和 Front Matter 不会改动，整理后可以撤销。</p>
            <label v-for="r in TIDY_RULES" :key="r.id" class="git-check">
              <input type="checkbox" :checked="settings.tidyRules[r.id]" @change="settings.setTidyRule(r.id, ($event.target as HTMLInputElement).checked)" />{{ r.title }}<span v-if="r.hint" class="hint">{{ r.hint }}</span>
            </label>
          </div>
          <form v-else-if="ui.settingsSection === 'sync'" class="git-body" @submit.prevent="saveSync">
            <div class="git-sec">同步方式</div>
            <p v-if="!vault.root" class="git-hint retain-none">{{ NEED_VAULT_FOR_SYNC }}</p>
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
              <button v-if="syncMode === 'webdav'" class="fb-txt" type="button" :disabled="davTesting || !vault.root" @click="testDav()">{{ davTesting ? "正在测试…" : "测试连接" }}</button>
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
            <div class="aim-head">
              <p class="git-hint">只在你点击 AI 功能时才发送内容，后台不会自动发送任何笔记。支持 OpenAI 兼容接口。</p>
              <button class="btn-primary" type="button" @click="editingModel = null"><Icon name="plus" sm />添加模型</button>
            </div>
            <template v-if="settings.aiModels.length">
              <label for="ai-default">默认模型</label>
              <select id="ai-default" class="set-select aim-default" :value="settings.defaultModel?.id" @change="settings.setAiDefaultModel(($event.target as HTMLSelectElement).value)">
                <option v-for="m in settings.aiModels" :key="m.id" :value="m.id">{{ modelLabel(m) }}（{{ presetOf(m.provider).label }}）</option>
              </select>
              <p class="git-hint">AI 指令、总结、整理结构、提交说明、生成思维导图和流程图都用默认模型；AI 对话里可以临时切换。</p>
              <div class="git-sec">已添加的模型</div>
              <div class="aim-table" role="table">
                <div class="aim-row aim-th" role="row"><span>名称</span><span>服务商</span><span>模型</span><span>上下文</span><span /></div>
                <div v-for="m in settings.aiModels" :key="m.id" class="aim-row" role="row">
                  <span class="aim-label" :title="modelLabel(m)">{{ modelLabel(m) }}<em v-if="m.id === settings.defaultModel?.id" class="mt-def">默认</em></span>
                  <span class="aim-cell" :title="m.baseUrl">{{ presetOf(m.provider).label }}</span>
                  <span class="aim-cell aim-code" :title="m.name">{{ m.name }}</span>
                  <span class="mt-src" :class="{ 'mt-unknown': settings.contextOf(m).source === 'default' }">{{ formatTokens(settings.contextOf(m).tokens) }} · {{ SOURCE_LABELS[settings.contextOf(m).source] }}</span>
                  <span class="aim-acts">
                    <button class="scm-link" type="button" @click="editingModel = m">编辑</button>
                    <button class="scm-link is-danger" type="button" @click="removeModel(m)">删除</button>
                  </span>
                </div>
              </div>
              <p class="git-hint">上下文长度：手动填写 &gt; 服务商返回 &gt; 内置表 &gt; 128K。API Key 按接口地址保存在{{ credentialStoreName }}里，同一地址的模型共用。发送图片需要支持识图的模型。</p>
            </template>
            <div v-else class="aim-empty">
              <p>还没有添加模型</p>
              <button class="fb-txt" type="button" @click="editingModel = null">添加第一个模型</button>
            </div>
            <p v-if="aiError" class="git-error">{{ aiError }}</p>
          </div>
        </div>
      </div>
    </div>
    <AiModelDialog v-if="editingModel !== undefined" :model="editingModel" @close="editingModel = undefined" />
  </div>
</template>
