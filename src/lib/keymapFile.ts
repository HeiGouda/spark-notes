import { normalizeShortcut, shortcutProblem } from "./shortcut";

/** 快捷键配置文件（导出 / 导入，需求文档 5.13） */
export interface KeymapFile {
  app: "Spark";
  version: 1;
  /** 命令 id → 快捷键；null 表示“无” */
  keybindings: Record<string, string | null>;
}

export function serializeKeymap(overrides: Record<string, string | null>): string {
  const file: KeymapFile = { app: "Spark", version: 1, keybindings: overrides };
  return JSON.stringify(file, null, 2) + "\n";
}

export interface ParsedKeymap {
  keybindings: Record<string, string | null>;
  /** 被跳过的条目及原因 */
  skipped: string[];
}

/** 解析并校验导入的配置；格式错误时抛出异常，单条无效时跳过并记录原因 */
export function parseKeymap(text: string, knownIds: Set<string>): ParsedKeymap {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("文件不是有效的 JSON");
  }
  const map = (data as Partial<KeymapFile> | null)?.keybindings;
  if (!map || typeof map !== "object") throw new Error("文件中没有 keybindings");
  const keybindings: Record<string, string | null> = {};
  const skipped: string[] = [];
  const used = new Map<string, string>();
  for (const [id, value] of Object.entries(map)) {
    if (!knownIds.has(id)) {
      skipped.push(`${id}：未知命令`);
      continue;
    }
    if (value === null) {
      keybindings[id] = null;
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      skipped.push(`${id}：快捷键格式错误`);
      continue;
    }
    const spec = normalizeShortcut(value);
    const problem = shortcutProblem(spec);
    if (problem) {
      skipped.push(`${id}：${problem}`);
      continue;
    }
    const other = used.get(spec);
    if (other) throw new Error(`${spec} 同时分配给了 ${other} 和 ${id}`);
    used.set(spec, id);
    keybindings[id] = spec;
  }
  return { keybindings, skipped };
}
