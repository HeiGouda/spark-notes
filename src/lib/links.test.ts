import { describe, expect, it } from "vitest";
import { linkCandidates, linkDisplay, resolveLink } from "./links";

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
      { label: "上线流程", detail: "工作", value: "上线流程" },
      { label: "上线流程", detail: "流程图 · 工作", value: "上线流程.flow" },
    ]);
    expect(linkDisplay("上线流程.flow")).toEqual({ label: "上线流程", kind: "flow" });
    expect(linkDisplay("周报")).toEqual({ label: "周报", kind: null });
  });
});

describe("linkCandidates", () => {
  it("同名笔记写路径，唯一的写名字，排除当前笔记", () => {
    const c = linkCandidates("周", all, "周报.md");
    expect(c.map((x) => x.value)).toEqual(["a/周报", "b/c/周报"]);
    expect(linkCandidates("项", all)[0]).toEqual({ label: "项目", detail: "工作", value: "项目" });
  });
});
