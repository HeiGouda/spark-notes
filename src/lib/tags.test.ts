import { describe, expect, it } from "vitest";
import { inlineTags, mergeTags, parseTagInput } from "./tags";

describe("inlineTags", () => {
  it("与 Rust 端规则一致", () => {
    expect(inlineTags("# 标题\n#层级/子/ 与#不是 #123 #v2 `#代码` a#b\n```\n#围栏\n```\n")).toEqual(["层级/子", "v2"]);
  });
  it("合并去重", () => {
    expect(mergeTags(["工作", "A"], ["a", "新"])).toEqual(["工作", "A", "新"]);
  });
  it("parseTagInput：空格或逗号分隔，去掉开头的 #，挑出不合规则的", () => {
    expect(parseTagInput("#哲学 读书/笔记/，v2、123 a:b")).toEqual({ tags: ["哲学", "读书/笔记", "v2"], invalid: ["123", "a:b"] });
  });
});
