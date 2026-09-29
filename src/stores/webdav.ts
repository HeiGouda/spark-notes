import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { api, type PlanItem, type SyncDirection, type SyncPreview, type SyncReport } from "../lib/api";
import { useNoticeStore } from "./notice";
import { useTabsStore } from "./tabs";
import { useVaultStore } from "./vault";

export type SyncMode = "off" | "webdav" | "git";

export interface SyncConfig {
  mode: SyncMode;
  url: string;
  username: string;
  remoteDir: string;
  /** 停止编辑 1 分钟后自动上传不需要确认的改动 */
  autoUpload: boolean;
  /** 打开笔记库时读一次云端列表（不下载），有更新时在图标上标出 */
  checkOnOpen: boolean;
}

const DEFAULTS: SyncConfig = { mode: "off", url: "", username: "", remoteDir: "", autoUpload: false, checkOnOpen: true };
const AUTO_UPLOAD_MS = 60_000;

export function parseSyncConfig(raw: string | null | undefined): SyncConfig {
  if (!raw) return { ...DEFAULTS };
  try {
    const v = JSON.parse(raw) as Partial<SyncConfig>;
    const mode: SyncMode = v.mode === "webdav" || v.mode === "git" ? v.mode : "off";
    return {
      mode,
      url: typeof v.url === "string" ? v.url : "",
      username: typeof v.username === "string" ? v.username : "",
      remoteDir: typeof v.remoteDir === "string" ? v.remoteDir : "",
      autoUpload: v.autoUpload === true,
      checkOnOpen: v.checkOnOpen !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 旧版的双向自动同步配置（`auto` / `intervalMinutes`），升级后一律改成手动 */
export function isLegacySyncConfig(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return v.mode === "webdav" && !("autoUpload" in v) && ("auto" in v || "intervalMinutes" in v);
  } catch {
    return false;
  }
}

export function serializeSyncConfig(c: SyncConfig): string {
  return JSON.stringify({
    mode: c.mode,
    url: c.url.trim(),
    username: c.username.trim(),
    remoteDir: c.remoteDir.trim(),
    autoUpload: c.autoUpload,
    checkOnOpen: c.checkOnOpen,
  }, null, 2) + "\n";
}

export function needsConfirm(item: PlanItem): boolean {
  return item.step === "overwrite" || item.step === "remove";
}

/** 要实际处理的文件数（不含只提示的） */
export function actionable(items: PlanItem[]): number {
  return items.filter((i) => i.step !== "keep").length;
}

/** 第一次同步前给出的建议 */
export function firstStep(p: SyncPreview): SyncDirection | "choose" | null {
  if (p.lastSyncMs) return null;
  if (p.remoteFiles === 0) return p.localFiles ? "upload" : null;
  if (p.localFiles === 0) return "download";
  return "choose";
}

export function syncNotice(direction: SyncDirection, r: SyncReport): string {
  if (r.errors.length) {
    const extra = r.errors.length > 1 ? `（另有 ${r.errors.length - 1} 个错误）` : "";
    return `${direction === "upload" ? "上传" : "同步"}未完成：${r.errors[0]}${extra}`;
  }
  const parts: string[] = [];
  if (direction === "upload") {
    if (r.uploaded) parts.push(`上传 ${r.uploaded} 个`);
    if (r.remoteTrashed) parts.push(`${r.remoteTrashed} 个旧版本移到云端回收文件夹`);
  } else {
    if (r.downloaded) parts.push(`下载 ${r.downloaded} 个`);
    if (r.localTrashed) parts.push(`${r.localTrashed} 个移入回收站`);
  }
  if (r.skipped) parts.push(`跳过 ${r.skipped} 个`);
  const head = direction === "upload" ? "已上传到云端" : "已从云端同步";
  if (!parts.length) return direction === "upload" ? "没有需要上传的改动" : "本地已是最新";
  return `${head}：${parts.join("，")}`;
}

export type SyncBadge = "unknown" | "ok" | "local" | "remote" | "attention" | "failed" | "busy";

export const useWebdavStore = defineStore("webdav", () => {
  const mode = ref<SyncMode>("off");
  /** 笔记库里已经有 sync.json。没有时，已有 Git 仓库仍走 Git 同步。 */
  const configured = ref(false);
  const url = ref("");
  const username = ref("");
  const remoteDir = ref("");
  const autoUpload = ref(false);
  const checkOnOpen = ref(true);
  const hasPassword = ref(false);
  const busy = ref<"" | "check" | SyncDirection>("");
  const preview = ref<SyncPreview | null>(null);
  /** 上次检查后本地又保存过 */
  const localDirty = ref(false);
  const failed = ref("");
  const planOpen = ref(false);
  const planDirection = ref<SyncDirection>("download");
  const planPreview = ref<SyncPreview | null>(null);
  let autoTimer: number | null = null;
  let lastAutoError = "";
  let seen = "";

  const uploadCount = computed(() => (preview.value ? actionable(preview.value.upload) : 0));
  const downloadCount = computed(() => (preview.value ? actionable(preview.value.download) : 0));
  const attention = computed(() => {
    const p = preview.value;
    if (!p) return 0;
    if (p.guard) return 1;
    return p.upload.filter(needsConfirm).length + p.download.filter(needsConfirm).length;
  });

  const badge = computed<SyncBadge>(() => {
    if (busy.value && busy.value !== "check") return "busy";
    if (failed.value) return "failed";
    if (!preview.value) return "unknown";
    if (attention.value) return "attention";
    if (downloadCount.value) return "remote";
    if (uploadCount.value || localDirty.value) return "local";
    return "ok";
  });

  const lastSyncText = computed(() => {
    const ms = preview.value?.lastSyncMs;
    if (!ms) return "尚未同步过";
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = new Date().toDateString() === d.toDateString();
    return `上次同步 ${today ? "" : `${d.getMonth() + 1}月${d.getDate()}日 `}${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  const title = computed(() => {
    if (!useVaultStore().root) return "尚未打开笔记库";
    if (mode.value !== "webdav") return "";
    const head = "WebDAV";
    switch (badge.value) {
      case "busy": return `${head} · ${busy.value === "upload" ? "正在上传" : "正在同步"}`;
      case "failed": return `${head} · 失败：${failed.value}\n点击查看`;
      case "attention": return `${head} · 有需要你确认的文件\n点击查看`;
      case "remote": return `${head} · 云端有 ${downloadCount.value} 个更新\n点击同步`;
      case "local": return `${head} · 有未上传的改动\n点击上传`;
      case "ok": return `${head} · 已同步\n${lastSyncText.value}`;
      default: return `${head}\n点击上传或同步`;
    }
  });

  function root() {
    return useVaultStore().root;
  }

  function clearAuto() {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
  }

  async function attach(path: string) {
    if (seen === path) return;
    seen = path;
    clearAuto();
    failed.value = "";
    preview.value = null;
    localDirty.value = false;
    try {
      const raw = await api.readConfig(path, "sync.json");
      if (root() !== path) return;
      configured.value = raw != null;
      const cfg = parseSyncConfig(raw);
      applyFields(cfg);
      hasPassword.value = await api.webdavHasPassword(path);
      if (isLegacySyncConfig(raw)) {
        await api.writeConfig(path, "sync.json", serializeSyncConfig(cfg));
        useNoticeStore().inform("WebDAV 同步改成了手动：点标题栏的同步图标选择“上传”或“从云端同步”，执行前会列出要改动的文件。自动上传可在设置里打开。");
      }
    } catch (e) {
      useNoticeStore().report("读取同步设置失败", e);
    }
    if (mode.value === "webdav" && checkOnOpen.value && ready()) void check();
  }

  function reset() {
    seen = "";
    clearAuto();
    mode.value = "off";
    configured.value = false;
    hasPassword.value = false;
    busy.value = "";
    preview.value = null;
    localDirty.value = false;
    failed.value = "";
    planOpen.value = false;
    planPreview.value = null;
  }

  function applyFields(cfg: SyncConfig) {
    mode.value = cfg.mode;
    url.value = cfg.url;
    username.value = cfg.username;
    remoteDir.value = cfg.remoteDir;
    autoUpload.value = cfg.autoUpload;
    checkOnOpen.value = cfg.checkOnOpen;
  }

  function applyConfig(cfg: SyncConfig) {
    configured.value = true;
    const target = `${cfg.url}|${cfg.remoteDir}|${cfg.username}`;
    const changed = target !== `${url.value}|${remoteDir.value}|${username.value}`;
    applyFields(cfg);
    if (changed) preview.value = null;
    if (!cfg.autoUpload) clearAuto();
  }

  function ready(): boolean {
    return mode.value === "webdav" && !!url.value.trim() && !!username.value.trim();
  }

  /** 读一次云端列表，更新图标上的计数。不改动任何文件。 */
  async function check(manual = false): Promise<SyncPreview | null> {
    const path = root();
    if (!path || !ready()) {
      if (manual) useNoticeStore().report("无法同步", "请先在设置里填写 WebDAV 地址和用户名");
      return null;
    }
    if (busy.value) return null;
    busy.value = "check";
    try {
      const p = await api.webdavPreview(path, url.value, remoteDir.value, username.value);
      if (root() !== path) return null;
      preview.value = p;
      localDirty.value = false;
      failed.value = "";
      if (manual) useNoticeStore().inform(downloadCount.value ? `云端有 ${downloadCount.value} 个更新` : "云端没有新内容");
      return p;
    } catch (e) {
      if (root() !== path) return null;
      failed.value = e instanceof Error ? e.message : String(e);
      if (manual) useNoticeStore().report("检查云端失败", e);
      return null;
    } finally {
      busy.value = "";
    }
  }

  /** 手动上传或同步：先预览，有需要确认的文件时弹出清单，否则直接执行 */
  async function start(direction: SyncDirection) {
    const path = root();
    if (!path) return;
    if (!ready()) {
      useNoticeStore().report(direction === "upload" ? "无法上传" : "无法同步", "请先在设置里填写 WebDAV 地址和用户名");
      return;
    }
    if (busy.value) return;
    if (!(await useTabsStore().flushAll())) {
      useNoticeStore().report(direction === "upload" ? "上传失败" : "同步失败", "有笔记尚未保存");
      return;
    }
    const p = await check();
    if (!p) {
      if (failed.value) useNoticeStore().report(direction === "upload" ? "上传失败" : "同步失败", failed.value);
      return;
    }
    const items = direction === "upload" ? p.upload : p.download;
    if (p.guard || items.some(needsConfirm) || (direction === "download" && firstStep(p) === "choose")) {
      planDirection.value = direction;
      planPreview.value = p;
      planOpen.value = true;
      return;
    }
    if (!actionable(items)) {
      useNoticeStore().inform(direction === "upload" ? "没有需要上传的改动" : "本地已是最新");
      return;
    }
    await execute(direction, [], false);
  }

  async function confirmPlan(accept: string[], force: boolean) {
    planOpen.value = false;
    await execute(planDirection.value, accept, force);
    planPreview.value = null;
  }

  function cancelPlan() {
    planOpen.value = false;
    planPreview.value = null;
  }

  async function execute(direction: SyncDirection, accept: string[], force: boolean) {
    const path = root();
    if (!path || busy.value) return;
    busy.value = direction;
    let report: SyncReport | null = null;
    try {
      report = await api.webdavRun(path, url.value, remoteDir.value, username.value, direction, accept, force);
      if (root() !== path) return;
      const text = syncNotice(direction, report);
      failed.value = report.errors[0] ?? "";
      if (report.errors.length) useNoticeStore().report(direction === "upload" ? "上传未完成" : "同步未完成", report.errors[0]);
      else useNoticeStore().inform(text);
      if (report.downloaded || report.localTrashed) await useVaultStore().refresh();
    } catch (e) {
      if (root() !== path) return;
      failed.value = e instanceof Error ? e.message : String(e);
      useNoticeStore().report(direction === "upload" ? "上传失败" : "同步失败", e);
    } finally {
      busy.value = "";
    }
    if (report) await check();
  }

  function scheduleAfterSave() {
    if (mode.value !== "webdav" || !seen) return;
    localDirty.value = true;
    if (!autoUpload.value || !ready()) return;
    clearAuto();
    autoTimer = window.setTimeout(() => { autoTimer = null; void runAutoUpload(); }, AUTO_UPLOAD_MS);
  }

  /** 只上传不需要确认的改动；需要确认的留给用户，图标上会标出 */
  async function runAutoUpload() {
    const path = root();
    if (!path || busy.value || !autoUpload.value || !ready()) return;
    if (!(await useTabsStore().flushAll())) return;
    busy.value = "upload";
    try {
      const report = await api.webdavRun(path, url.value, remoteDir.value, username.value, "upload", [], false);
      if (root() !== path) return;
      failed.value = report.errors[0] ?? "";
      lastAutoError = "";
      if (report.errors.length) useNoticeStore().report("自动上传未完成", report.errors[0]);
    } catch (e) {
      if (root() !== path) return;
      const msg = e instanceof Error ? e.message : String(e);
      failed.value = msg;
      if (msg !== lastAutoError) useNoticeStore().report("自动上传失败", e);
      lastAutoError = msg;
    } finally {
      busy.value = "";
    }
    await check();
  }

  return {
    mode, configured, url, username, remoteDir, autoUpload, checkOnOpen, hasPassword,
    busy, preview, localDirty, failed, planOpen, planDirection, planPreview,
    uploadCount, downloadCount, attention, badge, lastSyncText, title,
    attach, reset, applyConfig, ready, check, start, confirmPlan, cancelPlan, scheduleAfterSave,
  };
});
