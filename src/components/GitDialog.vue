<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import GitRemoteSetup from "./GitRemoteSetup.vue";
import { clampMinutes } from "../lib/gitPrefs";
import { useGitStore } from "../stores/git";

const git = useGitStore();
const auto = ref(false);
const minutes = ref("5");
const error = ref("");
const saved = ref(false);
const idName = ref("");
const idEmail = ref("");
const idError = ref("");
const loginUser = ref("");
const loginPassword = ref("");
const loginError = ref("");

const choiceGroups = computed(() =>
  [
    { letter: "D", label: "本地删除了" },
    { letter: "M", label: "本地修改了" },
    { letter: "A", label: "本地新建了" },
  ]
    .map((g) => ({ ...g, items: git.changes.filter((c) => (c.letter === "A" || c.letter === "D" ? c.letter : "M") === g.letter).map((c) => c.path) }))
    .concat([{ letter: "P", label: "已提交但还没推送的删除", items: git.choiceFiles }])
    .filter((g) => g.items.length),
);

watch(() => git.settingsOpen, (open) => {
  if (!open) return;
  auto.value = git.autoCommit;
  minutes.value = String(git.autoCommitMinutes);
  error.value = "";
  saved.value = false;
});

watch(() => git.identityOpen, (open) => {
  if (!open) return;
  idName.value = git.userName;
  idEmail.value = git.userEmail;
  idError.value = "";
});

watch(() => git.credentialsOpen, (open) => {
  if (!open) return;
  loginUser.value = git.credentialUser ?? "";
  loginPassword.value = "";
  loginError.value = "";
});

