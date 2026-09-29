import { describe, expect, it } from "vitest";
import { docKind, docName, isDiagram, splitDoc } from "./doctype";

describe("doctype", () => {
  it("按扩展名识别三种文件，不区分大小写", () => {
    expect(splitDoc("工作/周报.md")).toEqual({ stem: "工作/周报", kind: "note" });
    expect(docKind("a.MD")).toBe("note");
    expect(docKind("工作/上线流程.flow.mmd")).toBe("flow");
    expect(docKind("路线.Mind.MMD")).toBe("mind");
    expect(docKind("x.mind.md")).toBe("note");
    expect(docKind("x.mmd")).toBeNull();
    expect(docKind("d/.flow.mmd")).toBeNull();
    expect(isDiagram("a.flow.mmd")).toBe(true);
    expect(isDiagram("a.md")).toBe(false);
  });

  it("显示名称去掉整个扩展名", () => {
    expect(docName("工作/上线流程.flow.mmd")).toBe("上线流程");
    expect(docName("读书 导图.mind.mmd")).toBe("读书 导图");
    expect(docName("周报.md")).toBe("周报");
    expect(docName("d/img.png")).toBe("img.png");
  });
});
