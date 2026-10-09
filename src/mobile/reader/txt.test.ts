import { describe, expect, it } from "vitest"
import { decodeTxt, paginate, splitTxt, txtBook } from "./txt"

describe("纯文本分章", () => {
  it("按“第X章”切开，章名成为标题", () => {
    const sections = splitTxt("引言\n\n开始。\n\n第一章 认知革命\n\n智人出现了。\n\n第二章 知善恶树\n\n农业。")
    expect(sections.map((s) => s.title)).toEqual(["正文", "第一章 认知革命", "第二章 知善恶树"])
    expect(sections[1].text).toContain("智人出现了")
  })

  it("没有章节时整篇是一节", () => {
    expect(splitTxt("只有一段正文。")).toEqual([{ title: "正文", text: "只有一段正文。" }])
  })

  it("做成书之后，目录的链接能回到对应的章节", () => {
    const book = txtBook("第一章 甲\n\n甲。\n\n第二章 乙\n\n乙。", "测试.txt")
    expect(book.toc.map((t) => t.label)).toEqual(["第一章 甲", "第二章 乙"])
    expect(book.resolveHref("1").index).toBe(1)
    expect(book.metadata.title).toBe("测试")
  })
})

describe("纯文本编码", () => {
  it("UTF-8 照常读，带 BOM 也行", () => {
    expect(decodeTxt(new TextEncoder().encode("第一章 开始"))).toBe("第一章 开始")
    expect(decodeTxt(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("你好")]))).toBe("你好")
  })

  it("不是 UTF-8 时按 GBK 读（小说常见）", () => {
    // “第一章 开始”的 GBK 字节
    const gbk = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xbf, 0xaa, 0xca, 0xbc])
    expect(decodeTxt(gbk)).toBe("第一章 开始")
  })

  it("UTF-16 带 BOM 也能读", () => {
    expect(decodeTxt(new Uint8Array([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59]))).toBe("你好")
  })
})

describe("过长的章节切页", () => {
  it("短的章节原样保留，都算第一页", () => {
    const pages = paginate([{ title: "甲", text: "短" }], 100)
    expect(pages).toEqual([{ title: "甲", text: "短", first: true }])
  })

  it("没有章节标题的整本书按段落切成几页，目录只指向第一页", () => {
    const text = Array.from({ length: 50 }, (_, i) => `第${i}段${"字".repeat(20)}`).join("\n")
    const pages = paginate([{ title: "正文", text }], 200)
    expect(pages.length).toBeGreaterThan(3)
    expect(pages.every((p) => p.text.length <= 200)).toBe(true)
    expect(pages.map((p) => p.first)).toEqual(pages.map((_, i) => i === 0))
    expect(pages.map((p) => p.text).join("\n")).toBe(text)
    const book = txtBook(text, "长.txt")
    expect(book.toc).toHaveLength(1)
  })

  it("整本书没有换行时按字数硬切", () => {
    const pages = paginate([{ title: "正文", text: "字".repeat(450) }], 200)
    expect(pages.map((p) => p.text.length)).toEqual([200, 200, 50])
  })
})