import type { ChatMessage } from "../lib/api";
import { isComment } from "./issues";
import { arrange, avoidNodes } from "./flowLayout";
import { emptyFlow, parseFlow, serializeFlow, type FlowDir, type FlowDoc } from "./flowchart";

/**
 * AI 生成流程图（需求文档 5.18）：AI 只给出标题、方向和 Mermaid 语句，
 * 位置由分层排版算出，颜色按形状决定。
 */
export type GenDir = "auto" | "TD" | "LR";

/** 程序最多采用的节点数 */
export const MAX_FLOW_NODES = 60;

function systemPrompt(dir: GenDir): string {
  const header = dir === "auto"
    ? "第二行：flowchart TD（上到下）或 flowchart LR（左到右）。步骤多、以纵向为主的流程用 TD，步骤少、横向展开更清楚的用 LR"
    : `第二行固定写：flowchart ${dir}`;
  return [
    "你把用户描述的流程画成流程图。只输出下面格式的内容，不要任何解释，不要用代码块包裹：",
    "第一行：标题：不超过 15 个字的标题",
    header,
    "之后每行一条语句，定义节点和连线，例如：",
    "  start([开始]) --> submit[提交申请]",
    "  submit --> check{组长通过？}",
    "  check -->|是| notify[通知人事]",
    "  check -->|否| fix[修改申请]",
    "  fix --> submit",
    "规则：",
    "1. 节点编号只用英文字母、数字和下划线；同一个节点在各行用同一个编号，第一次出现时写上形状和文字，之后只写编号；",
    "2. 形状：开始和结束用 ([文字])，判断用 {文字}，输入或输出用 [/文字/]，数据或存储用 [(文字)]，其余步骤用 [文字]；",
    "3. 节点文字简短，尽量不超过 12 个字，文字里不要用括号、引号、竖线、斜杠；",
    "4. 判断节点的每条出线都写连线文字，如 -->|是| 、-->|否| ；",
    "5. 只用 --> 连线；不要用 subgraph、style、classDef、class、click、注释等其他写法；",
    "6. 节点总数不超过 30 个，步骤太多时合并成较粗的步骤；",
    "7. 要有开始和结束；循环（如驳回后重新提交）用连回前面节点的连线表示；",
    "8. 标题和节点文字使用描述所用的语言。",
  ].join("\n");
}

export function flowGenMessages(desc: string, dir: GenDir): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt(dir) },
    { role: "user", content: `流程描述：\n${desc.trim()}` },
  ];
}

/** 按意见修改：只发原始描述、当前这一版和这条意见 */
export function flowReviseMessages(desc: string, dir: GenDir, current: AiFlow, feedback: string): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt(dir) },
    {
      role: "user",
      content: [
        `原始描述：\n${desc.trim()}`,
        `当前的流程图：\n标题：${current.title || "流程图"}\n${plainFlowText(current.doc).trim()}`,
        `修改意见：\n${feedback.trim()}`,
        "按修改意见修改当前的流程图，意见没有提到的部分保持不变，按同样的格式输出修改后的完整流程图（包括标题）。",
      ].join("\n\n"),
    },
  ];
}

/** 不带位置、样式等扩展注释的 Mermaid 文本 */
export function plainFlowText(doc: FlowDoc): string {
  const d = structuredClone(doc);
  d.head = [];
  d.tail = [];
  d.canvas = {};
  for (const n of d.nodes) {
    delete n.x;
    delete n.y;
    delete n.w;
    delete n.h;
    delete n.style;
    delete n.isText;
    n.comments = [];
  }
  for (const e of d.edges) {
    delete e.route;
    delete e.fromSide;
    delete e.toSide;
    delete e.bends;
    e.comments = [];
  }
  return serializeFlow(d);
}

export interface AiFlow {
  doc: FlowDoc;
  title: string;
  /** 无法识别、没有采用的行数 */
  skipped: number;
  /** 超过 MAX_FLOW_NODES，后面的节点没有采用 */
  truncated: boolean;
}

