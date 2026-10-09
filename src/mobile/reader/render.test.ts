// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderNote } from "./render";

const notes = ["工作/周报.md", "工作/设计/同步设计.md", "读书/原子习惯.md", "随手记.md"];
const opts = { path: "工作/周报.md", notes, resolveAsset: (rel: string) => `asset://${rel}` };
const render = (src: string) => renderNote(src, opts);

function dom(html: string) {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("双向链接", () => {
  it("能找到的链接带上目标路径，显示别名或名称和标题", () => {
    const el = dom(render("看 [[同步设计]]、[[原子习惯|这本书]] 和 [[随手记#周末]]").html);
    const links = [...el.querySelectorAll("a.wl")].map((a) => [a.textContent, a.getAttribute("data-note"), a.getAttribute("data-heading")]);
    expect(links).toEqual([
      ["同步设计", "工作/设计/同步设计.md", null],
      ["这本书", "读书/原子习惯.md", null],
      ["随手记 › 周末", "随手记.md", "周末"],
    ]);
  });

  it("目标不存在时标成缺失，记下原来的名字", () => {
    const a = dom(render("补 [[性能测试方案]]").html).querySelector("a.wl")!;
    expect(a.classList.contains("miss")).toBe(true);
    expect(a.getAttribute("data-missing")).toBe("性能测试方案");
    expect(a.hasAttribute("data-note")).toBe(false);
  });

  it("代码里的 [[...]] 和 #标签 不处理", () => {
    const el = dom(render("`[[同步设计]] #工作`\n\n```\n[[同步设计]]\n```").html);
    expect(el.querySelectorAll("a.wl, .tag")).toHaveLength(0);
    expect(el.textContent).toContain("[[同步设计]]");
  });

  it("相对路径的 Markdown 链接指向笔记，网址链接交给系统浏览器", () => {
    const el = dom(render("[设计](设计/同步设计.md) [官网](https://example.com)").html);
    const [inner, outer] = [...el.querySelectorAll("a")];
    expect(inner.getAttribute("data-note")).toBe("工作/设计/同步设计.md");
    expect(inner.hasAttribute("href")).toBe(false);
    expect(outer.getAttribute("data-external")).toBe("https://example.com");
    expect(outer.hasAttribute("href")).toBe(false);
  });

  it("带 .flow / .mind 的链接指向图，非法百分号编码不让整篇失败", () => {
    const notesWithDiagrams = [...notes, "工作/上线流程.flow.mmd", "工作/路线.mind.mmd"];
    const el = dom(renderNote("[流程](上线流程.flow) [导图](路线.mind) [坏锚点](设计/同步设计.md#%ZZ)", {
      ...opts,
      notes: notesWithDiagrams,
    }).html);
    const links = [...el.querySelectorAll("a")].map((a) => [a.getAttribute("data-note"), a.getAttribute("data-heading")]);
    expect(links).toEqual([
      ["工作/上线流程.flow.mmd", null],
      ["工作/路线.mind.mmd", null],
      ["工作/设计/同步设计.md", "%ZZ"],
    ]);
  });
});

describe("标题和大纲", () => {
  it("标题按顺序编号，大纲带层级和纯文字", () => {
    const r = render("# 第 39 周\n\n## 本周 **完成**\n\n### 细节 [[同步设计]]\n\n正文");
    expect(r.headings).toEqual([
      { level: 1, text: "第 39 周", id: "h-0" },
      { level: 2, text: "本周 完成", id: "h-1" },
      { level: 3, text: "细节 同步设计", id: "h-2" },
    ]);
    expect(dom(r.html).querySelector("h2")?.id).toBe("h-1");
  });
});

describe("文件头和标签", () => {
  it("文件头不显示，标签合并文件头和正文里的", () => {
    const r = render("---\ntags: [工作, 周报]\n---\n\n正文 #周报 #同步 结束");
    expect(r.tags).toEqual(["工作", "周报", "同步"]);
    const el = dom(r.html);
    expect(el.textContent).not.toContain("tags:");
    expect([...el.querySelectorAll(".tag")].map((t) => t.textContent)).toEqual(["#周报", "#同步"]);
  });
});

describe("图片", () => {
  it("相对路径按笔记所在文件夹换成本地地址，网址图片原样保留", () => {
    const el = dom(render("![架构](周报.assets/架构图.png)\n\n![](../assets/a.png)\n\n![](https://example.com/b.png)").html);
    expect([...el.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([
      "asset://工作/周报.assets/架构图.png",
      "asset://assets/a.png",
      "https://example.com/b.png",
    ]);
  });
});

describe("其他", () => {
  it("任务列表显示成不能点的勾选框", () => {
    const boxes = dom(render("- [x] 已完成\n- [ ] 未完成\n- 普通").html).querySelectorAll("input[type=checkbox]");
    expect([...boxes].map((b) => (b as HTMLInputElement).checked)).toEqual([true, false]);
    expect([...boxes].every((b) => (b as HTMLInputElement).disabled)).toBe(true);
  });

  it("笔记里的 HTML 按文字显示，不会执行", () => {
    const el = dom(render('<img src=x onerror="alert(1)"> <b>粗</b>').html);
    expect(el.querySelector("img, b")).toBeNull();
    expect(el.textContent).toContain("<b>粗</b>");
  });
});

describe("读书笔记", () => {
  it("记位置的注释不显示，引用和想法照常显示", () => {
    const html = render("## 第六章\n\n> 古匣子之内，一枚药丸\n<!-- spark-anno n1 epubcfi(/6/14!/4,/2,/8/1:40) 2026-10-09T06:33:37.493Z -->\n\n八卦是协作的基础\n").html;
    expect(html).not.toContain("spark-anno");
    expect(html).not.toContain("epubcfi");
    const el = dom(html);
    expect(el.querySelector("blockquote")?.textContent?.trim()).toBe("古匣子之内，一枚药丸");
    expect(el.textContent).toContain("八卦是协作的基础");
  });
});