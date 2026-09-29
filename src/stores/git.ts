import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { api, type GitAction, type GitChange, type GitConnectResult, type GitLocalChanges, type GitLogEntry } from "../lib/api";
import { parseGitPrefs, serializeGitPrefs, type GitPrefs } from "../lib/gitPrefs";
import { useNoticeStore } from "./notice";
import { useTabsStore } from "./tabs";
import { useVaultStore } from "./vault";
import { useSettingsStore } from "./settings";
import { useUiStore } from "./ui";

export type GitPending = "commit" | "pull" | "push" | "sync";

export const useGitStore = defineStore("git", () => {
  const installed = ref(true);
  const isRepo = ref(false);
  const branch = ref<string | null>(null);
  const detached = ref(false);
  const ahead = ref(0);
  const behind = ref(0);
  const hasUpstream = ref(false);
  const remote = ref<string | null>(null);
  const userName = ref("");
  const userEmail = ref("");
  const credentialUser = ref<string | null>(null);
  const lockedReason = ref<string | null>(null);
  const changes = ref<GitChange[]>([]);
  const log = ref<GitLogEntry[]>([]);
  const busy = ref(false);
  const autoCommit = ref(false);
  const autoCommitMinutes = ref(5);
  const settingsOpen = ref(false);
  const identityOpen = ref(false);
  const credentialsOpen = ref(false);
  const credentialsReason = ref("");
  const choiceOpen = ref(false);
  const choiceFiles = ref<string[]>([]);
  const pending = ref<GitPending | null>(null);
  /** 重试时沿用用户已经做出的选择 */
  let pendingLocal: GitLocalChanges = "ask";
  const pendingMessage = ref("");
  const ready = ref(false);
  const loadError = ref("");

  let refreshTimer: number | null = null;
  let idleTimer: number | null = null;
  let seenRoot = "";
  let identityWarned = false;

  const badge = computed(() => {
    const n = isRepo.value && installed.value ? changes.value.length : 0;
    if (n <= 0) return "";
    return n > 99 ? "99+" : String(n);
  });
  const dirty = computed(() => installed.value && isRepo.value && changes.value.length > 0);
  const branchLabel = computed(() => (detached.value || !branch.value ? "分离 HEAD" : branch.value));

  const syncTitle = computed(() => {
    if (!useVaultStore().root) return "尚未打开笔记库";
    if (!installed.value) return "未检测到 Git\n点击查看安装说明";
    if (!isRepo.value) return "Git · 尚未初始化仓库\n点击打开 Git 设置";
    if (!remote.value) return `Git · ${branchLabel.value} · 尚未配置远程\n点击打开 Git 设置`;
    if (lockedReason.value) return lockedReason.value;
    const aheadBehind = hasUpstream.value ? `领先 ${ahead.value}、落后 ${behind.value}` : "尚未关联远程分支";
    const dirtyText = changes.value.length ? `${changes.value.length} 项未提交改动` : "没有未提交改动";
    return `Git · ${branchLabel.value} · ${aheadBehind} · ${dirtyText}\n点击一键同步（先拉取再推送）`;
  });

  function root(): string | null {
    return useVaultStore().root;
  }

  function clearIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdle() {
    clearIdle();
    const path = root();
    if (!path || !autoCommit.value || !isRepo.value || !installed.value || lockedReason.value) return;
    idleTimer = window.setTimeout(() => {
      idleTimer = null;
      void runAuto();
    }, autoCommitMinutes.value * 60 * 1000);
  }

  /** 编辑或外部修改后重新计算“停止编辑”的等待。 */
  function bumpActivity() {
    armIdle();
  }

  function applyStatus(path: string, st: Awaited<ReturnType<typeof api.gitStatus>>, entries: GitLogEntry[]) {
    if (root() !== path) return;
    installed.value = st.installed;
    isRepo.value = st.isRepo;
    branch.value = st.branch;
    detached.value = st.detached;
    ahead.value = st.ahead;
    behind.value = st.behind;
    hasUpstream.value = st.hasUpstream;
    remote.value = st.remote;
    userName.value = st.userName;
    userEmail.value = st.userEmail;
    credentialUser.value = st.credentialUser;
    lockedReason.value = st.lockedReason;
    changes.value = st.changes;
    log.value = entries;
    loadError.value = "";
    ready.value = true;
  }

  function reset() {
    clearIdle();
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    seenRoot = "";
    installed.value = true;
    isRepo.value = false;
    branch.value = null;
    detached.value = false;
    ahead.value = 0;
    behind.value = 0;
    hasUpstream.value = false;
    remote.value = null;
    userName.value = "";
    userEmail.value = "";
    credentialUser.value = null;
    lockedReason.value = null;
    changes.value = [];
    log.value = [];
    autoCommit.value = false;
    autoCommitMinutes.value = 5;
    settingsOpen.value = false;
    identityOpen.value = false;
    credentialsOpen.value = false;
    credentialsReason.value = "";
    choiceOpen.value = false;
    pending.value = null;
    pendingLocal = "ask";
    identityWarned = false;
    ready.value = false;
    loadError.value = "";
  }

  async function loadPrefs(path: string) {
    const raw = await api.readConfig(path, "git.json");
    if (root() !== path) return;
    const prefs = parseGitPrefs(raw);
    autoCommit.value = prefs.autoCommit;
    autoCommitMinutes.value = prefs.autoCommitMinutes;
  }

  async function refresh() {
    const path = root();
    if (!path) return;
    try {
      const [st, entries] = await Promise.all([api.gitStatus(path), api.gitLog(path).catch(() => [] as GitLogEntry[])]);
      if (root() !== path) return;
      applyStatus(path, st, entries);
      armIdle();
    } catch (e) {
      if (root() !== path) return;
      ready.value = true;
      const msg = e instanceof Error ? e.message : String(e);
      loadError.value = msg;
      useNoticeStore().report("读取版本控制状态失败", e);
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, 400);
  }

  function onExternalChange() {
    bumpActivity();
    scheduleRefresh();
  }

  async function attach(path: string) {
    if (seenRoot === path) {
      scheduleRefresh();
      return;
    }
    seenRoot = path;
    reset();
    seenRoot = path;
    try {
      await loadPrefs(path);
    } catch (e) {
      useNoticeStore().report("读取 Git 设置失败", e);
    }
    await refresh();
  }

  function showScm() {
    const settings = useSettingsStore();
    if (!settings.sidebarVisible) settings.toggleSidebar();
    useUiStore().view = "scm";
  }

  function openSettings() {
    if (!root()) return;
    showScm();
    settingsOpen.value = true;
  }

  async function apply(action: GitAction, kind: GitPending): Promise<boolean> {
    if (action.needIdentity) {
      pending.value = kind;
      identityOpen.value = true;
      return false;
    }
    if (action.needCredentials) {
      pending.value = kind;
      credentialsReason.value = action.notice;
      credentialsOpen.value = true;
      return false;
    }
    if (action.needChoice) {
      pending.value = kind;
      choiceFiles.value = action.choiceFiles;
      await refresh();
      choiceOpen.value = true;
      return false;
    }
    pendingLocal = "ask";
    if (action.notice) useNoticeStore().inform(action.notice);
    await refresh();
    return true;
  }

  async function runOp(label: string, kind: GitPending, fn: (path: string) => Promise<GitAction>): Promise<boolean> {
    const path = root();
    if (!path || busy.value) return false;
    busy.value = true;
    try {
      if (!(await useTabsStore().flushAll())) {
        useNoticeStore().report(label, "有笔记尚未保存");
        return false;
      }
      return await apply(await fn(path), kind);
    } catch (e) {
      useNoticeStore().report(label, e);
      await refresh();
      return false;
    } finally {
      busy.value = false;
    }
  }

  function commit(message: string) {
    pendingMessage.value = message;
    return runOp("提交失败", "commit", (path) => api.gitCommit(path, message));
  }

  function pull(local: GitLocalChanges = "ask") {
    pendingLocal = local;
    return runOp("拉取失败", "pull", (path) => api.gitPull(path, local));
  }

  function push() {
    return runOp("推送失败", "push", (path) => api.gitPush(path));
  }

  function sync(local: GitLocalChanges = "ask") {
    pendingLocal = local;
    return runOp("同步失败", "sync", (path) => api.gitSync(path, local));
  }

  /** 拉取前本地有未提交改动时，用户选了保留还是以仓库为准 */
  async function resolveChoice(local: "keep" | "discard") {
    choiceOpen.value = false;
    const next = pending.value;
    pending.value = null;
    if (next === "pull") await pull(local);
    else if (next === "sync") await sync(local);
  }

  function cancelChoice() {
    choiceOpen.value = false;
    pending.value = null;
    pendingLocal = "ask";
  }

  async function syncFromTitle() {
    if (!root()) return;
    if (!installed.value) {
      showScm();
      return;
    }
    if (!isRepo.value || !remote.value) {
      openSettings();
      return;
    }
    if (lockedReason.value) {
      showScm();
      return;
    }
    await sync();
  }

  async function initRepo() {
    const path = root();
    if (!path || busy.value) return;
    busy.value = true;
    try {
      await api.gitInit(path);
      useNoticeStore().inform("已初始化仓库");
      await refresh();
    } catch (e) {
      useNoticeStore().report("初始化仓库失败", e);
    } finally {
      busy.value = false;
    }
  }

  /** 自动提交的开关和等待时长。远程地址和账号由 connect 设置 */
  async function saveSettings(input: { autoCommit: boolean; minutes: number }) {
    const path = root();
    if (!path) return;
    const prefs: GitPrefs = { autoCommit: input.autoCommit, autoCommitMinutes: input.minutes };
    await api.writeConfig(path, "git.json", serializeGitPrefs(prefs));
    autoCommit.value = prefs.autoCommit;
    autoCommitMinutes.value = prefs.autoCommitMinutes;
    identityWarned = false;
    armIdle();
    await refresh();
  }

  /** 连接远程仓库：需要时初始化仓库、保存账号，实际访问一次远程 */
  async function connect(url: string, username: string, password: string): Promise<GitConnectResult | null> {
    const path = root();
    if (!path || busy.value) return null;
    busy.value = true;
    try {
      return await api.gitConnect(path, url, username, password);
    } finally {
      busy.value = false;
      await refresh();
    }
  }

  async function removeRemote() {
    const path = root();
    if (!path || !isRepo.value) return;
    await api.gitSetRemote(path, "");
    await refresh();
  }

  async function saveIdentity(name: string, email: string) {
    const path = root();
    if (!path) return;
    await api.gitSetIdentity(path, name, email);
    await refresh();
  }

  async function submitIdentity(name: string, email: string) {
    const path = root();
    if (!path) return;
    await api.gitSetIdentity(path, name, email);
    identityOpen.value = false;
    identityWarned = false;
    userName.value = name.trim();
    userEmail.value = email.trim();
    await resume();
  }

  async function resume() {
    const next = pending.value;
    pending.value = null;
    if (next === "commit") await commit(pendingMessage.value);
    else if (next === "pull") await pull(pendingLocal);
    else if (next === "push") await push();
    else if (next === "sync") await sync(pendingLocal);
  }

  function cancelIdentity() {
    identityOpen.value = false;
    pending.value = null;
  }

  /** 密码留空时沿用已保存的密码 */
  async function submitCredentials(username: string, password: string) {
    const path = root();
    if (!path) return;
    await api.gitSetCredentials(path, username, password);
    credentialsOpen.value = false;
    credentialsReason.value = "";
    credentialUser.value = username.trim();
    await resume();
  }

  function cancelCredentials() {
    credentialsOpen.value = false;
    credentialsReason.value = "";
    pending.value = null;
  }

  async function runAuto() {
    const path = root();
    if (!path || busy.value || !autoCommit.value || !isRepo.value || lockedReason.value) return;
    busy.value = true;
    try {
      if (!(await useTabsStore().flushAll())) return;
      const action = await api.gitAutoCommit(path, "自动提交");
      if (action.needIdentity) {
        if (!identityWarned) {
          identityWarned = true;
          useNoticeStore().inform("自动提交已跳过：请先在 Git 设置里填写用户名和邮箱");
        }
        return;
      }
      if (action.notice) useNoticeStore().inform(action.notice);
      await refresh();
    } catch (e) {
      useNoticeStore().report("自动提交失败", e);
    } finally {
      busy.value = false;
      armIdle();
    }
  }

  /** 退出前提交。返回需要告诉用户的失败原因；没有改动或不需要提交时返回 null。 */
  async function commitOnExit(): Promise<string | null> {
    const path = root();
    if (!path || !autoCommit.value || !installed.value || !isRepo.value || lockedReason.value) return null;
    if (!(await useTabsStore().flushAll())) return null;
    try {
      const action = await api.gitAutoCommit(path, "自动提交");
      if (action.needIdentity) return "还没有 Git 用户名和邮箱，无法自动提交";
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  return {
    installed, isRepo, branch, detached, ahead, behind, hasUpstream, remote,
    userName, userEmail, credentialUser, lockedReason, changes, log, busy,
    autoCommit, autoCommitMinutes, settingsOpen, identityOpen, credentialsOpen, credentialsReason, choiceOpen, choiceFiles, ready, loadError,
    badge, dirty, branchLabel, syncTitle,
    attach, reset, refresh, scheduleRefresh, onExternalChange, bumpActivity,
    openSettings, showScm, syncFromTitle, initRepo, commit, pull, push, sync,
    saveSettings, connect, removeRemote, saveIdentity,
    submitIdentity, cancelIdentity, submitCredentials, cancelCredentials, resolveChoice, cancelChoice, commitOnExit,
  };
});
