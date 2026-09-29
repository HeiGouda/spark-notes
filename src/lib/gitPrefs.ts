/** 笔记库级 Git 偏好，存在 `.ttnote/config/git.json`，随仓库提交。 */

export interface GitPrefs {
  autoCommit: boolean;
  autoCommitMinutes: number;
}

export const DEFAULT_GIT_PREFS: GitPrefs = { autoCommit: false, autoCommitMinutes: 5 };

export function clampMinutes(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GIT_PREFS.autoCommitMinutes;
  return Math.min(240, Math.max(1, Math.round(value)));
}

/** HTTPS 远程需要账号和密码（或访问令牌）；SSH 地址用本机密钥。 */
export function isHttpRemote(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** 常见平台创建个人访问令牌的页面 */
export function tokenUrl(url: string): string | null {
  const host = /^https?:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url.trim())?.[1]?.toLowerCase();
  if (host === "github.com") return "https://github.com/settings/tokens/new?scopes=repo&description=Spark";
  if (host === "gitee.com") return "https://gitee.com/profile/personal_access_tokens";
  if (host === "gitlab.com") return "https://gitlab.com/-/user_settings/personal_access_tokens";
  return null;
}

export function parseGitPrefs(raw: string | null | undefined): GitPrefs {
  if (!raw) return { ...DEFAULT_GIT_PREFS };
  try {
    const v = JSON.parse(raw) as { autoCommit?: unknown; autoCommitMinutes?: unknown };
    return {
      autoCommit: v.autoCommit === true,
      autoCommitMinutes: clampMinutes(Number(v.autoCommitMinutes)),
    };
  } catch {
    return { ...DEFAULT_GIT_PREFS };
  }
}

export function serializeGitPrefs(prefs: GitPrefs): string {
  return JSON.stringify(
    { autoCommit: prefs.autoCommit, autoCommitMinutes: clampMinutes(prefs.autoCommitMinutes) },
    null,
    2,
  ) + "\n";
}
