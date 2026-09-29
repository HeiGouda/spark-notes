import { dirOf } from "./api";
import { DOC_LABEL, docKind, docName } from "./doctype";

/**
 * 与 Rust 端 notes.rs 的 strip_md / resolve_link 规则一致：笔记去掉 `.md`，图只去掉 `.mmd`，
 * 所以 `[[上线流程.flow]]` 指向流程图，不带后缀的 `[[上线流程]]` 只指向笔记
 */
const stripMd = (p: string) => p.replace(/(\.(?:flow|mind))\.mmd$/i, "$1").replace(/\.md$/i, "");
const stemOf = (p: string) => stripMd(p).split("/").pop() ?? p;

/** 链接目标带 `.flow` / `.mind` 后缀时，显示时去掉后缀并返回类型 */
export function linkDisplay(target: string): { label: string; kind: "flow" | "mind" | null } {
  const m = /^(.*)\.(flow|mind)$/i.exec(target.trim());
  return m ? { label: m[1], kind: m[2].toLowerCase() as "flow" | "mind" } : { label: target, kind: null };
}

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

/** 双向链接补全候选（笔记和图）：名称以查询词开头的排前面；有同名时写入带路径的形式；图带类型后缀 */
export function linkCandidates(query: string, all: string[], exclude?: string): Candidate[] {
  const q = query.trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const p of all) counts.set(stemOf(p).toLowerCase(), (counts.get(stemOf(p).toLowerCase()) ?? 0) + 1);
  return all
    .filter((p) => p !== exclude)
    .map((p) => ({ path: p, stem: stemOf(p), name: docName(p) }))
    .filter(({ path, name }) => !q || name.toLowerCase().includes(q) || stripMd(path).toLowerCase().includes(q))
    .sort((a, b) => {
      const pa = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const pb = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      const ka = docKind(a.path) === "note" ? 0 : 1;
      const kb = docKind(b.path) === "note" ? 0 : 1;
      return pa - pb || a.name.length - b.name.length || ka - kb || a.path.localeCompare(b.path, "zh-CN");
    })
    .map(({ path, stem, name }) => {
      const kind = docKind(path);
      const folder = dirOf(path) || "根目录";
      return {
        label: name,
        detail: kind && kind !== "note" ? `${DOC_LABEL[kind]} · ${folder}` : folder,
        value: (counts.get(stem.toLowerCase()) ?? 0) > 1 ? stripMd(path) : stem,
      };
    });
}
