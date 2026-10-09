/** 把纯文本切成章节，做成和电子书一样的一节一节 */

const HEADING = /^(第[0-9０-９零一二三四五六七八九十百千两]+[章节回部卷集]|chapter\s+\d+).*$/i

export interface TxtSection {
  title: string
  text: string
}

/** 中文小说常见 GBK 编码：先按 UTF-8 严格解码，不是 UTF-8 就按 GB18030（兼容 GBK）读 */
export function decodeTxt(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder("gb18030").decode(bytes)
  }
}

export function splitTxt(raw: string): TxtSection[] {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
  const lines = text.split("\n")
  const sections: TxtSection[] = []
  let title = "正文"
  let buf: string[] = []
  const push = () => {
    const body = buf.join("\n").trim()
    if (body) sections.push({ title, text: body })
    buf = []
  }
  for (const line of lines) {
    if (HEADING.test(line.trim()) && (buf.length || sections.length)) {
      push()
      title = line.trim()
    } else if (HEADING.test(line.trim()) && !buf.join("").trim()) {
      title = line.trim()
    } else {
      buf.push(line)
    }
  }
  push()
  return sections.length ? sections : [{ title: "正文", text: text.trim() || "（空文件）" }]
}

/** 一节太长（没有章节标题的整本书，或章节特别长）时按段落切成几页，避免一次排版几百万字 */
export const MAX_SECTION_CHARS = 20000

export interface TxtPage extends TxtSection {
  /** 这一节的第一页，目录只指向它 */
  first: boolean
}

export function paginate(sections: TxtSection[], max = MAX_SECTION_CHARS): TxtPage[] {
  const pages: TxtPage[] = []
  for (const s of sections) {
    if (s.text.length <= max) {
      pages.push({ ...s, first: true })
      continue
    }
    let buf: string[] = []
    let len = 0
    let first = true
    const flush = () => {
      if (!buf.length) return
      pages.push({ title: s.title, text: buf.join("\n"), first })
      first = false
      buf = []
      len = 0
    }
    for (const line of s.text.split("\n")) {
      // 单行就超长的（整本书没有换行）按字数硬切
      for (let i = 0; i < Math.max(line.length, 1); i += max) {
        const piece = line.slice(i, i + max)
        if (len + piece.length > max) flush()
        buf.push(piece)
        len += piece.length + 1
      }
    }
    flush()
  }
  return pages
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function sectionHtml(section: TxtSection): string {
  const paras = section.text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("")
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><h2>${escapeHtml(section.title)}</h2>${paras}</body></html>`
}

/** foliate-view 能打开的书。href 用章节序号 */
export function txtBook(raw: string, name: string) {
  const sections = paginate(splitTxt(raw))
  const html = sections.map(sectionHtml)
  return {
    dir: "ltr",
    metadata: { title: name.replace(/\.txt$/i, "") },
    toc: sections.flatMap((s, i) => (s.first ? [{ label: s.title, href: String(i) }] : [])),
    sections: sections.map((s, i) => ({
      id: i,
      linear: "yes",
      size: s.text.length,
      load: () => URL.createObjectURL(new Blob([html[i]], { type: "text/html" })),
      createDocument: () => new DOMParser().parseFromString(html[i], "text/html"),
    })),
    resolveHref: (href: string) => ({ index: Number(href) || 0 }),
    splitTOCHref: (href: string) => [Number(href) || 0, null],
    getTOCFragment: (doc: Document) => doc.body,
  }
}
