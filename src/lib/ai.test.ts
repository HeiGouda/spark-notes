import { describe, expect, it } from "vitest";
import {
  checkProtected,
  cleanCommitMessage,
  describeIssue,
  instructionMessages,
  protectedSummary,
  summaryBlocks,
  summaryQuote,
  unwrapFence,
} from "./ai";

const NOTE = [
  "## 核心判断",
  "见 [[编辑器选型]] 和 [[性能指标|指标]]。",
  "![图](WebDAV 同步设计.assets/a.png) [附件](WebDAV 同步设计.assets/b.pdf) [官网](https://a.com)",
  "```rust",
  "fn main() {}",
  "```",
].join("\n");

describe("AI 整理结构的核对", () => {
  it("只调整结构时核对通过", () => {
    const after = NOTE.replace("## 核心判断", "## 核心\n\n### 判断");
    expect(checkProtected(NOTE, after)).toEqual([]);
    expect(protectedSummary(NOTE)).toBe("2 个双向链接、1 张图片、1 个附件链接、1 个代码块与原文一致");
  });

  it("缺少双向链接时报告缺了哪个", () => {
    const after = NOTE.replace("和 [[性能指标|指标]]", "");
    const issues = checkProtected(NOTE, after);
    expect(issues).toHaveLength(1);
    expect(describeIssue(issues[0])).toBe("双向链接由 2 个变成 1 个，缺少 [[性能指标|指标]]");
  });

  it("代码块内容被改动也算不一致；网址链接不算附件", () => {
    const issues = checkProtected(NOTE, NOTE.replace("fn main() {}", "fn main() { }").replace("https://a.com", "https://b.com"));
    expect(issues.map((i) => i.label)).toEqual(["代码块"]);
    expect(describeIssue(issues[0])).toContain("代码块内容有改动");
  });

  it("代码块里的 [[...]] 不当作双向链接", () => {
    expect(protectedSummary("```\n[[不是链接]]\n```")).toBe("1 个代码块与原文一致");
  });
});

describe("结果处理", () => {
  it("去掉整段代码块包裹", () => {
    expect(unwrapFence("```markdown\n# 标题\n正文\n```")).toBe("# 标题\n正文");
    expect(unwrapFence("  正文  ")).toBe("正文");
  });

  it("提交说明只取第一行并去掉引号", () => {
    expect(cleanCommitMessage("“完善同步规则与冲突处理”\n\n说明……")).toBe("完善同步规则与冲突处理");
  });

  it("总结按段落与要点显示，插入时写成引用块", () => {
    const text = "这篇笔记设计了同步方案。\n\n- **三方比较**\n- 冲突保留两份";
    expect(summaryBlocks(text)).toEqual([
      { kind: "p", text: "这篇笔记设计了同步方案。" },
      { kind: "li", text: "三方比较" },
      { kind: "li", text: "冲突保留两份" },
    ]);
    expect(summaryQuote(text)).toBe("> 这篇笔记设计了同步方案。\n>\n> - **三方比较**\n> - 冲突保留两份");
  });

  it("AI 指令可以不附带笔记", () => {
    expect(instructionMessages("写个提纲", null)[1].content).not.toContain("<note>");
    expect(instructionMessages("续写", "正文")[1].content).toContain("<note>\n正文\n</note>");
  });
});
