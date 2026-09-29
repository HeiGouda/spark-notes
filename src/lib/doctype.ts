import { baseName } from "./api";

/** 笔记库里认识的三种文件，规则与 Rust 侧 doctype.rs 一致 */
export type DocKind = "note" | "mind" | "flow";

export const DOC_EXT: Record<DocKind, string> = { note: ".md", mind: ".mind.mmd", flow: ".flow.mmd" };
export const DOC_LABEL: Record<DocKind, string> = { note: "笔记", mind: "思维导图", flow: "流程图" };
/** 文件树行尾的类型小字，笔记不显示 */
export const DOC_TAG: Record<DocKind, string> = { note: "", mind: "导图", flow: "流程" };
export const DOC_ICON: Record<DocKind, string> = { note: "file", mind: "mind", flow: "flow" };

const ORDER: DocKind[] = ["mind", "flow", "note"];

/** 拆成去掉扩展名的部分和类型；不认识的文件返回 null */
export function splitDoc(path: string): { stem: string; kind: DocKind } | null {
  const lower = path.toLowerCase();
  for (const kind of ORDER) {
    const ext = DOC_EXT[kind];
    if (lower.length > ext.length && lower.endsWith(ext)) {
      const stem = path.slice(0, path.length - ext.length);
      if (!stem.endsWith("/")) return { stem, kind };
    }
  }
  return null;
}

export function docKind(path: string): DocKind | null {
  return splitDoc(path)?.kind ?? null;
}

export function isDiagram(path: string): boolean {
  const k = docKind(path);
  return k === "mind" || k === "flow";
}

/** 文件名去掉扩展名，用于显示 */
export function docName(path: string): string {
  const file = baseName(path);
  return splitDoc(file)?.stem ?? file;
}
