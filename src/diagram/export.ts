/** 导出图（需求文档 5.18）：按当前主题配色，导出整张图；编辑用的选中框、连接点不导出 */

const STYLE_PROPS = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin",
  "opacity", "font-family", "font-size", "font-weight", "text-anchor",
];
const EDIT_ONLY = ".mind-focus, .mind-drop-line, .mind-hit, .mind-box.is-plain, .diagram-marquee, .mind-preview, .flow-handle, .flow-ghost, .flow-edge-hit, .flow-hit, .flow-guide, .flow-text-box, .flow-arrow-btn, .flow-corner, .flow-port, .flow-seg";
const PAD = 24;

export interface ExportedSvg {
  text: string;
  width: number;
  height: number;
}

export function buildSvg(svg: SVGSVGElement): ExportedSvg {
  const content = [...svg.children].filter((c): c is SVGGElement => c.tagName.toLowerCase() === "g").pop();
  if (!content) throw new Error("图还没有显示出来");
  const box = content.getBBox();
  const m = content.transform.baseVal.consolidate()?.matrix;
  const x = box.x + (m?.e ?? 0) - PAD;
  const y = box.y + (m?.f ?? 0) - PAD;
  const width = Math.ceil(box.width + PAD * 2);
  const height = Math.ceil(box.height + PAD * 2);

  const clone = svg.cloneNode(true) as SVGSVGElement;
  const from = [svg, ...svg.querySelectorAll("*")];
  const to = [clone, ...clone.querySelectorAll("*")];
  // 读取样式期间让选中、拖放目标的高亮失效（见 diagram.css 的 is-exporting）
  const canvas = svg.closest(".diagram-canvas");
  canvas?.classList.add("is-exporting");
  try {
    from.forEach((el, i) => {
      const target = to[i] as SVGElement;
      const cs = getComputedStyle(el);
      target.setAttribute("style", STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
      // 流程图节点的位置写在 CSS transform 里，导出时转成属性
      if (el !== svg && cs.transform && cs.transform !== "none") target.setAttribute("transform", cs.transform);
      if (target.getAttribute("marker-end") === "url(#flow-arrow-on)") target.setAttribute("marker-end", "url(#flow-arrow)");
      target.removeAttribute("class");
    });
  } finally {
    canvas?.classList.remove("is-exporting");
  }
  to.forEach((el, i) => {
    if ((from[i] as Element).matches?.(EDIT_ONLY)) el.remove();
  });

  const paper = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() || "#fff";
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", String(x));
  bg.setAttribute("y", String(y));
  bg.setAttribute("width", String(width));
  bg.setAttribute("height", String(height));
  bg.setAttribute("style", `fill:${paper}`);
  clone.insertBefore(bg, clone.firstChild);

  clone.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const text = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`;
  return { text, width, height };
}

/** 按 2 倍分辨率画成 PNG，保证在高分屏和打印时清晰 */
export async function svgToPng(svg: ExportedSvg, scale = 2): Promise<Blob> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.text)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(svg.width * scale);
  canvas.height = Math.round(svg.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("生成图片失败"))), "image/png"));
}
