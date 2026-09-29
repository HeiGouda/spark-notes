import { describe, expect, it } from "vitest";
import { isHttpRemote, parseGitPrefs, serializeGitPrefs, tokenUrl } from "./gitPrefs";

describe("Git 偏好", () => {
  it("缺省为关闭、5 分钟", () => {
    expect(parseGitPrefs(null)).toEqual({ autoCommit: false, autoCommitMinutes: 5 });
    expect(parseGitPrefs("not json")).toEqual({ autoCommit: false, autoCommitMinutes: 5 });
  });

  it("分钟数限制在 1 到 240", () => {
    expect(parseGitPrefs('{"autoCommit":true,"autoCommitMinutes":0}')).toEqual({ autoCommit: true, autoCommitMinutes: 1 });
    expect(parseGitPrefs('{"autoCommit":true,"autoCommitMinutes":999}')).toEqual({ autoCommit: true, autoCommitMinutes: 240 });
    const raw = serializeGitPrefs({ autoCommit: true, autoCommitMinutes: 12.6 });
    expect(parseGitPrefs(raw)).toEqual({ autoCommit: true, autoCommitMinutes: 13 });
  });

  it("只有 HTTP(S) 地址需要账号", () => {
    expect(isHttpRemote(" https://gitee.com/a/b.git")).toBe(true);
    expect(isHttpRemote("HTTP://192.168.1.2/git/notes.git")).toBe(true);
    expect(isHttpRemote("git@github.com:a/b.git")).toBe(false);
    expect(isHttpRemote("ssh://git@host/a.git")).toBe(false);
    expect(isHttpRemote("")).toBe(false);
  });

  it("认得常见平台的令牌页面", () => {
    expect(tokenUrl("https://github.com/a/b.git")).toContain("github.com/settings/tokens");
    expect(tokenUrl("https://me@Gitee.com/a/b.git")).toContain("gitee.com/profile/personal_access_tokens");
    expect(tokenUrl("https://git.example.com/a/b.git")).toBeNull();
    expect(tokenUrl("git@github.com:a/b.git")).toBeNull();
  });
});
