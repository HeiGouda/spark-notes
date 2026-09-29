<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { GitConnectResult } from "../lib/api";
import { isHttpRemote, tokenUrl } from "../lib/gitPrefs";
import { useGitStore } from "../stores/git";
import { useNoticeStore } from "../stores/notice";

const git = useGitStore();
const url = ref("");
const user = ref("");
const token = ref("");
const result = ref<GitConnectResult | null>(null);
const error = ref("");
const loginOpen = ref(false);
const connecting = ref(false);
const idName = ref("");
const idEmail = ref("");
const idMsg = ref("");

const http = computed(() => isHttpRemote(url.value));
const tokenPage = computed(() => tokenUrl(url.value));
const showLogin = computed(() => http.value && (loginOpen.value || !!result.value?.needLogin));
const connected = computed(() => !!result.value && !result.value.needLogin);
const changed = computed(() => url.value.trim() !== (git.remote ?? ""));

function load() {
  url.value = git.remote ?? "";
  user.value = git.credentialUser ?? "";
  token.value = "";
  result.value = null;
  error.value = "";
  loginOpen.value = false;
  idName.value = git.userName;
  idEmail.value = git.userEmail;
  idMsg.value = "";
}

onMounted(load);
watch(() => [git.remote, git.credentialUser], () => {
  if (!connecting.value && !result.value) load();
});
watch(() => [git.userName, git.userEmail], () => {
  idName.value = git.userName;
  idEmail.value = git.userEmail;
});
watch(url, () => {
  result.value = null;
  error.value = "";
});

async function connect() {
  error.value = "";
  if (!url.value.trim()) {
    error.value = "请填写远程仓库地址";
    return;
  }
  if (showLogin.value && !user.value.trim()) {
    error.value = "请填写账号";
    return;
  }
  if (showLogin.value && !token.value && !git.credentialUser) {
    error.value = "请填写访问令牌或密码";
    return;
  }
  connecting.value = true;
  try {
    const login = showLogin.value;
    const r = await git.connect(url.value, login ? user.value : "", login ? token.value : "");
    if (!r) return;
    result.value = r;
    token.value = "";
    if (!r.needLogin) loginOpen.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    connecting.value = false;
  }
}

async function firstSync() {
  const ok = await git.sync();
  if (ok) result.value = null;
}

function openTokenPage() {
  if (tokenPage.value) openUrl(tokenPage.value).catch((e) => useNoticeStore().report("打开网页失败", e));
}

async function saveIdentity() {
  idMsg.value = "";
  const name = idName.value.trim();
  const mail = idEmail.value.trim();
  if (!name || !mail || !mail.includes("@") || /\s/.test(mail)) {
    idMsg.value = "请填写用户名和有效的邮箱";
    return;
  }
  try {
    await git.saveIdentity(name, mail);
    idMsg.value = "已保存";
  } catch (e) {
    idMsg.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <div class="git-setup">
    <label for="git-url">远程仓库地址</label>
    <div class="git-inline">
      <input id="git-url" v-model="url" type="text" spellcheck="false" placeholder="https://github.com/用户名/仓库.git" @keydown.enter.prevent="connect()" />
      <button class="btn-primary" type="button" :disabled="connecting || git.busy" @click="connect()">{{ connecting ? "正在连接…" : changed || !git.remote ? "连接" : "重新连接" }}</button>
    </div>
    <p class="git-hint">
      支持 HTTPS 和 SSH（git@…）地址。{{ git.isRepo ? "" : "连接时会把这个笔记库初始化为 Git 仓库。" }}SSH 地址用这台电脑的 SSH 密钥。
    </p>

    <p v-if="http && git.credentialUser && !showLogin" class="git-hint">
      已保存账号 {{ git.credentialUser }}。<button class="scm-link git-inline-link" type="button" @click="loginOpen = true">更换账号</button>
    </p>

    <template v-if="showLogin">
      <p v-if="result?.rejected" class="inline-err">远程仓库拒绝了这个账号或令牌，请重新填写。</p>
      <p v-else-if="result?.needLogin" class="inline-err">这个仓库需要登录，请填写账号和访问令牌。</p>
      <label for="git-user">账号</label>
      <input id="git-user" v-model="user" type="text" autocomplete="username" spellcheck="false" />
      <label for="git-token">访问令牌（或密码）</label>
      <input id="git-token" v-model="token" type="password" autocomplete="current-password" :placeholder="git.credentialUser ? '留空则沿用已保存的' : ''" @keydown.enter.prevent="connect()" />
      <p class="git-hint">
        GitHub、Gitee、GitLab 已不支持用登录密码推送，请创建一个个人访问令牌。
        <button v-if="tokenPage" class="scm-link git-inline-link" type="button" @click="openTokenPage()">去创建访问令牌</button>
        只保存在这台电脑的系统凭据库里。
      </p>
      <div class="git-actions"><button class="btn-primary" type="button" :disabled="connecting || git.busy" @click="connect()">登录并连接</button></div>
    </template>

    <p v-if="error" class="inline-err">{{ error }}</p>

    <div v-if="connected && result" class="inline-ok git-connected">
      <div>
        <p><strong>已连接。</strong>
          <template v-if="result.remoteEmpty">远程仓库是空的，可以把这台电脑上的笔记推送上去。</template>
          <template v-else-if="result.localCommits">两边都有内容，同步会先拉取再推送，冲突的笔记两份都保留。</template>
          <template v-else>远程仓库里已有笔记，可以拉取到这台电脑。</template>
        </p>
        <button class="btn-primary" type="button" :disabled="git.busy" @click="firstSync()">
          {{ git.busy ? "正在同步…" : result.remoteEmpty ? "推送本地笔记" : result.localCommits ? "开始同步" : "拉取远程笔记" }}
        </button>
      </div>
    </div>

    <details v-if="git.isRepo" class="git-advanced">
      <summary>高级</summary>
      <div class="git-body git-advanced-body">
        <div class="git-sec">提交身份</div>
        <p class="git-hint">已自动生成，只写入这个笔记库，一般不需要修改。</p>
        <label for="git-id-name">用户名</label>
        <input id="git-id-name" v-model="idName" type="text" autocomplete="name" />
        <label for="git-id-mail">邮箱</label>
        <input id="git-id-mail" v-model="idEmail" type="text" autocomplete="email" spellcheck="false" />
        <p v-if="idMsg" :class="idMsg === '已保存' ? 'inline-ok' : 'inline-err'">{{ idMsg }}</p>
        <div class="git-actions">
          <button v-if="git.remote" class="fb-txt" type="button" :disabled="git.busy" @click="git.removeRemote()">移除远程仓库</button>
          <button class="fb-txt" type="button" @click="saveIdentity()">保存提交身份</button>
        </div>
      </div>
    </details>
  </div>
</template>
