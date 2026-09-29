import { describe, expect, it } from "vitest";
import {
  addChild, addParent, addSibling, addSiblingBefore, addSummary, cleanMindText, cloneTree, countMind, emptyMind, findMind, isSummaryNode,
  mindTextOut, moveMany, moveMind, parentOf, parseAiMind, parseMind, removeMind, serializeMind, textToTrees, treesToText, type MindDoc,
} from "./mindmap";

function ok(text: string, root = "根"): MindDoc {
  const r = parseMind(text, root);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.doc;
}

const texts = (doc: MindDoc) => {
  const out: string[] = [];
  const walk = (n: MindDoc["root"], d: number) => {
    out.push(`${"-".repeat(d)}${n.text}`);
    n.children.forEach((c) => walk(c, d + 1));
  };
  walk(doc.root, 0);
  for (const s of doc.root.summaries ?? []) walk(s.node, 1);
  return out;
};

describe("parseMind", () => {
  it("空文件按只有根节点的图处理，根节点文字为文件名", () => {
    const doc = ok("", "上线计划");
    expect(doc.root.text).toBe("上线计划");
    expect(doc.root.children).toEqual([]);
    expect(ok("  \n\n").root.text).toBe("根");
  });

  it("按缩进建立层级，父节点是前面最近的缩进更小的节点", () => {
    const doc = ok("mindmap\n  Rust\n    基础\n        所有权\n      借用\n    并发\n");
    expect(texts(doc)).toEqual(["Rust", "-基础", "--所有权", "--借用", "-并发"]);
  });

  it("接受 Tab 缩进与空行，注释挂在下一个节点上", () => {
    const doc = ok("%% 头注释\nmindmap\n\tRust\n\n\t\t%% 说明\n\t\t基础\n\t%% 结尾\n");
    expect(doc.head).toEqual(["%% 头注释"]);
    expect(doc.root.children[0].comments).toEqual(["%% 说明"]);
    expect(doc.tail).toEqual(["%% 结尾"]);
  });

  it("不支持的写法逐条列出行号，不画图", () => {
    const r = parseMind("mindmap\n  root((中心))\n    A\n    ::icon(fa fa-book)\n    B:::urgent\n", "x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.line)).toEqual([2, 4, 5]);
    expect(r.issues[0].message).toContain("节点形状");
    expect(r.issues[1].message).toContain("图标");
    expect(r.issues[2].message).toContain("样式类");
  });

  it("不是 mindmap 开头或有两个根节点时无法识别", () => {
    const a = parseMind("flowchart TD\n  A --> B\n", "x");
    expect(a.ok).toBe(false);
    const b = parseMind("mindmap\n  A\n  B\n", "x");
    expect(b.ok || b.issues[0]).toEqual({ line: 3, message: "无法识别：思维导图只能有一个根节点" });
  });
});

describe("serializeMind", () => {
  it("固定用两个空格缩进，注释原样保留，再次解析结果相同", () => {
    const src = "%% 头\nmindmap\n\tRust\n\t\t%% 说明\n\t\t基础\n\t\t\t所有权\n\t%% 尾\n";
    const out = serializeMind(ok(src));
    expect(out).toBe("%% 头\nmindmap\n  Rust\n    %% 说明\n    基础\n      所有权\n  %% 尾\n");
    expect(serializeMind(ok(out))).toBe(out);
  });

  it("保留换行（去掉每行首尾空白和空行），空文字写成未命名，半角括号原样保留", () => {
    expect(cleanMindText(" 第一行 \n\n 第二行")).toBe("第一行\n第二行");
    expect(cleanMindText("   ")).toBe("未命名");
    expect(cleanMindText("Rust (入门)")).toBe("Rust (入门)");
  });

  it("多行文字写成 [\"第一行<br>第二行\"]，< 写成 #lt;，读回还原", () => {
    expect(mindTextOut("第一行\n第二行")).toBe('["第一行<br>第二行"]');
    expect(mindTextOut("a < b\n(c)")).toBe('["a #lt; b<br>(c)"]');
    const doc = emptyMind("根");
    addChild(doc, doc.root.id, "第一行\n第二行");
    addChild(doc, doc.root.id, "a < b\n(c)");
    expect(ok(serializeMind(doc)).root.children.map((c) => c.text)).toEqual(["第一行\n第二行", "a < b\n(c)"]);
  });

  it("含特殊字符的文字写成 [\"文字\"]，读回仍是原来的纯文字", () => {
    const texts = ["Rust (入门) [草稿] {x}", "%%不是注释", "a:::b", "::icon(x)", '他说 "好"', "C# (#quot;) 不是实体", "C# #quot; 不用引号"];
    expect(texts.map(mindTextOut)).toEqual([
      '["Rust (入门) [草稿] {x}"]',
      '["%%不是注释"]',
      '["a:::b"]',
      '["::icon(x)"]',
      '["他说 #quot;好#quot;"]',
      '["C# (#35;quot;) 不是实体"]',
      "C# #quot; 不用引号",
    ]);
    expect(mindTextOut("普通文字")).toBe("普通文字");
    const doc = emptyMind("根");
    for (const t of texts) addChild(doc, doc.root.id, t);
    const back = ok(serializeMind(doc));
    expect(back.root.children.map((c) => c.text)).toEqual(texts);
  });
});

describe("扩展注释 %% spark:", () => {
  const SRC = `mindmap
  %% spark: layout=balanced line=round scheme=fresh spacing=loose
  %% spark: bg=mint bold=1
  项目复盘
    %% 普通注释
    %% spark: bg=#dbe8d8 border=green color=ink size=l bold=1
    做得好
    待改进
    %% spark: summary=2 border=blue
    整体按期交付
      提前 3 天
    风险
`;

  it("读出整张图的设置、节点样式和概要", () => {
    const doc = ok(SRC);
    expect(doc.canvas).toEqual({ structure: "balanced", line: "round", scheme: "fresh", spacing: "loose" });
    expect(doc.root.style).toEqual({ bg: "mint", bold: true });
    const [good, bad, risk] = doc.root.children;
    expect(texts(doc)).toEqual(["项目复盘", "-做得好", "-待改进", "-风险", "-整体按期交付", "--提前 3 天"]);
    expect(good.comments).toEqual(["%% 普通注释"]);
    expect(good.style).toEqual({ bg: "#dbe8d8", border: "green", color: "ink", size: "l", bold: true });
    expect(bad.style).toBeUndefined();
    expect(risk.text).toBe("风险");
    const [s] = doc.root.summaries!;
    expect([s.from, s.to]).toEqual([good.id, bad.id]);
    expect(s.node.text).toBe("整体按期交付");
    expect(s.node.style).toEqual({ border: "blue" });
    expect(s.node.children[0].text).toBe("提前 3 天");
  });

  it("写回格式固定，再次解析结果相同", () => {
    const out = serializeMind(ok(SRC));
    expect(out).toBe(SRC);
    expect(serializeMind(ok(out))).toBe(out);
  });

  it("全是默认值时不写整张图那一行；只有根节点样式时仍能读回", () => {
    const doc = emptyMind("根");
    doc.root.style = { color: "red" };
    const out = serializeMind(doc);
    expect(out).toBe("mindmap\n  %% spark: color=red\n  根\n");
    const back = ok(out);
    expect(back.canvas).toEqual({});
    expect(back.root.style).toEqual({ color: "red" });
  });

  it("对不上的部分忽略：不认识的键、不合法的值、范围超出的概要", () => {
    const doc = ok(`mindmap
  %% spark: layout=upward scheme=Bad! spacing=huge foo=1
  根
    %% spark: bg=notacolor size=xxl bold=maybe
    A
    %% spark: summary=5
    B
    %% spark: summary=0
    C
`);
    expect(doc.canvas).toEqual({});
    expect(doc.root.children.map((c) => c.text)).toEqual(["A", "B", "C"]);
    expect(doc.root.children[0].style).toBeUndefined();
    expect(doc.root.summaries).toBeUndefined();
  });

  it("整张图的设置只认第一行，写在其他地方的忽略", () => {
    const doc = ok("mindmap\n  根\n  %% spark: layout=down\n    A\n");
    expect(doc.canvas).toEqual({});
  });
});

describe("概要", () => {
  const src = "mindmap\n  根\n    A\n    B\n    C\n    D\n";

  it("建在相邻同级节点上，写在最后一个节点的子树后面", () => {
    const doc = ok(src);
    const [, b, c] = doc.root.children;
    addChild(doc, c.id, "C1");
    const s = addSummary(doc, [c.id, b.id], "小结")!;
    expect(serializeMind(doc)).toBe("mindmap\n  根\n    A\n    B\n    C\n      C1\n    %% spark: summary=2\n    小结\n    D\n");
    expect(isSummaryNode(doc, s)).toBe(true);
    expect(parentOf(doc, s)).toBe(doc.root);
    expect(countMind(doc.root)).toBe(7);
  });

  it("被概要的节点删除时范围缩小，一个不剩时概要节点变成普通子节点", () => {
    const doc = ok(src);
    const [a, b, c] = doc.root.children;
    const s = addSummary(doc, [b.id, c.id], "小结")!;
    addChild(doc, s, "细节");
    removeMind(doc, b.id);
    expect(doc.root.summaries![0].from).toBe(c.id);
    removeMind(doc, c.id);
    expect(doc.root.summaries).toBeUndefined();
    expect(texts(doc)).toEqual(["根", "-A", "-小结", "--细节", "-D"]);
    expect(isSummaryNode(doc, s)).toBe(false);
    expect(parentOf(doc, s)?.id).toBe(doc.root.id);
    expect(removeMind(doc, a.id)).toBe(s);
  });

  it("被概要的节点移到别处时范围缩小；同一层里只有它时概要跟着走", () => {
    const doc = ok(src);
    const [a, b, c, d] = doc.root.children;
    addSummary(doc, [a.id, b.id], "前两个");
    moveMind(doc, a.id, d.id, 0);
    expect(doc.root.summaries!.map((s) => [s.from, s.to])).toEqual([[b.id, b.id]]);
    moveMind(doc, b.id, doc.root.id, 3);
    expect(doc.root.children.map((n) => n.text)).toEqual(["C", "D", "B"]);
    expect(doc.root.summaries!.map((s) => [s.from, s.to])).toEqual([[b.id, b.id]]);
    expect(serializeMind(doc)).toContain("    B\n    %% spark: summary=1\n    前两个\n");
    void c;
  });

  it("删除概要节点只删它和它的子节点；概要节点拖到别处后变成普通节点", () => {
    const doc = ok(src);
    const [a, b] = doc.root.children;
    const s1 = addSummary(doc, [a.id], "一")!;
    const s2 = addSummary(doc, [b.id], "二")!;
    expect(removeMind(doc, s1)).toBe(a.id);
    expect(moveMind(doc, s2, a.id, 0)).toBe(true);
    expect(doc.root.summaries).toBeUndefined();
    expect(texts(doc)).toEqual(["根", "-A", "--二", "-B", "-C", "-D"]);
  });

  it("概要节点上加同级节点，加在它概括的最后一个节点后面", () => {
    const doc = ok(src);
    const [a, b] = doc.root.children;
    const s = addSummary(doc, [a.id, b.id], "小结")!;
    addSibling(doc, s, "新");
    expect(doc.root.children.map((n) => n.text)).toEqual(["A", "B", "新", "C", "D"]);
  });
});

describe("parseAiMind", () => {
  it("去掉代码块和形状写法，跳过图标与第二个根节点，生成到一半也能显示", () => {
    const text = "好的，这是思维导图：\n```mermaid\nmindmap\n  root((Rust 所有权))\n    三条规则\n      - 每个值有一个所有者\n      ::icon(fa fa-book)\n    [移动与复制]\n  另一个根\n    借";
    const { doc, skipped } = parseAiMind(text, "所有权笔记");
    expect(texts(doc)).toEqual(["Rust 所有权", "-三条规则", "--每个值有一个所有者", "-移动与复制", "-借"]);
    expect(skipped).toBe(2);
    expect(parseAiMind("正在思考", "所有权笔记").doc.root.text).toBe("所有权笔记");
  });
});

describe("编辑操作", () => {
  it("加子节点、加同级、删除后选中相邻节点", () => {
    const doc = ok("mindmap\n  根\n    A\n    B\n");
    const [a, b] = doc.root.children;
    const c = addChild(doc, a.id, "A1")!;
    const s = addSibling(doc, a.id, "A2")!;
    expect(texts(doc)).toEqual(["根", "-A", "--A1", "-A2", "-B"]);
    expect(addSibling(doc, doc.root.id, "根的子节点")).toBeTruthy();
    expect(removeMind(doc, s)).toBe(a.id);
    expect(removeMind(doc, a.id)).toBe(b.id);
    expect(findMind(doc, c)).toBeNull();
    expect(removeMind(doc, doc.root.id)).toBeNull();
  });

  it("移动节点：换父节点、同级调整顺序，不能移到自己的子孙下面", () => {
    const doc = ok("mindmap\n  根\n    A\n      A1\n    B\n    C\n");
    const [a, b, c] = doc.root.children;
    expect(moveMind(doc, a.id, a.children[0].id, 0)).toBe(false);
    expect(moveMind(doc, c.id, doc.root.id, 0)).toBe(true);
    expect(doc.root.children.map((n) => n.text)).toEqual(["C", "A", "B"]);
    expect(moveMind(doc, c.id, doc.root.id, 2)).toBe(true);
    expect(doc.root.children.map((n) => n.text)).toEqual(["A", "C", "B"]);
    expect(moveMind(doc, b.id, a.id, 1)).toBe(true);
    expect(texts(doc)).toEqual(["根", "-A", "--A1", "--B", "-C"]);
    expect(countMind(doc.root)).toBe(5);
  });

  it("在前面加同级；根节点上加在第一个子节点位置", () => {
    const doc = ok("mindmap\n  根\n    A\n    B\n");
    addSiblingBefore(doc, doc.root.children[1].id, "前");
    addSiblingBefore(doc, doc.root.id, "首");
    expect(doc.root.children.map((n) => n.text)).toEqual(["首", "A", "前", "B"]);
  });

  it("插入父主题：选中的相邻节点按原顺序放进新节点；不同父节点时不插入", () => {
    const doc = ok("mindmap\n  根\n    A\n    B\n      B1\n    C\n");
    const [a, b, c] = doc.root.children;
    const p = addParent(doc, [c.id, b.id], "新父")!;
    expect(texts(doc)).toEqual(["根", "-A", "-新父", "--B", "---B1", "--C"]);
    expect(parentOf(doc, b.id)?.id).toBe(p);
    expect(addParent(doc, [a.id, b.children[0].id], "x")).toBeNull();
    expect(addParent(doc, [doc.root.id], "x")).toBeNull();
  });

  it("一次移动多个节点：保持先后顺序，放在前面 / 后面 / 作为子节点；不能放进自己下面", () => {
    const doc = ok("mindmap\n  根\n    A\n    B\n    C\n    D\n");
    const [a, b, c, d] = doc.root.children;
    expect(moveMany(doc, [c.id, a.id], d.id, "after")).toBe(true);
    expect(doc.root.children.map((n) => n.text)).toEqual(["B", "D", "A", "C"]);
    expect(moveMany(doc, [a.id, c.id], b.id, "before")).toBe(true);
    expect(doc.root.children.map((n) => n.text)).toEqual(["A", "C", "B", "D"]);
    expect(moveMany(doc, [a.id, c.id], d.id, "child")).toBe(true);
    expect(texts(doc)).toEqual(["根", "-B", "-D", "--A", "--C"]);
    expect(moveMany(doc, [d.id], a.id, "child")).toBe(false);
  });

  it("复制子树换新编号、保留样式和概要；缩进文字互转，去掉列表符号", () => {
    const doc = ok("mindmap\n  根\n    A\n      A1\n      A2\n      %% spark: summary=2 bg=mint\n      小结\n");
    const a = doc.root.children[0];
    const copy = cloneTree(a);
    expect(copy.id).not.toBe(a.id);
    expect(copy.children.map((n) => n.text)).toEqual(["A1", "A2"]);
    expect(copy.summaries![0].from).toBe(copy.children[0].id);
    expect(copy.summaries![0].node.style).toEqual({ bg: "mint" });
    expect(treesToText([a])).toBe("A\n  A1\n  A2\n  小结");
    const trees = textToTrees("- 第一章\n  - 1.1 节\n\t- 1.2\n2. 第二章\n");
    expect(trees.map((t) => t.text)).toEqual(["第一章", "第二章"]);
    expect(trees[0].children.map((t) => t.text)).toEqual(["1.1 节", "1.2"]);
  });
});
