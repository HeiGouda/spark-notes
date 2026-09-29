import type { ChatMessage } from "../lib/api";
import type { FlowDir, FlowDoc } from "./flowchart";

/**
 * 流程图的 AI 整理（需求文档 5.18）：AI 只决定排版方向、分层和每层里的先后，
 * 位置由分层排版算出，节点文字和连线不变。
 */

const SHAPE_NAME: Record<string, string> = {
  rect: "矩形", round: "圆角", stadium: "胶囊", circle: "圆", diamond: "判断", hexagon: "六边形",
  parallelogram: "平行四边形", trapezoid: "梯形", cylinder: "圆柱",
};

export function arrangeMessages(doc: FlowDoc): ChatMessage[] {
  const nodes = doc.nodes.map((n) => `${n.id}：${n.text.replace(/\s+/g, " ")}（${n.isText ? "文字说明" : SHAPE_NAME[n.shape]}）`);
  const edges = doc.edges.map((e) => `${e.from} -> ${e.to}${e.label ? `：${e.label}` : ""}`);
  return [
    {
      role: "system",
      content: [
        "你负责给流程图排版。根据节点的含义和连线，决定整张图的方向，以及把节点分成若干层、每层里的先后顺序，让流程清楚、交叉的连线尽量少。",
        "规则：",
        "1. 流程的起点放在第一层，大体按执行顺序往后排；判断节点的各个分支放在它后面的层里；",
        "2. 回到前面的连线（循环、返工）不要为了它把节点往前挪；",
        "3. 文字说明放在它说明的节点所在的层，紧挨着那个节点；",
        "4. 同一层里的先后决定从左到右（或从上到下）的顺序，把相关的节点放在一起；",
        "5. 每个节点恰好出现一次，只能用给出的节点编号。",
        '只输出一个 JSON 对象，不要任何解释，格式：{"direction":"TD","layers":[["编号",...],...]}。direction 取 TD（上到下）、LR（左到右）、BT（下到上）、RL（右到左）之一。',
      ].join("\n"),
    },
    { role: "user", content: `节点（编号：文字（形状））：\n${nodes.join("\n")}\n\n连线（起点 -> 终点：连线文字）：\n${edges.join("\n") || "（没有连线）"}` },
  ];
}

export interface ArrangePlan {
  dir: FlowDir;
  layers: string[][];
}

const DIRS: FlowDir[] = ["TD", "BT", "LR", "RL"];

/**
 * 解析 AI 的回复。不认识的编号和重复的编号去掉；漏掉的节点放进最后单独一层。
 * 回复里找不到可用的 JSON，或者一半以上的节点都没排进去时抛出错误。
 */
export function parseArrange(text: string, doc: FlowDoc): ArrangePlan {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 的回复里没有排版结果");
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("AI 的回复无法识别");
  }
  const obj = data as { direction?: unknown; layers?: unknown };
  const raw = String(obj.direction ?? "TD").toUpperCase();
  const dir: FlowDir = raw === "TB" ? "TD" : DIRS.includes(raw as FlowDir) ? (raw as FlowDir) : "TD";
  if (!Array.isArray(obj.layers)) throw new Error("AI 的回复里没有分层");
  const known = new Set(doc.nodes.map((n) => n.id));
  const seen = new Set<string>();
  const layers: string[][] = [];
  for (const layer of obj.layers) {
    if (!Array.isArray(layer)) continue;
    const ids = layer.map(String).filter((id) => known.has(id) && !seen.has(id));
    ids.forEach((id) => seen.add(id));
    if (ids.length) layers.push(ids);
  }
  if (seen.size * 2 < known.size) throw new Error("AI 的排版漏掉了太多节点");
  const missing = doc.nodes.map((n) => n.id).filter((id) => !seen.has(id));
  if (missing.length) layers.push(missing);
  return { dir, layers };
}
