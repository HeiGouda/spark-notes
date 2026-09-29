import { describe, expect, it } from "vitest";
import { parseFlow, type FlowDoc } from "./flowchart";
import { arrangeMessages, parseArrange } from "./aiArrange";
import { arrange, autoPositions } from "./flowLayout";

function ok(text: string): FlowDoc {
  const r = parseFlow(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.doc;
}

const SRC = "flowchart TD\n  a[开始] --> b{通过？}\n  b -->|是| c[上线]\n  b -->|否| d[修复]\n  d --> a\n";

describe("AI 整理", () => {
  it("发给 AI 的内容包含节点编号、文字、形状和连线文字", () => {
    const [sys, user] = arrangeMessages(ok(SRC));
    expect(sys.content).toContain("JSON");
    expect(user.content).toContain("b：通过？（判断）");
    expect(user.content).toContain("b -> c：是");
  });

  it("解析回复：去掉代码块和解释，不认识和重复的编号去掉，漏掉的放进最后一层", () => {
    const doc = ok(SRC);
    const plan = parseArrange('好的：\n```json\n{"direction":"lr","layers":[["a"],["b","x"],["d","c","b"]]}\n```', doc);
    expect(plan).toEqual({ dir: "LR", layers: [["a"], ["b"], ["d", "c"]] });
    expect(parseArrange('{"direction":"TB","layers":[["a","b"],["c"]]}', doc)).toEqual({ dir: "TD", layers: [["a", "b"], ["c"], ["d"]] });
  });

  it("回复无法使用时报错", () => {
    const doc = ok(SRC);
    expect(() => parseArrange("抱歉，我不能", doc)).toThrow();
    expect(() => parseArrange('{"direction":"TD"}', doc)).toThrow();
    expect(() => parseArrange('{"layers":[["a"]]}', doc)).toThrow(/漏掉/);
  });

  it("按 AI 的分层和层内顺序摆放", () => {
    const doc = ok(SRC);
    const p = autoPositions(doc, "TD", [["a"], ["b"], ["d", "c"]]);
    expect(p.get("b")!.y).toBeGreaterThan(p.get("a")!.y);
    expect(p.get("c")!.y).toBe(p.get("d")!.y);
    expect(p.get("d")!.x).toBeLessThan(p.get("c")!.x);
    arrange(doc, "LR", [["a"], ["b"], ["c", "d"]]);
    expect(doc.dir).toBe("LR");
    const [a, b] = doc.nodes;
    expect(b.x!).toBeGreaterThan(a.x!);
  });
});
