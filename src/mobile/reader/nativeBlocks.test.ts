// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { blocksFrom, findInPlain, isImageSvg, locateAnchor, offsetOfAnchor, plainOf, rangeAtOffset, rangeOfOccurrence } from "./nativeBlocks";
import { styleResolver } from "./cssHints";

describe("原生排版抽正文", () => {
  it("标题、粗体和斜体分开留在字上", () => {
    document.body.innerHTML = "<h1>第一章</h1><p>甲<strong>乙</strong><em>丙</em>丁</p>";
    expect(blocksFrom(document)).toEqual([
      { h: 1, runs: [{ t: "第一章", b: true }] },
      { runs: [{ t: "甲" }, { t: "乙", b: true }, { t: "丙", i: true }, { t: "丁" }] },
    ]);
  });

  it("段落里没有字的图单独成块", () => {
    document.body.innerHTML = '<p>前</p><div><img src="pic.png"></div><p>后</p>';
    expect(blocksFrom(document)).toEqual([{ runs: [{ t: "前" }] }, { img: "pic.png" }, { runs: [{ t: "后" }] }]);
  });

  it("夹在字里的小图跟着字走，不断段、不占字符", () => {
    document.body.innerHTML = '<p><img class="height-1em" src="dot.png">习惯是重复的行为。</p><p>下一段</p>';
    expect(blocksFrom(document)).toEqual([
      { runs: [{ t: "", im: "dot.png" }, { t: "习惯是重复的行为。" }] },
      { runs: [{ t: "下一段" }] },
    ]);
    expect(plainOf(document)).toBe("习惯是重复的行为。\n下一段\n");
    const second = document.querySelectorAll("p")[1]!;
    expect(offsetOfAnchor(document, () => second)).toBe("习惯是重复的行为。\n".length);
    expect(rangeAtOffset(document, 2)?.startContainer.textContent).toBe("习惯是重复的行为。");
  });

  it("只包着一张图的 SVG 当普通图排", () => {
    const xml = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><div><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><image width="10" height="10" xlink:href="../image/p.jpg"/></svg></div></body></html>',
      "application/xhtml+xml",
    );
    const svg = xml.querySelector("svg")!;
    expect(isImageSvg(svg)).toBe(true);
    expect(blocksFrom(xml)).toEqual([{ img: "../image/p.jpg" }]);
  });

  it("mobi 只有 recindex 的图也留下来", () => {
    document.body.innerHTML = '<p>前</p><img recindex="00003"><p>后</p>';
    expect(blocksFrom(document)[1]).toEqual({ img: "recindex:00003" });
  });

  it("XHTML 的小写标签照样分段、认标题", () => {
    const xml = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><h3>第一卷 01</h3><p>甲。</p><p>乙<br/>丙</p><img src="a.jpg"/></body></html>',
      "application/xhtml+xml",
    );
    expect(blocksFrom(xml)).toEqual([
      { h: 3, runs: [{ t: "第一卷 01", b: true }] },
      { runs: [{ t: "甲。" }] },
      { runs: [{ t: "乙" }, { t: "\n" }, { t: "丙" }] },
      { img: "a.jpg" },
    ]);
    expect(plainOf(xml)).toBe("第一卷 01\n甲。\n乙\n丙\n");
  });

  it("居中、右对齐的段落带上对齐", () => {
    document.body.innerHTML = '<p align="center">＊＊＊</p><center>中</center><p style="text-align: right">落款</p>';
    expect(blocksFrom(document)).toEqual([
      { a: "c", runs: [{ t: "＊＊＊" }] },
      { a: "c", runs: [{ t: "中" }] },
      { a: "r", runs: [{ t: "落款" }] },
    ]);
  });

  it("按书的样式表认出居中的大字标题", () => {
    document.body.innerHTML = '<p class="t">第三章 归来</p><p class="c">正文第一段。</p>';
    const styleOf = styleResolver([".t { text-align: center; font-size: 1.5em; } .c { text-indent: 2em; }"]);
    expect(blocksFrom(document, styleOf)).toEqual([
      { h: 2, a: "c", runs: [{ t: "第三章 归来", b: true }] },
      { runs: [{ t: "正文第一段。" }] },
    ]);
  });

  it("章首单独一行的“第几章”当标题", () => {
    document.body.innerHTML = "<p>第十二章 风起</p><p>正文。</p><p>第十三章 不在章首</p>";
    const blocks = blocksFrom(document);
    expect(blocks[0]).toEqual({ h: 2, runs: [{ t: "第十二章 风起", b: true }] });
    expect(blocks[2]).toEqual({ runs: [{ t: "第十三章 不在章首" }] });
  });

  it("源码换行收成空格，br 只断一次行", () => {
    document.body.innerHTML = "<div>第一句。<br/>\n第二句。\n\n第三句。</div>";
    const block = blocksFrom(document)[0];
    const text = block && "runs" in block ? block.runs.map((run) => run.t).join("") : "";
    expect(text).toBe("第一句。\n第二句。 第三句。");
  });

  it("预格式文本保留换行", () => {
    document.body.innerHTML = "<pre>甲\n乙</pre>";
    expect(blocksFrom(document)).toEqual([{ pre: true, runs: [{ t: "甲\n乙" }] }]);
  });

  it("保留空白的段落不参与首行缩进", () => {
    document.body.innerHTML = '<p style="white-space: pre-wrap">甲\n乙</p><p>丙</p>';
    expect(blocksFrom(document)).toEqual([{ pre: true, runs: [{ t: "甲\n乙" }] }, { runs: [{ t: "丙" }] }]);
  });

  it("没有正文时是空的", () => {
    document.body.innerHTML = "<p>  </p>";
    expect(blocksFrom(document)).toEqual([]);
  });

  it("目录锚点落在这一节正文的开头", () => {
    document.body.innerHTML = '<h1 id="a">第一章</h1><p>正文</p><h2 id="b">第二章</h2>';
    const b = document.getElementById("b")!;
    expect(offsetOfAnchor(document, () => b)).toBe("第一章\n正文\n".length);
  });

  it("字符偏移能回到这一节的开头", () => {
    document.body.innerHTML = '<h1 id="a">第一章</h1><p>正文</p><h2 id="b">第二章</h2>';
    const offset = "第一章\n正文\n".length;
    const range = rangeAtOffset(document, offset);
    expect(range?.startContainer.textContent).toBe("第二章");
    expect(offsetOfAnchor(document, () => range)).toBe(offset);
  });

  it("章首的字符偏移是这一章的第一个字", () => {
    document.body.innerHTML = "<h1>第一章</h1><p>正文</p>";
    const range = rangeAtOffset(document, 0);
    expect(range?.startContainer.textContent).toBe("第一章");
    expect(range?.startOffset).toBe(0);
  });

  it("正文和锚点用同一套偏移，搜索能落到这一节", () => {
    document.body.innerHTML = '<h1 id="a">第一章</h1><p>正文</p><h2 id="b">第二章</h2>';
    const plain = plainOf(document);
    const offset = offsetOfAnchor(document, () => document.getElementById("b")!);
    expect(plain.indexOf("第二章")).toBe(offset);
    expect(findInPlain(plain, "第二章")).toEqual([{ offset, excerpt: expect.stringContaining("第二章") }]);
    expect(findInPlain(plain, "没有")).toEqual([]);
  });

  it("章首锚点是 0", () => {
    document.body.innerHTML = "<h1>第一章</h1><p>正文</p>";
    expect(offsetOfAnchor(document, () => 0)).toBe(0);
  });

  it("mobi 的 filepos 能落到这一节", () => {
    document.body.innerHTML = "<p>前文</p><a id=\"filepos120\"></a><p>第三章</p>";
    expect(locateAnchor(document, "filepos:120", () => null)).toBe("前文\n".length);
  });

  it("片段只有 name 时也能落到这一节", () => {
    document.body.innerHTML = '<h1 id="a">第一章</h1><p>正文</p><h2><a name="b"></a>第二章</h2>';
    expect(locateAnchor(document, "book.xhtml#b", () => null)).toBe("第一章\n正文\n".length);
  });

  it("按第几次出现还原选区", () => {
    document.body.innerHTML = "<p>第一句。第二句。</p><p>第二句。</p>";
    const range = rangeOfOccurrence(document, "第二句。", 1);
    expect(range?.toString()).toBe("第二句。");
    expect(range?.startContainer.parentElement?.tagName).toBe("P");
    expect(range?.startContainer.parentElement?.textContent).toBe("第二句。");
  });
});
