import { describe, expect, it } from "vitest";
import { parseFlow, type FlowDoc } from "./flowchart";
import {
  alignNodes, approachSide, arrange, avoidNodes, bendHandle, bendsOf, sidesOf, autoPositions, boxOf, clip, fillPositions, flowGeometry, measureNode, pointRoute, polylinePath, routePoints,
  shapePath, sideNear, sidePoints, type FlowBox,
} from "./flowLayout";

function ok(text: string): FlowDoc {
  const r = parseFlow(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.doc;
}

const SAMPLE = `flowchart TD
  start(开始) --> commit[提交代码]
  commit --> ci[CI 构建]
  ci --> test{测试通过？}
  test -->|是| stage[部署预发]
  test -->|否| fix[修复问题]
  stage --> accept{验收通过？}
  accept -->|是| prod[发布生产]
  accept -->|否| fix
  fix --> commit
  prod --> done((结束))
`;

const box = (cx: number, cy: number, w = 100, h = 40): FlowBox => ({
  id: "x", shape: "rect", isText: false, cx, cy, w, h, lines: [""], lineH: 19, size: 13, weight: 400,
});

describe("autoPositions / arrange", () => {
  it("最长路径分层：层越深越靠下，成环的连线不影响分层", () => {
    const p = autoPositions(ok(SAMPLE), "TD");
    const y = (id: string) => p.get(id)!.y;
    expect(y("commit")).toBeGreaterThan(y("start"));
    expect(y("stage")).toBeGreaterThan(y("test"));
    expect(y("fix")).toBeGreaterThan(y("accept"));
    expect(y("done")).toBeGreaterThan(y("prod"));
  });

  it("同一层按定义顺序从左到右", () => {
    const doc = ok("flowchart TD\n  A --> B\n  A --> C\n");
    const p = autoPositions(doc, "TD");
    expect(p.get("B")!.x).toBeLessThan(p.get("C")!.x);
  });

  it("四个方向；自动整理写回方向和全部位置", () => {
    const dirOf = (dir: "TD" | "BT" | "LR" | "RL") => {
      const p = autoPositions(ok("flowchart TD\n  A --> B\n"), dir);
      return { dx: Math.sign(p.get("B")!.x - p.get("A")!.x), dy: Math.sign(p.get("B")!.y - p.get("A")!.y) };
    };
    expect(dirOf("TD")).toEqual({ dx: 0, dy: 1 });
    expect(dirOf("BT")).toEqual({ dx: 0, dy: -1 });
    expect(dirOf("LR")).toEqual({ dx: 1, dy: 0 });
    expect(dirOf("RL")).toEqual({ dx: -1, dy: 0 });
    const doc = ok("flowchart TD\n  A --> B\n");
    arrange(doc, "LR");
    expect(doc.dir).toBe("LR");
    expect(doc.nodes.every((n) => n.x !== undefined && n.y !== undefined)).toBe(true);
  });
});

describe("fillPositions", () => {
  it("全都没有位置时整张图排一次；已有位置时不动", () => {
    const doc = ok(SAMPLE);
    expect(fillPositions(doc)).toBe(true);
    const before = doc.nodes.map((n) => [n.x, n.y]);
    expect(fillPositions(doc)).toBe(false);
    expect(doc.nodes.map((n) => [n.x, n.y])).toEqual(before);
  });

  it("只有一部分没有位置时，放在已有节点的右边", () => {
    const doc = ok("flowchart TD\n  %% spark: x=0 y=0\n  A[已有]\n  B --> C\n");
    fillPositions(doc);
    const [a, b, c] = doc.nodes;
    expect([a.x, a.y]).toEqual([0, 0]);
    expect(b.x!).toBeGreaterThan(80);
    expect(c.y!).toBeGreaterThan(b.y!);
  });
});

describe("flowGeometry", () => {
  it("节点按文件里的位置摆放，范围包含全部节点", () => {
    const doc = ok("flowchart TD\n  %% spark: x=-100 y=50\n  A\n  %% spark: x=200 y=300\n  B\n  A --> B\n");
    const g = flowGeometry(doc);
    expect(g.boxes.get("A")).toMatchObject({ cx: -100, cy: 50 });
    expect(g.minX).toBeLessThan(-100);
    expect(g.minX + g.width).toBeGreaterThan(200);
    expect(g.routes).toHaveLength(1);
  });

  it("直角走线：上下关系为主、目标在斜下方时走 L 形；左右关系为主时走 Z 形", () => {
    expect(routePoints(box(0, 0), box(200, 200), "elbow")).toEqual([{ x: 50, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 180 }]);
    const z = routePoints(box(0, 0), box(300, 100), "elbow");
    expect(z[0]).toEqual({ x: 50, y: 0 });
    expect(z[z.length - 1]).toEqual({ x: 250, y: 100 });
    expect(z).toHaveLength(4);
    expect(z[1].x).toBe(z[2].x);
    expect(routePoints(box(0, 0), box(300, 0), "elbow")).toHaveLength(2);
  });

  it("两个节点在另一方向上有重叠时画直线，不拐小弯；菱形接在轮廓上", () => {
    expect(routePoints(box(0, 0), box(40, 200), "elbow")).toEqual([{ x: 20, y: 20 }, { x: 20, y: 180 }]);
    const diamond = { ...box(30, 200, 120, 60), shape: "diamond" as const };
    const [p1, p2] = routePoints(box(0, 0), diamond, "elbow");
    expect(p1.x).toBe(p2.x);
    expect(p2.y).toBeCloseTo(200 - 30 * (1 - Math.abs(p2.x - 30) / 60));
  });

  it("直线走线接在两个节点的边框上；圆角走线的拐角是弧线", () => {
    const s = routePoints(box(0, 0), box(300, 0), "straight");
    expect(s).toEqual([{ x: 50, y: 0 }, { x: 250, y: 0 }]);
    const r = polylinePath(routePoints(box(0, 0), box(300, 100), "round"), true);
    expect(r).toContain("Q");
    expect(clip({ cx: 0, cy: 0, w: 100, h: 40, shape: "diamond" }, { x: 100, y: 0 })).toEqual({ x: 50, y: 0 });
  });

  it("有文字的连线带标签，自连线画在节点右边", () => {
    const doc = ok("flowchart TD\n  %% spark: x=0 y=0\n  A\n  %% spark: x=0 y=200\n  B\n  A -->|是| B\n  A --> A\n");
    const g = flowGeometry(doc);
    expect(g.routes[0].label).toBeTruthy();
    expect(g.routes[1].points).toHaveLength(4);
  });

  it("固定接边：按给定的边伸出再拐弯；离点最近的边", () => {
    const pts = routePoints(box(0, 0), box(300, 200), "elbow", { from: "bottom", to: "left" });
    expect(pts[0]).toEqual({ x: 0, y: 20 });
    expect(pts[pts.length - 1]).toEqual({ x: 250, y: 200 });
    expect(pts).toEqual([{ x: 0, y: 20 }, { x: 0, y: 200 }, { x: 250, y: 200 }]);
    expect(routePoints(box(0, 0), box(300, 200), "straight", { from: "right", to: "top" })).toEqual([{ x: 50, y: 0 }, { x: 300, y: 180 }]);
    expect(sideNear(box(0, 0), { x: 60, y: 5 })).toBe("right");
    expect(sideNear(box(0, 0), { x: 10, y: -30 })).toBe("top");
  });

  it("固定接边：不往回折、不穿过节点；只定一端时另一端挑最顺的边", () => {
    const a = box(0, 0);
    const b = box(0, 140);
    const pts = routePoints(a, b, "elbow", { from: "left", to: "bottom" });
    expect(pts[0]).toEqual({ x: -50, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 0, y: 160 });
    for (let i = 1; i < pts.length; i++) {
      const [p, q] = [pts[i - 1], pts[i]];
      expect(p.x === q.x || p.y === q.y).toBe(true);
      for (const n of [a, b]) {
        const inside = Math.max(p.x, q.x) > n.cx - n.w / 2 + 1 && Math.min(p.x, q.x) < n.cx + n.w / 2 - 1
          && Math.max(p.y, q.y) > n.cy - n.h / 2 + 1 && Math.min(p.y, q.y) < n.cy + n.h / 2 - 1;
        expect(inside).toBe(false);
      }
    }
    expect(routePoints(a, box(200, 0), "elbow", { from: "right" })).toEqual([{ x: 50, y: 0 }, { x: 150, y: 0 }]);
  });

  it("拖动折线的一段：中间段直接平移；首尾段先在节点边上留一小段；读出的中间段能还原同一条线", () => {
    const a = box(0, 0);
    const b = box(300, 0);
    // 下边出、下边进的 U 形线，把底下那一段拉到 y=150
    const u = routePoints(a, b, "elbow", { from: "bottom", to: "bottom" });
    expect(sidesOf(u)).toEqual({ from: "bottom", to: "bottom" });
    const h = bendHandle(u, 1)!;
    expect(h).toMatchObject({ index: 0, axis: "y" });
    const moved = routePoints(a, b, "elbow", { from: "bottom", to: "bottom", bends: [150] });
    expect(moved).toEqual([{ x: 0, y: 20 }, { x: 0, y: 150 }, { x: 300, y: 150 }, { x: 300, y: 20 }]);
    expect(bendsOf(moved)).toEqual([150]);
    // 右边出、左边进的一条直线：拖它时两头各留一小段
    const line = routePoints(a, b, "elbow", { from: "right", to: "left" });
    expect(line).toHaveLength(2);
    const s = bendHandle(line, 0)!;
    expect(s).toEqual({ bends: [70, 0, 230], index: 1, axis: "y" });
    const dragged = routePoints(a, b, "elbow", { from: "right", to: "left", bends: [70, 60, 230] });
    expect(dragged).toEqual([{ x: 50, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 60 }, { x: 230, y: 60 }, { x: 230, y: 0 }, { x: 250, y: 0 }]);
    expect(routePoints(a, b, "elbow", { from: "right", to: "left", bends: bendsOf(dragged) })).toEqual(dragged);
    // 直线走线不用手动拐点
    expect(routePoints(a, b, "straight", { from: "right", to: "left", bends: [70, 60, 230] })).toHaveLength(2);
  });

  it("连线避让：穿过其他节点的连线改从外侧绕，接边和折点写进连线，其余连线不动", () => {
    const r = parseFlow("flowchart TD\n  %% spark: x=0 y=0\n  a[起点]\n  %% spark: x=0 y=100\n  m[中间]\n  %% spark: x=0 y=200\n  b[终点]\n  a --> m\n  m --> b\n  a --> b\n");
    if (!r.ok) throw new Error("parse");
    const doc = r.doc;
    avoidNodes(doc);
    expect(doc.edges[0].fromSide).toBeUndefined();
    expect(doc.edges[1].fromSide).toBeUndefined();
    const e = doc.edges[2];
    expect(e.fromSide && e.toSide).toBeTruthy();
    const g = flowGeometry(doc);
    const mid = g.boxes.get("m")!;
    const pts = g.routes.find((x) => x.key === e.key)!.points;
    for (let i = 1; i < pts.length; i++) {
      const [p, q] = [pts[i - 1], pts[i]];
      const inside = Math.max(p.x, q.x) > mid.cx - mid.w / 2 + 1 && Math.min(p.x, q.x) < mid.cx + mid.w / 2 - 1
        && Math.max(p.y, q.y) > mid.cy - mid.h / 2 + 1 && Math.min(p.y, q.y) < mid.cy + mid.h / 2 - 1;
      expect(inside).toBe(false);
    }
  });

  it("拖连线的预览：点在前方时走 L 形，在侧后方时先伸出再绕；最后一段决定终点接哪边", () => {
    const l = pointRoute(box(0, 0), "right", { x: 200, y: 150 }, "elbow");
    expect(l).toEqual([{ x: 50, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 150 }]);
    expect(approachSide(l)).toBe("top");
    const back = pointRoute(box(0, 0), "right", { x: -100, y: 150 }, "elbow");
    expect(back).toEqual([{ x: 50, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 150 }, { x: -100, y: 150 }]);
    expect(approachSide(back)).toBe("right");
    expect(pointRoute(box(0, 0), "bottom", { x: 80, y: 200 }, "straight")).toEqual([{ x: 0, y: 20 }, { x: 80, y: 200 }]);
    expect(sidePoints(box(0, 0)).map((p) => p.side)).toEqual(["top", "right", "bottom", "left"]);
  });

  it("手动大小：文字在框内换行，框比文字矮时随文字变高", () => {
    const wide = measureNode("一二三四五六七八九十", "rect");
    const fixed = measureNode("一二三四五六七八九十", "rect", undefined, false, { w: 80, h: 30 });
    expect(fixed.w).toBe(80);
    expect(fixed.lines.length).toBeGreaterThan(1);
    expect(fixed.h).toBeGreaterThan(30);
    expect(wide.lines).toHaveLength(1);
    expect(measureNode("第一行\n第二行", "rect").lines).toEqual(["第一行", "第二行"]);
  });

  it("对齐与分布", () => {
    const doc = ok("flowchart TD\n  %% spark: x=0 y=0\n  a\n  %% spark: x=37 y=100\n  b\n  %% spark: x=300 y=260\n  c\n");
    alignNodes(doc, ["a", "b", "c"], "left");
    const lefts = doc.nodes.map((n) => { const b = boxOf(n); return b.cx - b.w / 2; });
    expect(new Set(lefts.map(Math.round)).size).toBe(1);
    alignNodes(doc, ["a", "b", "c"], "vspace");
    const [a, b, c] = doc.nodes.map(boxOf);
    expect(Math.round(b.cy - b.h / 2 - (a.cy + a.h / 2))).toBe(Math.round(c.cy - c.h / 2 - (b.cy + b.h / 2)));
  });

  it("九种形状都有轮廓", () => {
    for (const s of ["rect", "round", "stadium", "circle", "diamond", "hexagon", "parallelogram", "trapezoid", "cylinder"] as const) {
      expect(shapePath(s, 100, 40)).toMatch(/^M/);
    }
  });
});
