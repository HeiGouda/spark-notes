import { describe, expect, it } from "vitest";
import { contentCandidates, linkCandidates, linkDisplay, resolveLink } from "./links";

const all = ["a/周报.md", "b/c/周报.md", "周报.md", "工作/项目.md"];

describe("resolveLink（与 Rust 端用例相同）", () => {
  it("优先同一文件夹，其次路径最短", () => {
    expect(resolveLink("周报", "a/x.md", all)).toBe("a/周报.md");
    expect(resolveLink("周报", "z/x.md", all)).toBe("周报.md");
    expect(resolveLink("b/c/周报", "x.md", all)).toBe("b/c/周报.md");
    expect(resolveLink("c/周报.md", "b/x.md", all)).toBe("b/c/周报.md");
    expect(resolveLink("项目", "x.md", all)).toBe("工作/项目.md");
    expect(resolveLink("不存在", "x.md", all)).toBeNull();
  });
});

describe("链接到图（与 Rust 端用例相同）", () => {
  const docs = ["工作/上线流程.md", "工作/上线流程.flow.mmd", "读书 导图.mind.mmd"];
  it("带 .flow / .mind 后缀的指向图，不带后缀的只指向笔记", () => {
    expect(resolveLink("上线流程.flow", "x.md", docs)).toBe("工作/上线流程.flow.mmd");
    expect(resolveLink("上线流程.flow.mmd", "x.md", docs)).toBe("工作/上线流程.flow.mmd");
    expect(resolveLink("上线流程", "x.md", docs)).toBe("工作/上线流程.md");
    expect(resolveLink("工作/上线流程.flow", "x.md", docs)).toBe("工作/上线流程.flow.mmd");
    expect(resolveLink("读书 导图", "x.md", docs)).toBeNull();
    expect(resolveLink("读书 导图.mind", "x.md", docs)).toBe("读书 导图.mind.mmd");
  });

  it("补全列表列出图，写入带后缀的名字，显示时去掉后缀", () => {
    const c = linkCandidates("上线", docs);
    expect(c).toEqual([
      { label: "上线流程", detail: "工作", value: "上线流程", path: "工作/上线流程.md" },
      { label: "上线流程", detail: "流程图 · 工作", value: "上线流程.flow", path: "工作/上线流程.flow.mmd" },
    ]);
    expect(linkDisplay("上线流程.flow")).toEqual({ label: "上线流程", kind: "flow" });
    expect(linkDisplay("周报")).toEqual({ label: "周报", kind: null });
  });
});

describe("linkCandidates", () => {
  it("同名笔记写路径，唯一的写名字，排除当前笔记", () => {
    const c = linkCandidates("周", all, "周报.md");
    expect(c.map((x) => x.value)).toEqual(["a/周报", "b/c/周报"]);
    expect(linkCandidates("项", all)[0]).toEqual({ label: "项目", detail: "工作", value: "项目", path: "工作/项目.md" });
  });
});

describe("表格簿", () => {
  const docs = ["工作/周报.book/本周.md", "工作/周报.book/路线.mind.mmd", "工作/周报.book", "读书.md", "本周.md"];

  it("[[周报.book]] 指向表格簿本身，[[周报]] 不会指向它", () => {
    expect(resolveLink("周报.book", "读书.md", docs)).toBe("工作/周报.book");
    expect(resolveLink("工作/周报.book", "读书.md", docs)).toBe("工作/周报.book");
    expect(resolveLink("周报", "读书.md", docs)).toBeNull();
  });

  it("带路径的写法和只写名字都能指向表格簿里的表", () => {
    expect(resolveLink("工作/周报.book/本周", "读书.md", docs)).toBe("工作/周报.book/本周.md");
    expect(resolveLink("路线.mind", "读书.md", docs)).toBe("工作/周报.book/路线.mind.mmd");
    // 同名的表和笔记：优先同一文件夹，其次路径最短的
    expect(resolveLink("本周", "读书.md", docs)).toBe("本周.md");
    expect(resolveLink("本周", "工作/周报.book/路线.mind.mmd", docs)).toBe("工作/周报.book/本周.md");
  });

  it("指向表格簿的链接显示成簿名", () => {
    expect(linkDisplay("周报.book")).toEqual({ label: "周报", kind: null });
    expect(linkDisplay("工作.book")).toEqual({ label: "工作", kind: null });
    expect(linkDisplay(".book")).toEqual({ label: ".book", kind: null });
  });

  it("补全里的表显示成“簿名 › 表名”，所在文件夹按表格簿算", () => {
    const sheet = linkCandidates("路线", docs).find((c) => c.path.endsWith("路线.mind.mmd"))!;
    expect(sheet).toEqual({ label: "周报 › 路线", detail: "思维导图 · 工作", value: "路线.mind", path: "工作/周报.book/路线.mind.mmd" });
    const book = linkCandidates("周报", docs).find((c) => c.path === "工作/周报.book")!;
    expect(book).toEqual({ label: "周报", detail: "表格簿 · 工作", value: "周报.book", path: "工作/周报.book" });
  });

  it("按簿名也能搜到里面的表；重名的表写成带路径的形式", () => {
    expect(linkCandidates("周报", docs).map((c) => c.path)).toContain("工作/周报.book/本周.md");
    const dup = linkCandidates("本周", docs).map((c) => c.value);
    expect(dup).toEqual(expect.arrayContaining(["本周", "工作/周报.book/本周"].map((v) => v)));
    expect(new Set(dup).size).toBe(dup.length);
  });
});

describe("contentCandidates", () => {
  it("只保留笔记库里的笔记，排除当前笔记，保持搜索结果顺序", () => {
    const docs = [...all, "工作/上线流程.flow.mmd"];
    const c = contentCandidates(["工作/项目.md", "工作/上线流程.flow.mmd", "已删除.md", "周报.md", "a/周报.md"], docs, "周报.md");
    expect(c.map((x) => x.value)).toEqual(["项目", "a/周报"]);
    expect(c[0]).toEqual({ label: "项目", detail: "工作", value: "项目", path: "工作/项目.md" });
  });
});
