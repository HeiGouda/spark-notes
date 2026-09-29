import { describe, expect, it } from "vitest";
import { joinFrontMatter, parseMeta, setFrontMatterTags, splitFrontMatter } from "./frontmatter";

describe("splitFrontMatter / joinFrontMatter", () => {
  const cases = [
    "---\ntags: [工作, 周报]\ncreated: 2026-09-24T15:00:00+08:00\n---\n\n正文\n",
    "---\r\ntags: a\r\n---\r\n正文\r\n",
    "\uFEFF---\ntitle: x\n---\n# 标题\n",
    "---\n---\n空的 front matter\n",
    "没有 front matter\n\n---\n\n分割线不是 front matter\n",
    "",
  ];

  it.each(cases)("拆分后原样拼回：%j", (src) => {
    const { frontMatter, body } = splitFrontMatter(src);
    expect(joinFrontMatter(frontMatter, body)).toBe(src);
  });

  it("正文里不含 front matter，其后的空行归入前缀", () => {
    const { frontMatter, body } = splitFrontMatter(cases[0]);
    expect(frontMatter).toBe("---\ntags: [工作, 周报]\ncreated: 2026-09-24T15:00:00+08:00\n---\n\n");
    expect(body).toBe("正文\n");
  });

  it("不以 --- 开头时整篇都是正文", () => {
    expect(splitFrontMatter(cases[4])).toEqual({ frontMatter: "", body: cases[4] });
  });

  it("未闭合的 --- 不当作 front matter", () => {
    const src = "---\n只是分割线\n";
    expect(splitFrontMatter(src)).toEqual({ frontMatter: "", body: src });
  });

  it("front matter 没有结尾换行时补一个换行再接正文", () => {
    expect(joinFrontMatter("---\na: 1\n---", "正文")).toBe("---\na: 1\n---\n正文");
  });
});

describe("parseMeta", () => {
  it("行内数组", () => {
    expect(parseMeta("---\ntags: [工作, \"周报\"]\ncreated: 2026-09-24T15:00:00+08:00\n---\n")).toEqual({
      tags: ["工作", "周报"],
      created: "2026-09-24",
    });
  });

  it("YAML 列表", () => {
    expect(parseMeta("---\ntags:\n  - a\n  - 'b'\n---\n").tags).toEqual(["a", "b"]);
  });

  it("逗号分隔", () => {
    expect(parseMeta("---\ntags: a, b\n---\n").tags).toEqual(["a", "b"]);
  });

  it("没有元数据", () => {
    expect(parseMeta("")).toEqual({ tags: [], created: null });
  });
});

describe("setFrontMatterTags", () => {
  it("没有 Front Matter 时新建，拼回后正文不变", () => {
    const fm = setFrontMatterTags("", ["哲学", "读书/笔记"]);
    expect(fm).toBe("---\ntags: [哲学, 读书/笔记]\n---\n\n");
    expect(splitFrontMatter(joinFrontMatter(fm, "正文\n"))).toEqual({ frontMatter: fm, body: "正文\n" });
    expect(parseMeta(fm).tags).toEqual(["哲学", "读书/笔记"]);
  });

  it("保留 BOM 和其他字段，替换行内数组", () => {
    expect(setFrontMatterTags("\uFEFF---\ntitle: x\ntags: [a]\ncreated: 2026-01-01\n---\n\n", ["a", "b"]))
      .toBe("\uFEFF---\ntitle: x\ntags: [a, b]\ncreated: 2026-01-01\n---\n\n");
  });

  it("原来是 YAML 列表时仍写成列表，保持缩进", () => {
    expect(setFrontMatterTags("---\ntags:\n  - a\n  - b\ntitle: x\n---\n", ["a"])).toBe("---\ntags:\n  - a\ntitle: x\n---\n");
  });

  it("没有 tags 时追加一行", () => {
    expect(setFrontMatterTags("---\ntitle: x\n---\n", ["a"])).toBe("---\ntitle: x\ntags: [a]\n---\n");
  });

  it("清空标签：去掉 tags；只剩空的 Front Matter 时整段去掉", () => {
    expect(setFrontMatterTags("---\ntitle: x\ntags: [a]\n---\n", [])).toBe("---\ntitle: x\n---\n");
    expect(setFrontMatterTags("\uFEFF---\ntags:\n  - a\n---\n\n", [])).toBe("\uFEFF");
    expect(setFrontMatterTags("", [])).toBe("");
  });
});
