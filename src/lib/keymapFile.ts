import { normalizeShortcut, shortcutProblem } from "./shortcut";
import { scopesClash, type CommandScope } from "./commands";

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

/** 解析并校验导入的配置；格式错误时抛出异常，单条无效时跳过并记录原因。scopeOf 给出命令的作用范围 */
export function parseKeymap(text: string, knownIds: Set<string>, scopeOf: (id: string) => CommandScope = () => "global"): ParsedKeymap {
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
  const used: { spec: string; id: string }[] = [];
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
    const problem = shortcutProblem(spec, scopeOf(id));
    if (problem) {
      skipped.push(`${id}：${problem}`);
      continue;
    }
    const other = used.find((u) => u.spec === spec && scopesClash(scopeOf(u.id), scopeOf(id)));
    if (other) throw new Error(`${spec} 同时分配给了 ${other.id} 和 ${id}`);
    used.push({ spec, id });
    keybindings[id] = spec;
  }
  return { keybindings, skipped };
}
