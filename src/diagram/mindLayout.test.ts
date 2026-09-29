import { describe, expect, it } from "vitest";
import { addSummary, parseMind, type MindDoc } from "./mindmap";
import { layoutMind, linkPath, type MindBox, type MindLayout } from "./mindLayout";
import type { MindStructure } from "./spark";

function ok(text: string): MindDoc {
  const r = parseMind(text, "根");
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.doc;
}

const SRC = `mindmap
  根
    A
      A1
      A2
    B
      B1
    C
    D
      D1
      D2
      D3
`;

function byText(doc: MindDoc, l: MindLayout): Record<string, MindBox> {
  const out: Record<string, MindBox> = {};
  const walk = (n: MindDoc["root"]) => {
    const b = l.boxes.get(n.id);
    if (b) out[n.text] = b;
    n.children.forEach(walk);
    n.summaries?.forEach((s) => walk(s.node));
  };
  walk(doc.root);
  return out;
}

function overlaps(l: MindLayout): string[] {
  const bs = [...l.boxes.values()];
  const out: string[] = [];
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i];
      const b = bs[j];
      if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5) out.push(`${a.id}/${b.id}`);
    }
  }
  return out;
}

const cx = (b: MindBox) => b.x + b.w / 2;
const cy = (b: MindBox) => b.y + b.h / 2;

