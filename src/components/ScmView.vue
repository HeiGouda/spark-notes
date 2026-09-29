<script setup lang="ts">
import { ref } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import Icon from "./Icon.vue";
import { formatGitWhen } from "../lib/gitTime";
import { useGitStore } from "../stores/git";
import { useWebdavStore } from "../stores/webdav";
import { useNoticeStore } from "../stores/notice";
import { useTabsStore } from "../stores/tabs";
import { useVaultStore } from "../stores/vault";
import { AiCancelled, useAiStore, type AiRun } from "../stores/ai";
import { api } from "../lib/api";
import { cleanCommitMessage, commitMessages, diffCharLimit } from "../lib/ai";
import { isMac } from "../lib/platform";

const GIT_DOWNLOAD = isMac ? "https://git-scm.com/download/mac" : "https://git-scm.com/download/win";
const commitKey = isMac ? "Cmd+Enter" : "Ctrl+Enter";

const git = useGitStore();
const webdav = useWebdavStore();
const ai = useAiStore();
const message = ref("");
const changesOpen = ref(true);
const logOpen = ref(true);

/* ---------- AI 生成提交说明（需求文档 5.16） ---------- */
const aiRunning = ref(false);
let aiRun: AiRun | null = null;

async function generateMessage() {
  if (aiRunning.value) {
    aiRun?.cancel();
    return;
  }
  const root = useVaultStore().root;
  if (!root || !ai.ensureConfigured()) return;
  aiRunning.value = true;
  try {
    await useTabsStore().flushAll();
    const d = await api.gitChangeDiff(root, diffCharLimit(ai.defaultBudget()));
    if (!d.files.length) {
      useNoticeStore().inform("没有改动");
      return;
    }
    aiRun = ai.run(commitMessages(d.files, d.diff, d.truncated), (full) => (message.value = cleanCommitMessage(full)));
    message.value = cleanCommitMessage(await aiRun.done);
    if (d.truncated) useNoticeStore().inform("改动较多，AI 只看到了文件列表和每个文件的部分差异");
  } catch (e) {
    if (!(e instanceof AiCancelled)) useNoticeStore().report("生成提交说明失败", e);
  } finally {
    aiRun = null;
    aiRunning.value = false;
  }
}

const letterTitle: Record<string, string> = { M: "已修改", A: "新增", D: "已删除" };

async function submit() {
  if (git.busy || git.lockedReason || !message.value.trim() || !git.changes.length) return;
  const ok = await git.commit(message.value);
  if (ok) message.value = "";
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void submit();
  }
}

function download() {
  openUrl(GIT_DOWNLOAD).catch((e) => useNoticeStore().report("打开下载页失败", e));
}
</script>

