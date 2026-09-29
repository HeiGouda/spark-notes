import { describe, expect, it } from "vitest";
import { actionable, firstStep, isLegacySyncConfig, parseSyncConfig, serializeSyncConfig, syncNotice } from "../stores/webdav";
import type { SyncPreview, SyncReport } from "./api";

const report = (patch: Partial<SyncReport>): SyncReport => ({ uploaded: 0, downloaded: 0, remoteTrashed: 0, localTrashed: 0, skipped: 0, errors: [], ...patch });
const preview = (patch: Partial<SyncPreview>): SyncPreview => ({ upload: [], download: [], guard: null, localFiles: 0, remoteFiles: 0, lastSyncMs: 0, ...patch });

describe("同步设置", () => {
  it("缺省为不同步，手动为主，打开时检查云端", () => {
    const cfg = parseSyncConfig(null);
    expect(cfg.mode).toBe("off");
    expect(cfg.autoUpload).toBe(false);
    expect(cfg.checkOnOpen).toBe(true);
  });

  it("旧版的自动同步升级后改成手动", () => {
    const raw = '{"mode":"webdav","url":"https://d/","username":"u","auto":true,"intervalMinutes":10}';
    expect(isLegacySyncConfig(raw)).toBe(true);
    const cfg = parseSyncConfig(raw);
    expect(cfg.autoUpload).toBe(false);
    expect(isLegacySyncConfig(serializeSyncConfig(cfg))).toBe(false);
    expect(isLegacySyncConfig('{"mode":"git","auto":true}')).toBe(false);
  });

  it("提示说清楚做了什么", () => {
    expect(syncNotice("upload", report({ uploaded: 2, remoteTrashed: 1 }))).toBe("已上传到云端：上传 2 个，1 个旧版本移到云端回收文件夹");
    expect(syncNotice("download", report({}))).toBe("本地已是最新");
    expect(syncNotice("download", report({ errors: ["网络中断", "超时"] }))).toContain("网络中断（另有 1 个错误）");
  });

  it("第一次同步的建议", () => {
    expect(firstStep(preview({ localFiles: 3 }))).toBe("upload");
    expect(firstStep(preview({ remoteFiles: 3 }))).toBe("download");
    expect(firstStep(preview({ localFiles: 1, remoteFiles: 3 }))).toBe("choose");
    expect(firstStep(preview({ localFiles: 1, remoteFiles: 3, lastSyncMs: 1 }))).toBeNull();
    expect(actionable([{ rel: "a.md", step: "keep" }, { rel: "b.md", step: "add" }])).toBe(1);
  });
});