describe("layoutMind", () => {
  const structures: MindStructure[] = ["right", "left", "balanced", "down", "fishbone"];

  it.each(structures)("%s：节点互不重叠，坐标从 0 开始，每个可见节点都有连线", (structure) => {
    const doc = ok(SRC);
    const l = layoutMind(doc.root, new Set(), { structure });
    expect(overlaps(l)).toEqual([]);
    const bs = [...l.boxes.values()];
    // 鱼骨图的主骨尾巴比最左边的节点还靠左
    if (structure === "fishbone") expect(Math.min(...bs.map((b) => b.x))).toBeGreaterThan(0);
    else expect(Math.min(...bs.map((b) => b.x))).toBeCloseTo(0);
    expect(Math.min(...bs.map((b) => b.y))).toBeCloseTo(0);
    expect(l.links).toHaveLength(bs.length - 1);
    expect(Math.max(...bs.map((b) => b.x + b.w))).toBeLessThanOrEqual(l.width + 0.5);
  });

  it("向右、向左、向下：子节点在父节点的对应一侧", () => {
    const doc = ok(SRC);
    const r = byText(doc, layoutMind(doc.root, new Set(), { structure: "right" }));
    expect(r.A.x).toBeGreaterThan(r["根"].x + r["根"].w);
    expect(r.A1.x).toBeGreaterThan(r.A.x + r.A.w);
    const lft = byText(doc, layoutMind(doc.root, new Set(), { structure: "left" }));
    expect(lft.A.x + lft.A.w).toBeLessThan(lft["根"].x);
    expect(lft.A1.x + lft.A1.w).toBeLessThan(lft.A.x);
    const d = byText(doc, layoutMind(doc.root, new Set(), { structure: "down" }));
    expect(d.A.y).toBeGreaterThan(d["根"].y + d["根"].h);
    expect(d.A.x).toBeLessThan(d.B.x);
    expect(d.A1.y).toBeGreaterThan(d.A.y + d.A.h);
    expect(d.A.sib).toBe("h");
  });

  it("左右平衡：前一半在右，后一半在左", () => {
    const doc = ok(SRC);
    const b = byText(doc, layoutMind(doc.root, new Set(), { structure: "balanced" }));
    const root = b["根"];
    expect(b.A.x).toBeGreaterThan(root.x);
    expect(b.B.x).toBeGreaterThan(root.x);
    expect(b.C.x + b.C.w).toBeLessThan(root.x);
    expect(b.D.x + b.D.w).toBeLessThan(root.x);
    expect(b.C.dir).toBe("left");
    expect(b.D1.x + b.D1.w).toBeLessThan(b.D.x);
  });

  it("鱼骨图：鱼头在最右，大骨上下交替、从右往左排，不显示概要", () => {
    const doc = ok(SRC);
    const [a, bNode] = doc.root.children;
    addSummary(doc, [a.id, bNode.id], "小结");
    const l = layoutMind(doc.root, new Set(), { structure: "fishbone" });
    const b = byText(doc, l);
    const root = b["根"];
    for (const k of ["A", "B", "C", "D", "A1", "D3"]) expect(b[k].x + b[k].w).toBeLessThanOrEqual(root.x + 0.5);
    expect(cy(b.A)).toBeLessThan(cy(root));
    expect(cy(b.B)).toBeGreaterThan(cy(root));
    expect(cy(b.C)).toBeLessThan(cy(root));
    expect(cx(b.A)).toBeGreaterThan(cx(b.C));
    expect(b["小结"]).toBeUndefined();
    expect(l.brackets).toEqual([]);
    expect(l.spine).toBeTruthy();
  });

  it("概要节点在它概括的子树外侧，概要节点较高时前后留出空白", () => {
    const doc = ok(SRC);
    const [a, b, c] = doc.root.children;
    const s = addSummary(doc, [b.id, c.id], "小结")!;
    const sNode = doc.root.summaries![0].node;
    for (let i = 0; i < 6; i++) sNode.children.push({ id: `x${i}`, text: `细节${i}`, children: [], comments: [] });
    const l = layoutMind(doc.root, new Set(), { structure: "right" });
    const t = byText(doc, l);
    expect(overlaps(l)).toEqual([]);
    expect(t["小结"].x).toBeGreaterThan(t.B1.x + t.B1.w);
    expect(t["小结"].summary).toBe(true);
    expect(l.brackets.map((x) => x.id)).toEqual([s]);
    expect(t["细节0"].x).toBeGreaterThan(t["小结"].x + t["小结"].w);
    void a;
  });

  it("六种线条：同一父节点的子节点折点在同一列", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 60 };
    expect(linkPath(a, b, "h", "curve")).toBe("M0 0C50 0 50 60 100 60");
    expect(linkPath(a, b, "h", "elbow")).toBe("M0 0L50 0L50 60L100 60");
    expect(linkPath(a, b, "h", "round")).toContain("Q50 0");
    expect(linkPath(a, b, "h", "fork")).toBe("M0 0L35 0L65 60L100 60");
    expect(linkPath(a, b, "h", "straight")).toBe("M0 0L100 60");
    expect(linkPath(a, b, "h", "slant")).toBe("M0 0L50 60L100 60");
    expect(linkPath(a, { x: 60, y: 100 }, "v", "elbow")).toBe("M0 0L0 50L60 50L60 100");
    const doc = ok(SRC);
    const l = layoutMind(doc.root, new Set(), { line: "elbow" });
    const trunks = l.links.filter((x) => x.from === doc.root.id).map((x) => x.d.split("L")[1].split(" ")[0]);
    expect(new Set(trunks).size).toBe(1);
  });

  it("纯文字外观：不画框也不画下划线，连线接在文字两端的中间；设了背景的节点仍画框", () => {
    const doc = ok(SRC);
    const a = doc.root.children[0];
    const l = layoutMind(doc.root, new Set(), { look: "text", styles: new Map([[a.id, { bg: "mint" }]]) });
    const t = byText(doc, l);
    expect(t["根"].boxed).toBe(false);
    expect(t["根"].underline).toBe(false);
    expect(t.B.boxed).toBe(false);
    expect(t.A1.underline).toBe(false);
    expect(t.A.boxed).toBe(true);
    const link = l.links.find((x) => x.to === t.B1.id)!;
    const end = link.d.split(" ").slice(-2).map(Number);
    expect(end).toEqual([t.B1.x, t.B1.y + t.B1.h / 2]);
    const fish = byText(doc, layoutMind(doc.root, new Set(), { look: "text", structure: "fishbone" }));
    expect(fish.A1.underline).toBe(true);
    expect(fish.A.underline).toBe(false);
  });

  it("主题间距：紧凑比宽松占地小；字号越大节点越大；折叠后显示隐藏数量", () => {
    const doc = ok(SRC);
    const compact = layoutMind(doc.root, new Set(), { spacing: "compact" });
    const loose = layoutMind(doc.root, new Set(), { spacing: "loose" });
    expect(compact.width).toBeLessThan(loose.width);
    expect(compact.height).toBeLessThan(loose.height);
    const a = doc.root.children[0];
    const big = layoutMind(doc.root, new Set(), { styles: new Map([[a.id, { size: "xl" as const, bold: true }]]) });
    const normal = layoutMind(doc.root, new Set());
    expect(big.boxes.get(a.id)!.h).toBeGreaterThan(normal.boxes.get(a.id)!.h);
    expect(big.boxes.get(a.id)!.weight).toBe(700);
    const folded = layoutMind(doc.root, new Set([doc.root.children[3].id]));
    expect(folded.boxes.get(doc.root.children[3].id)!.hidden).toBe(3);
    expect(folded.boxes.size).toBe(8);
  });
});
