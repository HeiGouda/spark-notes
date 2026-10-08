import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn(), save: vi.fn() }));

const { aiMindDoc, mindFileName } = await import("./mindGen");

const reply = (branches: number) => ["mindmap", "  哲学", ...Array.from({ length: branches }, (_, i) => `    分支${i + 1}`)].join("\n");

describe("AI 生成思维导图", () => {
  it("选了布局就用它；“自动”在一级分支达到 5 个时用左右平衡，否则保持默认（向右）", () => {
    expect(aiMindDoc(reply(3), "未命名", "left").doc.canvas.structure).toBe("left");
    expect(aiMindDoc(reply(3), "未命名", "auto").doc.canvas.structure).toBeUndefined();
    expect(aiMindDoc(reply(5), "未命名", "auto").doc.canvas.structure).toBe("balanced");
    expect(aiMindDoc(reply(5), "未命名", "right").doc.canvas.structure).toBe("right");
  });

  it("文件名取根节点文字，去掉不能用的字符，过长时截短，取不到时叫“思维导图”", () => {
    expect(mindFileName("马克思主义哲学：第一章")).toBe("马克思主义哲学：第一章");
    expect(mindFileName('a/b\\c:d*e?"f<g>h|i')).toBe("a b c d e f g h i");
    expect(mindFileName("...  ")).toBe("思维导图");
    expect([...mindFileName("长".repeat(60))].length).toBe(40);
  });
});
