import { describe, expect, it } from "vitest";
import { MAX_FLOW_NODES, aiFlowTitle, flowFileName, flowGenMessages, flowReviseMessages, parseAiFlow, plainFlowText } from "./flowGen";

const REPLY = [
  "好的，下面是流程图：",
  "标题：请假审批流程",
  "flowchart LR",
  "  start([提交申请]) --> lead[组长审批]",
  "  lead --> ok{通过？}",
  "  ok -->|是| done([结束])",
  "  ok -->|否| start",
  "  style start fill:#f00",
  "  这一行不是语句",
].join("\n");

describe("AI 生成流程图", () => {
  it("解析标题、方向和语句；无法识别的行跳过并计数，开头的说明文字不算", () => {
    const r = parseAiFlow(REPLY, "auto");
    expect(r.title).toBe("请假审批流程");
    expect(r.doc.dir).toBe("LR");
    expect(r.doc.nodes.map((n) => [n.id, n.shape, n.text])).toEqual([
      ["start", "stadium", "提交申请"], ["lead", "rect", "组长审批"], ["ok", "diamond", "通过？"], ["done", "stadium", "结束"],
    ]);
    expect(r.doc.edges.map((e) => `${e.from}>${e.to}:${e.label}`)).toEqual(["start>lead:", "lead>ok:", "ok>done:是", "ok>start:否"]);
    expect(r.skipped).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it("按形状上色，全部节点排好位置；指定方向时不用 AI 给的方向", () => {
    const r = parseAiFlow(REPLY, "TD");
    expect(r.doc.dir).toBe("TD");
    expect(r.doc.nodes.map((n) => n.style)).toEqual([
      { bg: "mint", border: "green" }, undefined, { bg: "apricot", border: "orange" }, { bg: "mint", border: "green" },
    ]);
    expect(r.doc.nodes.every((n) => n.x !== undefined && n.y !== undefined)).toBe(true);
    const ys = r.doc.nodes.map((n) => n.y!);
    expect(ys[1]).toBeGreaterThan(ys[0]);
  });

  it("生成中只解析完整的行；没有 flowchart 开头也能认出语句；代码块包裹去掉", () => {
    const partial = parseAiFlow("标题：上线\nflowchart TD\n  a[开发] --> b[测", "auto", false);
    expect(partial.doc.nodes).toHaveLength(0);
    expect(parseAiFlow("```mermaid\na[开发] --> b[测试]\n```", "auto").doc.nodes).toHaveLength(2);
  });

  it("超过节点上限时截断", () => {
    const lines = Array.from({ length: MAX_FLOW_NODES + 5 }, (_, i) => `  n${i}[步骤${i}] --> n${i + 1}[步骤${i + 1}]`);
    const r = parseAiFlow(`flowchart TD\n${lines.join("\n")}`, "auto");
    expect(r.doc.nodes).toHaveLength(MAX_FLOW_NODES);
    expect(r.truncated).toBe(true);
  });

  it("标题与文件名", () => {
    expect(aiFlowTitle("标题：《报销流程》\nflowchart TD")).toBe("报销流程");
    expect(aiFlowTitle("flowchart TD\n标题：晚了")).toBe("");
    expect(flowFileName("A/B: 流程?")).toBe("AB 流程");
    expect(flowFileName("")).toBe("流程图");
    expect(flowFileName("CON")).toBe("CON 流程图");
    expect(flowFileName("aux.1")).toBe("aux.1 流程图");
  });

  it("提示词：自动方向由 AI 决定，固定方向写死；修改时带上原始描述、当前这一版和意见，不带位置和样式", () => {
    expect(flowGenMessages("请假", "auto")[0].content).toContain("flowchart TD（上到下）或 flowchart LR");
    expect(flowGenMessages("请假", "LR")[0].content).toContain("第二行固定写：flowchart LR");
    const current = parseAiFlow(REPLY, "auto");
    const user = flowReviseMessages("请假", "auto", current, "审批改成两级")[1].content;
    expect(user).toContain("原始描述：\n请假");
    expect(user).toContain("标题：请假审批流程\nflowchart LR");
    expect(user).toContain("修改意见：\n审批改成两级");
    expect(user).not.toContain("spark");
    expect(plainFlowText(current.doc)).not.toContain("%%");
  });
});
