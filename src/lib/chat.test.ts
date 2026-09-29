import { describe, expect, it } from "vitest";
import { autoTitle, groupByDay, noteTitleFrom, parseConversation, planContext, toApiMessage, userText, type ChatMsg } from "./chat";
import { renderMarkdown } from "./markdown";

const msg = (role: ChatMsg["role"], content: string, extra: Partial<ChatMsg> = {}): ChatMsg => ({
  id: Math.random().toString(36), role, content, createdAt: 0, ...extra,
});

describe("上下文裁剪", () => {
  const history = [
    msg("user", "一".repeat(100)),
    msg("assistant", "二".repeat(100)),
    msg("user", "三".repeat(100)),
    msg("assistant", "失败", { error: "HTTP 500" }),
    msg("assistant", "四".repeat(100)),
  ];

  it("从最近往前挑，超出上限的更早消息不发送；失败的回复不发送", () => {
    const next = msg("user", "新问题");
    const all = planContext(history, next, 100_000);
    expect(all.included.map((m) => m.content[0])).toEqual(["一", "二", "三", "四"]);
    expect(all.omitted).toBe(0);
    const tight = planContext(history, next, all.tokens - 50);
    expect(tight.included.map((m) => m.content[0])).toEqual(["二", "三", "四"]);
    expect(tight.omitted).toBe(1);
  });

  it("本条消息本身超出上限时标记 overflow", () => {
    const plan = planContext(history, msg("user", "长".repeat(500)), 200);
    expect(plan.overflow).toBe(true);
    expect(plan.included).toEqual([]);
  });

  it("附件与引用笔记的全文计入消息", () => {
    const m = msg("user", "对比一下", { attachments: [{ kind: "file", name: "日志.txt", text: "ERROR 401" }, { kind: "note", name: "周报", path: "周报.md", text: "本周完成" }] });
    expect(userText(m)).toBe("对比一下\n\n附件《日志.txt》：\n```\nERROR 401\n```\n\n引用的笔记《周报》：\n```\n本周完成\n```");
  });
});

describe("请求格式", () => {
  it("带图片的消息用多段内容发送", () => {
    const m = msg("user", "看图", { attachments: [{ kind: "image", name: "a.png", file: "1-0.png" }] });
    expect(toApiMessage(m, () => "data:image/png;base64,AQID")).toEqual({
      role: "user",
      content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }],
    });
    expect(toApiMessage(msg("assistant", "好"), () => undefined)).toEqual({ role: "assistant", content: "好" });
  });
});

describe("命名与分组", () => {
  it("用第一条消息命名会话，回复第一行作笔记名", () => {
    expect(autoTitle("\n  参考这篇笔记，帮我写一段冲突处理的说明，要分情况讲，越详细越好  \n第二行")).toBe("参考这篇笔记，帮我写一段冲突处理的说明，要分情况讲，越详细越…");
    expect(autoTitle("  ")).toBe("新对话");
    expect(noteTitleFrom("## **冲突处理**：三种情况\n正文")).toBe("冲突处理：三种情况");
    expect(noteTitleFrom("A/B: 对比")).toBe("A B 对比");
    expect(noteTitleFrom("```\n")).toBe("AI 回复");
  });

  it("按今天、昨天、更早分组", () => {
    const now = new Date(2026, 8, 28, 13, 0);
    const at = (d: number, h: number) => new Date(2026, 8, d, h).getTime();
    const groups = groupByDay([
      { id: "a", title: "a", updatedAt: at(28, 9) },
      { id: "b", title: "b", updatedAt: at(27, 22) },
      { id: "c", title: "c", updatedAt: at(20, 8) },
    ], now);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([["今天", ["a"]], ["昨天", ["b"]], ["更早", ["c"]]]);
  });

  it("读取存盘会话时补默认值", () => {
    const c = parseConversation('{"id":"x","messages":[{"role":"user","content":"hi"},{"role":"bad"}]}', "qwen-plus");
    expect(c).toMatchObject({ id: "x", title: "新对话", model: "qwen-plus" });
    expect(c.messages).toHaveLength(1);
    expect(() => parseConversation("{}", "m")).toThrow();
  });
});

describe("Markdown 显示", () => {
  it("不渲染 HTML，代码块高亮", () => {
    const html = renderMarkdown("<img src=x onerror=alert(1)>\n\n```js\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain('<span class="token keyword">const</span>');
    expect(html).toContain("<table>");
  });

  it("不允许 javascript: 链接", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain('href="javascript');
  });
});
