// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { createEditor, readMarkdown } from "./createEditor";
import { FORMAT_ACTIONS, setBlockLevel } from "./formatActions";

let editor: Editor | null = null;

async function setup(markdown: string): Promise<Editor> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = await createEditor({
    root,
    markdown,
    onChange: () => {},
    onCursor: () => {},
    onWords: () => {},
    onError: (c, e) => {
      throw new Error(`${c}: ${e}`);
    },
  });
  return editor;
}

/** 选中第一个文本块里的全部文字 */
function selectFirstBlock(e: Editor) {
  e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const block = view.state.doc.firstChild!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 1 + block.content.size)));
  });
}

afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

describe("格式动作", () => {
  it.each([
    ["strong", "**hello**"],
    ["emphasis", "*hello*"],
    ["strike", "~~hello~~"],
    ["inlineCode", "`hello`"],
    ["bulletList", "- hello"],
    ["orderedList", "1. hello"],
    ["taskList", "- [ ] hello"],
    ["quote", "> hello"],
  ] as const)("%s", async (id, expected) => {
    const e = await setup("hello\n");
    selectFirstBlock(e);
    expect(FORMAT_ACTIONS[id].run!(e)).toBe(true);
    expect(readMarkdown(e).trim()).toBe(expected);
  });

  it("标题级别与正文", async () => {
    const e = await setup("hello\n");
    selectFirstBlock(e);
    setBlockLevel(e, 2);
    expect(readMarkdown(e).trim()).toBe("## hello");
    setBlockLevel(e, 0);
    expect(readMarkdown(e).trim()).toBe("hello");
  });

  it("清除格式", async () => {
    const e = await setup("**hello**\n");
    selectFirstBlock(e);
    FORMAT_ACTIONS.clear.run!(e);
    expect(readMarkdown(e).trim()).toBe("hello");
  });

  it("撤销", async () => {
    const e = await setup("hello\n");
    selectFirstBlock(e);
    FORMAT_ACTIONS.strong.run!(e);
    FORMAT_ACTIONS.undo.run!(e);
    expect(readMarkdown(e).trim()).toBe("hello");
  });

  it("插入表格", async () => {
    const e = await setup("hello\n");
    expect(FORMAT_ACTIONS.table.run!(e)).toBe(true);
    expect(readMarkdown(e)).toMatch(/^\| +\| +\| +\|$/m);
  });

  it("插入分割线写成 ---", async () => {
    const e = await setup("hello\n");
    expect(FORMAT_ACTIONS.hr.run!(e)).toBe(true);
    expect(readMarkdown(e)).toMatch(/^---$/m);
  });

  it("代码块保留语言并渲染行号与语言按钮", async () => {
    const e = await setup("```rust\nfn main() {}\nlet a = 1;\n```\n");
    expect(readMarkdown(e)).toContain("```rust");
    const block = document.querySelector(".codeblock")!;
    expect(block.querySelector(".lang")!.textContent).toBe("rust");
    expect(block.querySelector(".cb-gutter")!.textContent).toBe("1\n2");
    expect(block.querySelector(".token.keyword")).not.toBeNull();
  });

  it("行首 ```rust 回车生成代码框；代码框内回车保持缩进", async () => {
    const e = await setup("x\n");
    e.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const press = (key: string) =>
        view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key })));
      selectFirstBlock(e);
      view.dispatch(view.state.tr.insertText("```rust"));
      expect(view.state.doc.firstChild!.type.name).toBe("paragraph");
      expect(press("Enter")).toBe(true);
      expect(view.state.doc.firstChild!.type.name).toBe("code_block");
      expect(view.state.doc.firstChild!.attrs.language).toBe("rust");
      view.dispatch(view.state.tr.insertText("    fn a() {"));
      expect(press("Enter")).toBe(true);
      expect(view.state.doc.firstChild!.textContent).toBe("    fn a() {\n    ");
    });
  });

  it("空段落不会被写成 <br />", async () => {
    const e = await setup("a\n");
    e.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const end = view.state.doc.firstChild!.content.size + 1;
      view.dispatch(view.state.tr.insert(end + 1, view.state.schema.nodes.paragraph.create()));
    });
    expect(readMarkdown(e)).not.toContain("<br");
  });

  it("列表标记保持 -，Front Matter 之外的内容往返稳定", async () => {
    const src = "## 标题\n\n- a\n- b\n\n正文 **粗体**\n";
    const e = await setup(src);
    expect(readMarkdown(e)).toBe(src);
  });
});