const TITLE = /^(?:%%\s*)?(?:标题|title)\s*[:：]\s*(.+)$/i;
const HEADER = /^(flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*;?$/i;

function cleanTitle(t: string): string {
  return t.replace(/[*_`#]/g, "").replace(/^["'“”《「]+|["'“”》」]+$/g, "").trim().slice(0, 30);
}

/** 回复里的标题，生成期间用于标签页标题 */
export function aiFlowTitle(text: string): string {
  for (const line of text.split("\n")) {
    const m = TITLE.exec(line.trim());
    if (m) return cleanTitle(m[1]);
    if (HEADER.test(line.trim())) break;
  }
  return "";
}

/** Windows 不允许用作文件名的设备名 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 标题转成文件名：去掉文件名里不能用的字符，取不到时叫“流程图” */
export function flowFileName(title: string): string {
  let name = title.replace(/[\\/:*?"<>|\r\n\t]/g, "").replace(/^\.+/, "").trim().slice(0, 40);
  // 设备名（以及“CON.xxx”这种）在 Windows 上建不了文件
  if (RESERVED_NAME.test(name.split(".")[0] ?? "")) name = `${name} 流程图`;
  return name || "流程图";
}

/**
 * 解析 AI 的回复：逐行检查，能单独解析的语句才采用；complete 为 false（生成中）时只看完整的行。
 * 开始 / 结束（胶囊）和判断（菱形）上色，再按方向分层排版。
 * avoid 为 false 时不做连线避让（生成过程中每来一行都排版，避让留到结束时做一次）。
 */
export function parseAiFlow(text: string, dir: GenDir, complete = true, avoid = true): AiFlow {
  const body = complete ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  let title = "";
  let header: FlowDir = "TD";
  let started = false;
  let skipped = 0;
  let truncated = false;
  const ids = new Set<string>();
  const accepted: string[] = [];
  for (const raw of body.split("\n")) {
    const t = raw.trim();
    if (!t || t.startsWith("```")) continue;
    const tm = TITLE.exec(t);
    if (tm && !title && !started) {
      title = cleanTitle(tm[1]);
      continue;
    }
    const h = HEADER.exec(t);
    if (h) {
      if (!started) {
        const d = (h[2] ?? "TD").toUpperCase();
        header = d === "TB" ? "TD" : (d as FlowDir);
      }
      started = true;
      continue;
    }
    if (isComment(t)) continue;
    const one = parseFlow(`flowchart TD\n  ${t}\n`);
    // 只有一个词、既没有连线也没有形状的行多半是说明文字
    if (!one.ok || !one.doc.nodes.length || (!one.doc.edges.length && !/[[({]/.test(t))) {
      // 开头的说明文字不算跳过
      if (started) skipped++;
      continue;
    }
    started = true;
    const fresh = one.doc.nodes.map((n) => n.id).filter((id) => !ids.has(id));
    if (ids.size + fresh.length > MAX_FLOW_NODES) {
      truncated = true;
      continue;
    }
    fresh.forEach((id) => ids.add(id));
    accepted.push(t);
  }
  const flowDir: FlowDir = dir === "auto" ? header : dir;
  const parsed = parseFlow(`flowchart ${flowDir}\n${accepted.map((l) => `  ${l}`).join("\n")}\n`);
  const doc = parsed.ok ? parsed.doc : emptyFlow();
  doc.dir = flowDir;
  for (const n of doc.nodes) {
    if (n.shape === "stadium") n.style = { bg: "mint", border: "green" };
    else if (n.shape === "diamond") n.style = { bg: "apricot", border: "orange" };
  }
  if (doc.nodes.length) {
    arrange(doc, flowDir);
    if (avoid) avoidNodes(doc);
  }
  return { doc, title, skipped, truncated };
}
