import { dirOf } from "./api";

/** 与 Rust 端 notes.rs 的 resolve_link 规则一致 */
const stripMd = (p: string) => p.replace(/\.md$/i, "");
const stemOf = (p: string) => stripMd(p).split("/").pop() ?? p;

function normalizeRel(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * 带路径时按笔记库相对路径（其次相对当前笔记所在文件夹）匹配；
 * 只写笔记名时优先同一文件夹，其次路径最短的
 */
export function resolveLink(target: string, src: string, all: string[]): string | null {
  const t = stripMd(target.trim()).replace(/\\/g, "/");
  if (!t) return null;
  const tl = t.toLowerCase();
  if (t.includes("/")) {
    const abs = normalizeRel(tl);
    const rel = normalizeRel(`${dirOf(src)}/${tl}`.toLowerCase());
    return all.find((p) => stripMd(p).toLowerCase() === abs) ?? all.find((p) => stripMd(p).toLowerCase() === rel) ?? null;
  }
  const srcDir = dirOf(src);
  const candidates = all.filter((p) => stemOf(p).toLowerCase() === tl);
  candidates.sort((a, b) => {
    const sa = dirOf(a) === srcDir ? 0 : 1;
    const sb = dirOf(b) === srcDir ? 0 : 1;
    return sa - sb || a.split("/").length - b.split("/").length || (a.toLowerCase() < b.toLowerCase() ? -1 : 1);
  });
  return candidates[0] ?? null;
}

export interface Candidate {
  label: string;
  detail: string;
  value: string;
}

/** 双向链接补全候选：名称以查询词开头的排前面；有同名笔记时写入带路径的形式 */
export function linkCandidates(query: string, all: string[], exclude?: string): Candidate[] {
  const q = query.trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const p of all) counts.set(stemOf(p).toLowerCase(), (counts.get(stemOf(p).toLowerCase()) ?? 0) + 1);
  return all
    .filter((p) => p !== exclude)
    .map((p) => ({ path: p, stem: stemOf(p) }))
    .filter(({ path, stem }) => !q || stem.toLowerCase().includes(q) || stripMd(path).toLowerCase().includes(q))
    .sort((a, b) => {
      const pa = a.stem.toLowerCase().startsWith(q) ? 0 : 1;
      const pb = b.stem.toLowerCase().startsWith(q) ? 0 : 1;
      return pa - pb || a.stem.length - b.stem.length || a.path.localeCompare(b.path, "zh-CN");
    })
    .map(({ path, stem }) => ({
      label: stem,
      detail: dirOf(path) || "根目录",
      value: (counts.get(stem.toLowerCase()) ?? 0) > 1 ? stripMd(path) : stem,
    }));
}
