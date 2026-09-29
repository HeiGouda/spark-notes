/**
 * Milkdown 不认识 YAML Front Matter，直接交给它会被解析成分割线和正文，保存时会破坏元数据。
 * 因此打开笔记时把 Front Matter 原样切出来，编辑器只处理正文，保存时再原样拼回。
 */
/** 连同其后的空行一起切出：编辑器序列化正文时会去掉开头空行，放在前缀里才能原样保留 */
const FRONT_MATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/;

export interface SplitNote {
  /** 原样保留的前缀（BOM + Front Matter），没有时为空字符串 */
  frontMatter: string;
  body: string;
}

export function splitFrontMatter(source: string): SplitNote {
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const rest = source.slice(bom.length);
  const m = FRONT_MATTER.exec(rest);
  if (!m) return { frontMatter: bom, body: rest };
  return { frontMatter: bom + m[0], body: rest.slice(m[0].length) };
}

export function joinFrontMatter(frontMatter: string, body: string): string {
  if (!frontMatter || frontMatter === "\uFEFF") return frontMatter + body;
  const sep = /\r?\n$/.test(frontMatter) ? "" : "\n";
  return frontMatter + sep + body;
}

export interface NoteMeta {
  tags: string[];
  /** YYYY-MM-DD */
  created: string | null;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseMeta(frontMatter: string): NoteMeta {
  const meta: NoteMeta = { tags: [], created: null };
  const lines = frontMatter.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tagMatch = /^tags\s*:\s*(.*)$/.exec(line);
    if (tagMatch) {
      const value = tagMatch[1].trim();
      if (value.startsWith("[")) {
        meta.tags = value.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
      } else if (value) {
        meta.tags = value.split(",").map(unquote).filter(Boolean);
      } else {
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
          i++;
          const item = unquote(lines[i].replace(/^\s*-\s+/, ""));
          if (item) meta.tags.push(item);
        }
      }
      continue;
    }
    const createdMatch = /^created\s*:\s*["']?(\d{4}-\d{2}-\d{2})/.exec(line);
    if (createdMatch) meta.created = createdMatch[1];
  }
  return meta;
}

/**
 * 改写 Front Matter 里的 tags，其他内容原样保留；原来是 YAML 列表时仍写成列表。
 * 没有 Front Matter 时新建；标签清空后去掉 tags 一项，Front Matter 随之变空时整段去掉。
 * 标签只含字母、数字、`_`、`-`、`/`，无需加引号。
 */
export function setFrontMatterTags(frontMatter: string, tags: string[]): string {
  const bom = frontMatter.startsWith("\uFEFF") ? "\uFEFF" : "";
  const src = frontMatter.slice(bom.length);
  const inline = tags.length ? `tags: [${tags.join(", ")}]` : null;
  if (!src) return inline ? `${bom}---\n${inline}\n---\n\n` : frontMatter;
  const lines = src.split("\n");
  const close = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l));
  if (close < 0) return frontMatter;
  const inner = lines.slice(1, close);
  const start = inner.findIndex((l) => /^tags\s*:/.test(l));
  if (start < 0) {
    if (!inline) return frontMatter;
    inner.push(inline);
  } else {
    let end = start + 1;
    const listForm = /^tags\s*:\s*$/.test(inner[start]);
    if (listForm) while (end < inner.length && /^\s*-\s+/.test(inner[end])) end++;
    const indent = listForm && end > start + 1 ? /^(\s*)-/.exec(inner[start + 1])![1] : null;
    const replacement = !tags.length ? [] : indent !== null ? ["tags:", ...tags.map((t) => `${indent}- ${t}`)] : [inline!];
    inner.splice(start, end - start, ...replacement);
  }
  if (!inner.some((l) => l.trim())) return bom;
  return bom + ["---", ...inner, ...lines.slice(close)].join("\n");
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
