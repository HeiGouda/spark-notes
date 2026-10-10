import { describe, expect, it } from "vitest";
import { READER_THEMES, isReaderFont, readerCss, tocDepth } from "./style";

describe("电子书排版样式", () => {
  const base = { palette: READER_THEMES["夜读"], size: 20, leading: "宽松" as const, font: "宋体" as const };

  it("行距、字体压过书自带的样式，底色写在 html 和 body 上", () => {
    const css = readerCss(base);
    expect(css).toContain("html, body { background: #1b1c1e !important; color: #e4e4e4 !important; }");
    expect(css).toContain("font-size: 20px !important");
    expect(css).toMatch(/p, div[^{]*\{ line-height: 2\.2 !important/);
    expect(css).toContain("\"Spark Serif\"");
  });

  it("正文两端对齐，左右留白一样宽；不压过书里用 class 写的对齐", () => {
    expect(readerCss(base)).toContain("p, li, blockquote, dd { text-align: justify; }");
  });

  it("书页只许单指拖动，不许双指缩放", () => {
    expect(readerCss(base)).toContain("html { touch-action: pan-x pan-y !important; }");
  });

  it("选了宋体、楷体时带上打包字体的 @font-face", () => {
    const files = { serif: "http://x/serif.woff2", kai: "http://x/kai.woff2" };
    const kai = readerCss({ ...base, font: "楷体", files });
    expect(kai).toContain('@font-face { font-family: "Spark Kai"; src: url("http://x/kai.woff2")');
    expect(kai).toContain('font-family: "Spark Kai"');
    expect(readerCss({ ...base, font: "书籍自带", files })).not.toContain("@font-face");
  });

  it("书籍自带字体时不改字体", () => {
    expect(readerCss({ ...base, font: "书籍自带" })).not.toContain("font-family");
  });

  it("夜读和纯黑是深色主题", () => {
    expect(READER_THEMES["夜读"].dark).toBe(true);
    expect(READER_THEMES["纯黑"].dark).toBe(true);
    expect(READER_THEMES["纸张"].dark).toBe(false);
  });

  it("只认书籍自带、宋体、楷体三种字体（旧设置里的黑体不再用）", () => {
    expect(["书籍自带", "宋体", "楷体", "黑体", 1].map(isReaderFont)).toEqual([true, true, true, false, false]);
  });

  it("目录最多缩进两级", () => {
    expect([0, 1, 2, 5, -1].map(tocDepth)).toEqual([0, 1, 2, 2, 0]);
  });
});
