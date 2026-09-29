// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { createEditor, readMarkdown } from "./createEditor";
import { parseWiki, splitWikiText, wikiLabel, type WikiHost } from "./wikilink";

let editor: Editor | null = null;

async function setup(markdown: string, wiki?: WikiHost) {
  const root = document.createElement("div");
  document.body.append(root);
  editor = await createEditor({
    root, markdown, wiki,
    onChange: () => {}, onCursor: () => {}, onWords: () => {},
    onError: (c, e) => { throw new Error(`${c}: ${e}`); },
  });
  return { editor, root };
}

afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

describe("解析", () => {
  it("parseWiki / wikiLabel", () => {
    expect(parseWiki("工作/周报#本周|别名")).toEqual({ target: "工作/周报", heading: "本周", alias: "别名" });
    expect(wikiLabel("工作/周报")).toBe("周报");
    expect(wikiLabel("周报#本周")).toBe("周报 › 本周");
    expect(wikiLabel("a|显示")).toBe("显示");
  });

  it("splitWikiText", () => {
    expect(splitWikiText("见 [[a]] 与 [[b|c]]。")).toEqual([
      { type: "text", value: "见 " },
      { type: "wikiLink", value: "a" },
      { type: "text", value: " 与 " },
      { type: "wikiLink", value: "b|c" },
      { type: "text", value: "。" },
    ]);
  });
});

describe("编辑器中的双向链接", () => {
  it("原样往返，不被转义；代码里的 [[ ]] 保持原文", async () => {
    const src = "见 [[周报]] 和 [[工作/周报#本周|别名]] #标签\n\n`[[不是链接]]`\n";
    const { editor: e, root } = await setup(src);
    expect(readMarkdown(e)).toBe(src);
    const links = [...root.querySelectorAll(".wikilink")].map((n) => n.textContent);
    expect(links).toEqual(["周报", "别名"]);
    expect(root.querySelector(".tag-inline")?.textContent).toBe("#标签");
  });

  it("行首的 #标签 保存时不加反斜杠；标题、单独的 # 和用户输入的反斜杠不受影响", async () => {
    const src = "#哲学 #读书/笔记\n\n# 标题\n\n\\#\n\n\\\\#字面\n";
    const { editor: e } = await setup(src);
    expect(readMarkdown(e)).toBe(src);
  });

  it("点击链接调用 open", async () => {
    const open = vi.fn();
    const { root } = await setup("[[周报]]\n", { candidates: () => [], open });
    const el = root.querySelector(".wikilink") as HTMLElement;
    const view = editor!.action((ctx) => ctx.get(editorViewCtx));
    const pos = view.posAtDOM(el, 0);
    view.someProp("handleClickOn", (f) => f(view, pos, view.state.doc.nodeAt(pos)!, pos, new MouseEvent("click"), true));
    expect(open).toHaveBeenCalledWith("周报");
  });

  it("补全：输入 [[ 后回车插入链接节点", async () => {
    const host: WikiHost = {
      candidates: (q) => [{ label: "周报", detail: "工作", value: q ? "工作/周报" : "周报" }],
      open: () => {},
    };
    const { editor: e } = await setup("x\n", host);
    e.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)).insertText(" [[周"));
      const handled = view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: "Enter" })));
      expect(handled).toBe(true);
    });
    expect(readMarkdown(e).trim()).toBe("x [[工作/周报]]");
  });
});