function closeSettings() {
  git.settingsOpen = false;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function saveSettings() {
  error.value = "";
  saved.value = false;
  const n = Number(minutes.value);
  if (!Number.isFinite(n) || Math.round(n) !== n || n < 1 || n > 240) {
    error.value = "等待时长请填写 1 到 240 的整数";
    return;
  }
  try {
    await git.saveSettings({ autoCommit: auto.value, minutes: clampMinutes(n) });
    saved.value = true;
  } catch (e) {
    error.value = messageOf(e);
  }
}

async function saveLogin() {
  loginError.value = "";
  const user = loginUser.value.trim();
  if (!user) {
    loginError.value = "请填写账号";
    return;
  }
  if (!loginPassword.value && !git.credentialUser) {
    loginError.value = "请填写密码或访问令牌";
    return;
  }
  try {
    await git.submitCredentials(user, loginPassword.value);
  } catch (e) {
    loginError.value = messageOf(e);
  }
}

async function saveIdentity() {
  idError.value = "";
  const who = idName.value.trim();
  const mail = idEmail.value.trim();
  if (!who || !mail) {
    idError.value = "请填写用户名和邮箱";
    return;
  }
  if (!mail.includes("@") || /\s/.test(mail)) {
    idError.value = "邮箱格式不正确";
    return;
  }
  try {
    await git.submitIdentity(who, mail);
  } catch (e) {
    idError.value = messageOf(e);
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || (!git.choiceOpen && !git.identityOpen && !git.credentialsOpen && !git.settingsOpen)) return;
  e.preventDefault();
  e.stopPropagation();
  if (git.choiceOpen) git.cancelChoice();
  else if (git.identityOpen) git.cancelIdentity();
  else if (git.credentialsOpen) git.cancelCredentials();
  else closeSettings();
  e.stopImmediatePropagation();
}

onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div v-if="git.choiceOpen" class="mask mask-top" @mousedown.self="git.cancelChoice()">
    <div class="pop plan" role="dialog" aria-label="拉取前的未提交改动">
      <div class="keys-head">
        <h3>本地的改动和仓库不一致</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="git.cancelChoice()"><Icon name="close" sm /></button>
      </div>
      <div class="plan-body">
        <p class="git-hint">拉取之前，要先决定这些本地改动怎么处理：</p>
        <section v-for="g in choiceGroups" :key="g.letter" class="plan-group" :class="{ 'is-risky': g.letter === 'D' || g.letter === 'P' }">
          <div class="plan-head">{{ g.label }}<span class="bl-count">{{ g.items.length }}</span></div>
          <ul class="plan-list">
            <li v-for="p in g.items" :key="p">{{ p }}</li>
          </ul>
        </section>
        <div class="choice-row">
          <button class="btn-primary" type="button" @click="git.resolveChoice('discard')">以仓库为准</button>
          <p class="git-hint">放弃本地改动（包括还没推送的提交），和远程仓库保持一致：删掉的恢复回来，改过的笔记恢复成仓库版本（当前内容存为历史版本），仓库里没有的文件移进回收站。</p>
        </div>
        <div class="choice-row">
          <button class="fb-txt" type="button" @click="git.resolveChoice('keep')">保留本地改动并合并</button>
          <p class="git-hint">先把这些改动提交，再和仓库合并。删掉的笔记在仓库里也会被删除（推送后生效）。</p>
        </div>
      </div>
      <div class="git-actions plan-actions">
        <button class="fb-txt" type="button" @click="git.cancelChoice()">取消</button>
      </div>
    </div>
  </div>
  <div v-else-if="git.identityOpen" class="mask mask-top" @mousedown.self="git.cancelIdentity()">
    <div class="pop whoami" role="dialog" aria-label="填写提交身份">
      <div class="keys-head">
        <h3>填写提交身份</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="git.cancelIdentity()"><Icon name="close" sm /></button>
      </div>
      <form class="git-body" @submit.prevent="saveIdentity">
        <p class="git-hint">这次提交需要用户名和邮箱。只会写入这个笔记库，不会改全局 Git 配置。</p>
        <label for="who-name">用户名</label>
        <input id="who-name" v-model="idName" type="text" autocomplete="name" />
        <label for="who-mail">邮箱</label>
        <input id="who-mail" v-model="idEmail" type="text" autocomplete="email" spellcheck="false" />
        <p v-if="idError" class="git-error">{{ idError }}</p>
        <div class="git-actions">
          <button class="fb-txt" type="button" @click="git.cancelIdentity()">取消</button>
          <button class="btn-primary" type="submit">保存并提交</button>
        </div>
      </form>
    </div>
  </div>
  <div v-else-if="git.credentialsOpen" class="mask mask-top" @mousedown.self="git.cancelCredentials()">
    <div class="pop whoami" role="dialog" aria-label="登录远程仓库">
      <div class="keys-head">
        <h3>登录远程仓库</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="git.cancelCredentials()"><Icon name="close" sm /></button>
      </div>
      <form class="git-body" @submit.prevent="saveLogin">
        <p class="git-hint">{{ git.credentialsReason || `${git.remote ?? "远程仓库"} 需要账号和密码。` }}</p>
        <label for="login-user">账号</label>
        <input id="login-user" v-model="loginUser" type="text" autocomplete="username" spellcheck="false" />
        <label for="login-pass">密码或访问令牌</label>
        <input id="login-pass" v-model="loginPassword" type="password" autocomplete="current-password" :placeholder="git.credentialUser ? '留空则沿用已保存的密码' : ''" />
        <p class="git-hint">GitHub、Gitee、GitLab 等请使用个人访问令牌代替登录密码。只保存在这台电脑的系统凭据库里，不会写进笔记或仓库。</p>
        <p v-if="loginError" class="git-error">{{ loginError }}</p>
        <div class="git-actions">
          <button class="fb-txt" type="button" @click="git.cancelCredentials()">取消</button>
          <button class="btn-primary" type="submit">保存并继续</button>
        </div>
      </form>
    </div>
  </div>
  <div v-else-if="git.settingsOpen" class="mask" @mousedown.self="closeSettings()">
    <div class="pop gitset" role="dialog" aria-label="Git 设置">
      <div class="keys-head">
        <h3>Git 设置</h3>
        <button class="btn" type="button" title="关闭 (Esc)" @click="closeSettings()"><Icon name="close" sm /></button>
      </div>
      <form class="git-body" @submit.prevent="saveSettings">
        <div class="git-sec">远程仓库</div>
        <GitRemoteSetup />
        <div class="git-sec">自动提交</div>
        <label class="git-check"><input v-model="auto" type="checkbox" />停止编辑后自动提交</label>
        <div class="git-row">等待 <input v-model="minutes" class="git-num" type="text" inputmode="numeric" aria-label="等待分钟" /> 分钟</div>
        <p class="git-hint">退出时如有未提交改动也会提交。拉取和推送只在点击时进行。</p>
        <p v-if="error" class="inline-err">{{ error }}</p>
        <p v-else-if="saved" class="inline-ok">已保存自动提交设置</p>
        <div class="git-actions"><button class="btn-primary" type="submit" :disabled="git.busy">保存自动提交设置</button></div>
      </form>
    </div>
  </div>
</template>
