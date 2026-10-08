import { describe, expect, it } from "vitest";
import {
  addFlowEdge, addFlowNode, copyFragment, fragmentToText, hasPositions, parseFlow, pasteFragment, reconnectEdge, removeFlowNode, serializeFlow,
  shiftBends, textToFragment, type FlowDoc,
} from "./flowchart";

function ok(text: string): FlowDoc {
  const r = parseFlow(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.doc;
}

const edges = (doc: FlowDoc) => doc.edges.map((e) => `${e.from}${{ arrow: "->", line: "-", dotted: "~>", thick: "=>" }[e.style]}${e.to}${e.label ? `:${e.label}` : ""}`);

describe("parseFlow", () => {
  it("空文件是空白的上到下流程图", () => {
    const doc = ok("");
    expect(doc.dir).toBe("TD");
    expect(doc.nodes).toEqual([]);
  });

  it("四种形状、四种连线、两种连线文字写法、连续连线和分号", () => {
    const doc = ok(`graph LR
  start(开始) --> commit[提交代码]
  commit --> test{测试通过？}
  test -->|是| done((结束))
  test -- 否 --> fix["修复 (bug)"]; fix -.-> commit
  a --- b ==> c
  x -. 备注 .-> y
`);
    expect(doc.dir).toBe("LR");
    expect(doc.nodes.map((n) => [n.id, n.text, n.shape])).toEqual([
      ["start", "开始", "round"], ["commit", "提交代码", "rect"], ["test", "测试通过？", "diamond"],
      ["done", "结束", "circle"], ["fix", "修复 (bug)", "rect"], ["a", "a", "rect"], ["b", "b", "rect"],
      ["c", "c", "rect"], ["x", "x", "rect"], ["y", "y", "rect"],
    ]);
    expect(edges(doc)).toEqual(["start->commit", "commit->test", "test->done:是", "test->fix:否", "fix~>commit", "a-b", "b=>c", "x~>y:备注"]);
  });

  it("TB 视为 TD，没写方向也是 TD；后面的定义覆盖前面的文字", () => {
    expect(ok("flowchart TB\n  A").dir).toBe("TD");
    expect(ok("flowchart\n  A").dir).toBe("TD");
    expect(ok("flowchart TD\n  A --> B\n  A[开始]\n").nodes[0].text).toBe("开始");
  });

  it("引号里的实体解码", () => {
    expect(ok('flowchart TD\n  A["他说 #quot;好#quot;"] -->|"a|b"| B').nodes[0].text).toBe('他说 "好"');
    expect(ok('flowchart TD\n  A -->|"a|b"| B').edges[0].label).toBe("a|b");
  });

  it("不支持的写法逐条列出行号", () => {
    const r = parseFlow(`flowchart LR
  subgraph 前端
    ui --> store
  end
  A:::hot --> B
  A>旗帜] --> B
  A --> B & C
  A ---> B
  A --o B
  style A fill:#f96
  click A "https://x"
  A <--> B
`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.line)).toEqual([2, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(r.issues[0].message).toContain("subgraph");
    expect(r.issues[2].message).toContain(":::");
    expect(r.issues[3].message).toContain("节点形状");
    expect(r.issues[4].message).toContain("&");
    expect(r.issues[5].message).toContain("连线写法");
  });

  it("end、class 等词当节点编号时不算子图或样式语句（AI 生成的流程图常用 end 做结束节点）", () => {
    const doc = ok(`flowchart TD
  start([开始]) --> end([结束])
  end --> style
  class --> style
  style[样式]
  class[类]
`);
    expect(doc.nodes.map((n) => n.id)).toEqual(["start", "end", "style", "class"]);
    expect(edges(doc)).toEqual(["start->end", "end->style", "class->style"]);
    const bad = parseFlow("flowchart TD\n  A --> B\n  end\n  class A hot\n  style A fill:#f96\n  direction LR\n  click A \"x\"\n  linkStyle 0 stroke:red\n  classDef hot fill:red\n");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.line)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  it("写出时把关键字 end 改成 end_，重新读回内容不变", () => {
    const doc = ok("flowchart TD\n  s([开始]) --> end([结束])\n  end --> s\n  end_[占用]\n");
    const text = serializeFlow(doc);
    expect(text).not.toMatch(/(^|\s)end(\s|\(|\[|$)/m);
    const again = ok(text);
    expect(again.nodes.map((n) => [n.id, n.text])).toEqual([["s", "开始"], ["end__", "结束"], ["end_", "占用"]]);
    expect(edges(again)).toEqual(["s->end__", "end__->s"]);
    expect(serializeFlow(again)).toBe(text);
  });

  it("开头不是 flowchart 时无法识别", () => {
    const r = parseFlow("sequenceDiagram\n  A->>B: hi\n");
    expect(r.ok).toBe(false);
  });
});

describe("serializeFlow", () => {
  it("先写节点定义再写连线，编号和顺序不变，注释保留", () => {
    const src = `%% 上线流程
graph TB
  %% 起点
  start(开始) --> commit[提交代码]
  commit --> test{测试通过？}
  test -- 否 --> commit
  %% 结尾
`;
    const out = serializeFlow(ok(src));
    expect(out).toBe(`%% 上线流程
flowchart TD
  %% 起点
  start(开始)
  commit[提交代码]
  test{测试通过？}
  start --> commit
  commit --> test
  test -->|否| commit
  %% 结尾
`);
    expect(serializeFlow(ok(out))).toBe(out);
  });

  it("需要时加引号，孤立节点也写出来", () => {
    const doc = ok("flowchart LR\n  A --> B\n  C");
    doc.nodes[0].text = '修复 (bug) "紧急"';
    doc.nodes[1].text = "end";
    doc.edges[0].label = "a|b";
    expect(serializeFlow(doc)).toBe(`flowchart LR
  A["修复 (bug) #quot;紧急#quot;"]
  B["end"]
  C
  A -->|"a|b"| B
`);
    expect(ok(serializeFlow(doc)).nodes.map((n) => n.text)).toEqual(['修复 (bug) "紧急"', "end", "C"]);
  });
});

describe("扩展注释 %% spark:", () => {
  it("配色方案、主题间距写在第一行，节点样式写在节点定义前一行；流程图不认结构", () => {
    const src = `flowchart TD
  %% spark: scheme=blue spacing=compact layout=down
  start(开始)
  %% 注释
  %% spark: bg=apricot border=#c8a33a bold=1
  commit[提交代码]
  start --> commit
`;
    const doc = ok(src);
    expect(doc.canvas).toEqual({ scheme: "blue", spacing: "compact" });
    expect(doc.nodes[1].style).toEqual({ bg: "apricot", border: "#c8a33a", bold: true });
    expect(doc.nodes[1].comments).toEqual(["%% 注释"]);
    const out = serializeFlow(doc);
    expect(out).toBe(src.replace(" layout=down", ""));
    expect(serializeFlow(ok(out))).toBe(out);
  });

  it("有样式的节点即使只在连线里出现，也单独写一行定义", () => {
    const doc = ok("flowchart LR\n  A --> B\n");
    doc.nodes[1].style = { color: "red" };
    expect(serializeFlow(doc)).toBe("flowchart LR\n  %% spark: color=red\n  B\n  A --> B\n");
    expect(ok(serializeFlow(doc)).nodes.find((n) => n.id === "B")?.style).toEqual({ color: "red" });
  });
});

describe("九种形状、位置、文字、走线", () => {
  it("读出九种形状，写回格式不变", () => {
    const src = `flowchart TD
  a[矩形]
  b(圆角)
  c([胶囊])
  d((圆))
  e{菱形}
  f{{六边形}}
  g[/平行四边形/]
  h[/梯形\\]
  i[(圆柱)]
`;
    const doc = ok(src);
    expect(doc.nodes.map((n) => n.shape)).toEqual(["rect", "round", "stadium", "circle", "diamond", "hexagon", "parallelogram", "trapezoid", "cylinder"]);
    expect(doc.nodes.map((n) => n.text)).toEqual(["矩形", "圆角", "胶囊", "圆", "菱形", "六边形", "平行四边形", "梯形", "圆柱"]);
    expect(serializeFlow(doc)).toBe(src);
  });

  it("位置、文字标记写在节点前一行，走线写在连线前一行，默认直角不写", () => {
    const src = `flowchart LR
  %% spark: x=120 y=-40 bold=1
  a[开始]
  %% spark: x=300 y=80 text
  t[这是一段说明]
  b(结束)
  %% spark: route=round
  a --> b
  a -.-> t
`;
    const doc = ok(src);
    expect(doc.nodes[0]).toMatchObject({ x: 120, y: -40, style: { bold: true } });
    expect(doc.nodes[1]).toMatchObject({ x: 300, y: 80, isText: true });
    expect(doc.nodes[2].x).toBeUndefined();
    expect(doc.edges.map((e) => e.route)).toEqual(["round", undefined]);
    expect(hasPositions(doc)).toBe(false);
    expect(serializeFlow(doc)).toBe(src);
    doc.nodes[2].x = 10.4;
    doc.nodes[2].y = 20.6;
    doc.edges[1].route = "straight";
    const out = serializeFlow(doc);
    expect(out).toContain("  %% spark: x=10 y=21\n  b(结束)\n");
    expect(out).toContain("  %% spark: route=straight\n  a -.-> t\n");
    expect(serializeFlow(ok(out))).toBe(out);
  });

  it("手动大小写在节点前一行，接边写在连线前一行", () => {
    const src = "flowchart TD\n  %% spark: x=0 y=0 w=160 h=60\n  a[开始]\n  %% spark: x=0 y=200\n  b[结束]\n  %% spark: route=round out=bottom in=left\n  a --> b\n";
    const doc = ok(src);
    expect(doc.nodes[0]).toMatchObject({ w: 160, h: 60 });
    expect(doc.edges[0]).toMatchObject({ route: "round", fromSide: "bottom", toSide: "left" });
    expect(serializeFlow(doc)).toBe(src);
  });

  it("手动拖过的走线写成 via；两端接边没固定时忽略", () => {
    const src = "flowchart TD\n  %% spark: out=bottom in=bottom via=190\n  a --> b\n  %% spark: out=right in=left via=120,300\n  b --> c\n";
    const doc = ok(src);
    expect(doc.edges.map((e) => e.bends)).toEqual([[190], [120, 300]]);
    expect(serializeFlow(doc)).toBe(src);
    expect(ok("flowchart TD\n  %% spark: out=bottom via=190\n  a --> b\n").edges[0].bends).toBeUndefined();
    expect(ok("flowchart TD\n  %% spark: out=bottom in=top via=1,x\n  a --> b\n").edges[0].bends).toBeUndefined();
  });

  it("多行文字写成 <br>，读回还原；没加引号的 <br> 也认", () => {
    const doc = ok("flowchart TD\n  a[第一行<br>第二行]\n");
    expect(doc.nodes[0].text).toBe("第一行\n第二行");
    expect(serializeFlow(doc)).toContain('a["第一行<br>第二行"]');
    expect(ok(serializeFlow(doc)).nodes[0].text).toBe("第一行\n第二行");
  });

  it("复制粘贴：换新编号、带上选中节点之间的连线；外部多行文字每行一个节点", () => {
    const doc = ok("flowchart TD\n  %% spark: x=0 y=0\n  a\n  %% spark: x=0 y=100\n  b\n  %% spark: x=200 y=0\n  c\n  a --> b\n  b --> c\n");
    const frag = copyFragment(doc, ["a", "b"]);
    expect(frag.edges).toHaveLength(1);
    expect(fragmentToText(frag)).toBe("a\nb");
    const ids = pasteFragment(doc, frag, { at: { x: 500, y: 500 } });
    expect(ids).toEqual(["n1", "n2"]);
    expect(doc.nodes.slice(-2).map((n) => [n.x, n.y])).toEqual([[500, 500], [500, 600]]);
    expect(doc.edges[doc.edges.length - 1]).toMatchObject({ from: "n1", to: "n2" });
    pasteFragment(doc, frag, { offset: 20 });
    expect(doc.nodes[doc.nodes.length - 1]).toMatchObject({ x: 20, y: 120 });
    const t = textToFragment("- 需求\n- 开发\n\n3. 测试");
    expect(t.nodes.map((n) => [n.text, n.y])).toEqual([["需求", 0], ["开发", 70], ["测试", 140]]);
  });

  it("平行四边形和梯形的文字含斜杠时加引号", () => {
    const doc = ok("flowchart TD\n  a[/x/]\n");
    doc.nodes[0].text = "输入/输出";
    expect(serializeFlow(doc)).toContain('a[/"输入/输出"/]');
    expect(ok(serializeFlow(doc)).nodes[0].text).toBe("输入/输出");
  });
});

describe("编辑操作", () => {
  it("新节点编号接着已有的 n 编号，放在给定位置；删除节点连带删除连线", () => {
    const doc = ok("flowchart TD\n  n1 --> n3\n");
    const id = addFlowNode(doc, "diamond", "判断", { x: 10.6, y: 20 });
    expect(id).toBe("n4");
    expect(doc.nodes.map((n) => n.id)).toEqual(["n1", "n3", "n4"]);
    expect(doc.nodes[2]).toMatchObject({ x: 11, y: 20 });
    expect(addFlowNode(doc, "rect", "说明", undefined, true)).toBe("n5");
    expect(doc.nodes[3].isText).toBe(true);
    expect(addFlowEdge(doc, "n4", "n3", "dotted")).toBeTruthy();
    expect(addFlowEdge(doc, "n4", "nope", "arrow")).toBeNull();
    removeFlowNode(doc, "n3");
    expect(doc.edges).toEqual([]);
  });

  it("改接连线端点；新连线带上走线", () => {
    const doc = ok("flowchart TD\n  A --> B\n  C\n");
    expect(reconnectEdge(doc, doc.edges[0].key, "to", "C")).toBe(true);
    expect(edges(doc)).toEqual(["A->C"]);
    addFlowEdge(doc, "B", "C", "arrow", "round");
    addFlowEdge(doc, "C", "A", "arrow", "elbow");
    expect(doc.edges.map((e) => e.route)).toEqual([undefined, "round", undefined]);
  });

  it("改接端点时去掉手动走线；粘贴时手动走线跟着平移", () => {
    const doc = ok("flowchart TD\n  %% spark: x=0 y=0\n  a\n  %% spark: x=200 y=0\n  b\n  %% spark: out=bottom in=bottom via=100\n  a --> b\n");
    pasteFragment(doc, copyFragment(doc, ["a", "b"]), { offset: 20 });
    expect(doc.edges[1].bends).toEqual([120]);
    expect(shiftBends([10, 20, 30], "right", 5, 7)).toEqual([15, 27, 35]);
    reconnectEdge(doc, doc.edges[0].key, "to", "b", "left");
    expect(doc.edges[0].bends).toBeUndefined();
  });
});
