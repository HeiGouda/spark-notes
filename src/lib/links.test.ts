import { describe, expect, it } from "vitest";
import { linkCandidates, resolveLink } from "./links";

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

describe("linkCandidates", () => {
  it("同名笔记写路径，唯一的写名字，排除当前笔记", () => {
    const c = linkCandidates("周", all, "周报.md");
    expect(c.map((x) => x.value)).toEqual(["a/周报", "b/c/周报"]);
    expect(linkCandidates("项", all)[0]).toEqual({ label: "项目", detail: "工作", value: "项目" });
  });
});
