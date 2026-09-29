import MarkdownIt from "markdown-it";
import { refractor } from "refractor";

/** AI 回复的 Markdown 显示（需求文档 5.17）：不渲染 HTML，代码块用 refractor 高亮 */

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function hastToHtml(nodes: HastNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return escapeHtml(n.value ?? "");
      if (n.type !== "element") return "";
      const cls = n.properties?.className?.join(" ");
      return `<span${cls ? ` class="${escapeHtml(cls)}"` : ""}>${hastToHtml(n.children ?? [])}</span>`;
    })
    .join("");
}

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(code, lang) {
    const name = lang.trim().toLowerCase();
    let body = escapeHtml(code);
    if (name && refractor.registered(name)) {
      try {
        body = hastToHtml(refractor.highlight(code, name).children as HastNode[]);
      } catch {
        // 高亮失败时按纯文本显示
      }
    }
    const label = name ? `<span class="md-lang">${escapeHtml(name)}</span>` : "";
    return `<pre class="md-code">${label}<code>${body}</code></pre>`;
  },
});

export function renderMarkdown(text: string): string {
  return md.render(text);
}
