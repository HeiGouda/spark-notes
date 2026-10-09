import { describe, expect, it } from "vitest";
import { parseReadingNote, readingNoteRel, renderReadingNote, toggleBookmark, withAnno } from "./anno";

const META = { book: "人类简史.epub", title: "人类简史", author: "尤瓦尔·赫拉利" };

describe("读书笔记", () => {
  it("新增一条不会改掉已经写好的想法", () => {
    const first = withAnno("", META, (doc) => {
      doc.annos.push({ id: "a1", cfi: "epubcfi(/6/2)", time: "2026-10-08T21:40:00.000Z", quote: "认知革命", note: "桌面上改过的想法", chapter: "第一章" });
    });
    const second = withAnno(first, META, (doc) => {
      doc.annos.push({ id: "a2", cfi: "epubcfi(/6/8)", time: "2026-10-09T09:30:00.000Z", quote: "八卦的工具", note: "", chapter: "第三章" });
    });
    const parsed = parseReadingNote(second);
    expect(parsed.annos.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(parsed.annos[0].note).toBe("桌面上改过的想法");
    expect(second).toContain("<!-- spark-anno a1 epubcfi(/6/2) 2026-10-08T21:40:00.000Z -->");
    expect(second).not.toContain("## 第三章");
    expect(second).not.toContain("> ");
    expect(second).not.toContain("# 人类简史");
  });

  it("删掉一条时，别的感悟还在", () => {
    const md = withAnno("", META, (doc) => {
      doc.annos.push(
        { id: "a1", cfi: "c1", time: "t1", quote: "甲", note: "", chapter: "第一章" },
        { id: "a2", cfi: "c2", time: "t2", quote: "乙", note: "留下", chapter: "第一章" },
      );
    });
    const next = withAnno(md, META, (doc) => {
      doc.annos = doc.annos.filter((a) => a.id !== "a1");
    });
    expect(parseReadingNote(next).annos.map((a) => a.note)).toEqual(["留下"]);
    expect(next).not.toContain("> 乙");
  });

  it("旧笔记里的书名、章节和摘录再保存时去掉，感悟和总结留下", () => {
    const old = `---
book: 人类简史.epub
title: 人类简史
author: 尤瓦尔·赫拉利
---

# 人类简史

## 第一章

> 认知革命
<!-- spark-anno a1 epubcfi(/6/2) 2026-10-08T21:40:00.000Z -->

桌面上改过的想法

## 总结

读完了
`;
    const doc = parseReadingNote(old);
    expect(doc.annos.map((a) => a.note)).toEqual(["桌面上改过的想法"]);
    expect(doc.summary).toBe("读完了");
    const next = renderReadingNote(doc);
    expect(next).not.toContain("# 人类简史");
    expect(next).not.toContain("## 第一章");
    expect(next).not.toContain("> 认知革命");
    expect(next).toContain("桌面上改过的想法");
    expect(next).toContain("## 总结\n\n读完了");
    const again = parseReadingNote(next);
    expect(again.annos[0].cfi).toBe("epubcfi(/6/2)");
    expect(again.summary).toBe("读完了");
  });

  it("书名相同时文件夹加序号，同一本书沿用原来的", () => {
    const existing = [{ folder: "人类简史", book: "别的.epub" }];
    expect(readingNoteRel("人类简史", "人类简史.epub", existing)).toBe("读书笔记/人类简史 (2)/人类简史 (2).md");
    expect(readingNoteRel("人类简史", "别的.epub", existing)).toBe("读书笔记/人类简史/人类简史.md");
    expect(readingNoteRel("a/b", "x.epub", [])).toBe("读书笔记/a_b/a_b.md");
  });
});

describe("书签", () => {
  it("同一个位置再点一次就取消", () => {
    const added = toggleBookmark([], { cfi: "c", label: "第三章", excerpt: "开头", fraction: 0.2, createdMs: 1 });
    expect(added).toHaveLength(1);
    expect(toggleBookmark(added, { cfi: "c", label: "第三章", excerpt: "开头", fraction: 0.2, createdMs: 2 })).toEqual([]);
  });
});