<template>
  <div v-if="!git.ready" class="scm">
    <div class="scm-empty"><p>正在读取版本控制状态…</p></div>
  </div>
  <div v-else-if="git.loadError" class="scm">
    <div class="scm-empty">
      <h3>无法读取版本控制状态</h3>
      <p>{{ git.loadError }}</p>
    </div>
  </div>
  <div v-else-if="!git.installed" class="scm">
    <div class="scm-empty">
      <h3>未检测到 Git</h3>
      <p v-if="isMac">在“终端”里运行 <code>xcode-select --install</code> 安装命令行工具（或用 Homebrew 安装 Git），之后重新打开 Spark，就可以使用版本控制。笔记的编辑和搜索不受影响。</p>
      <p v-else>安装 Git for Windows 后重新打开 Spark，就可以使用版本控制。笔记的编辑和搜索不受影响。</p>
      <button class="scm-link" type="button" @click="download">{{ isMac ? "查看 Git 安装方法" : "下载 Git for Windows" }}</button>
    </div>
  </div>
  <div v-else-if="!git.isRepo" class="scm">
    <div class="scm-empty">
      <h3>还不是 Git 仓库</h3>
      <p>初始化后可以在这里提交改动。远程地址、自动提交和提交身份在 Git 设置里填写。</p>
      <button class="scm-btn" type="button" :disabled="git.busy" @click="git.initRepo()">初始化仓库</button>
      <button class="scm-link" type="button" @click="git.openSettings()">Git 设置</button>
    </div>
  </div>
  <div v-else class="scm" :class="{ 'is-locked': git.lockedReason }">
    <div v-if="git.lockedReason" class="scm-banner">{{ git.lockedReason }}</div>
    <div class="scm-head">
      <span class="scm-branch"><Icon name="git" sm />{{ git.branchLabel }}</span>
      <span v-if="git.hasUpstream" class="scm-ahead" :title="`领先远程 ${git.ahead} 个提交、落后 ${git.behind} 个`">↑{{ git.ahead }} ↓{{ git.behind }}</span>
      <span class="scm-flex" />
      <button class="scm-mini" type="button" :title="webdav.mode === 'webdav' ? '当前同步方式是 WebDAV，拉取已暂停' : '拉取（有未提交的改动时先问你保留还是以仓库为准）'" :disabled="git.busy || !!git.lockedReason || !git.remote || webdav.mode === 'webdav'" @click="git.pull()">
        <Icon name="pull" sm />拉取
      </button>
      <button class="scm-mini" type="button" :title="webdav.mode === 'webdav' ? '当前同步方式是 WebDAV，推送已暂停' : (git.remote ? `推送到 origin/${git.branchLabel}` : '请先在 Git 设置里填写远程地址')" :disabled="git.busy || !!git.lockedReason || !git.remote || webdav.mode === 'webdav'" @click="git.push()">
        <Icon name="push" sm />推送
      </button>
    </div>
    <div class="scm-commit">
      <textarea
        v-model="message"
        rows="2"
        :placeholder="`提交说明（${commitKey} 提交）`"
        :disabled="git.busy || !!git.lockedReason"
        @keydown="onKey"
      />
      <button
        class="scm-mini scm-ai"
        type="button"
        :title="aiRunning ? '停止生成' : '把本次改动的差异发给 AI，生成的说明填进上面的输入框'"
        :disabled="!aiRunning && (git.busy || !!git.lockedReason || !git.changes.length)"
        @click="generateMessage"
      >
        <Icon name="sparkle" sm />{{ aiRunning ? "停止生成" : "AI 生成说明" }}
      </button>
      <button class="scm-btn" type="button" :disabled="git.busy || !!git.lockedReason || !message.trim() || !git.changes.length" @click="submit">
        {{ git.changes.length ? `提交全部 ${git.changes.length} 项改动` : "没有改动" }}
      </button>
    </div>
    <div class="scm-scroll">
      <button class="scm-section" type="button" :aria-expanded="changesOpen" @click="changesOpen = !changesOpen"><Icon :name="changesOpen ? 'down' : 'right'" sm />改动<span class="bl-count">{{ git.changes.length }}</span></button>
      <ul v-show="changesOpen" class="scm-list">
        <li v-for="c in git.changes" :key="c.path" class="row">
          <span class="st" :class="`st-${c.letter.toLowerCase()}`" :title="letterTitle[c.letter] ?? '已修改'">{{ c.letter }}</span>
          <span class="name" :class="{ deleted: c.letter === 'D' }">{{ c.name }}</span>
          <span class="scm-dir">{{ c.dir }}</span>
        </li>
      </ul>
      <button class="scm-section" type="button" :aria-expanded="logOpen" @click="logOpen = !logOpen"><Icon :name="logOpen ? 'down' : 'right'" sm />提交记录</button>
      <ul v-show="logOpen" class="scm-log">
        <li v-if="!git.log.length" class="log-empty">还没有提交</li>
        <li v-for="entry in git.log" :key="entry.id">
          <span class="log-dot" :class="{ 'is-local': entry.unpushed }" :title="entry.unpushed ? '尚未推送' : undefined" />
          <div>
            <div class="log-msg">{{ entry.subject }}</div>
            <div class="log-meta">{{ formatGitWhen(entry.time) }}<template v-if="entry.unpushed"> · 尚未推送</template></div>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
