// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { createEditor, readMarkdown } from "./createEditor";

let editor: Editor | null = null;

afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

function pipeLines(md: string): string[] {
  return md.split("\n").filter((line) => line.startsWith("|"));
}

function clickAction(id: string) {
  const btn = document.querySelector(`.table-bar button[data-action="${id}"]`) as HTMLButtonElement | null;
  expect(btn, id).toBeTruthy();
  btn!.click();
}

describe("表格增删行列", () => {
  it("光标在表格里时可以插入和删除行、列", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    editor = await createEditor({
      root,
      markdown: "| a | b |\n| --- | --- |\n| c | d |\n",
      onChange: () => {},
      onCursor: () => {},
      onWords: () => {},
      onError: (c, e) => {
        throw new Error(`${c}: ${e}`);
      },
    });
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      let pos = 1;
      view.state.doc.descendants((node, p) => {
        if (node.type.name === "table_cell") pos = p + 1;
      });
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
    });
    expect(document.querySelector(".table-bar")).toBeTruthy();
    clickAction("row-after");
    expect(pipeLines(readMarkdown(editor!)).length).toBe(4);
    clickAction("col-after");
    expect(pipeLines(readMarkdown(editor!))[0].split("|").filter((c) => c.trim() !== "" || true).length).toBeGreaterThan(4);
    expect(readMarkdown(editor!)).toContain("| c |");
    clickAction("row-delete");
    expect(pipeLines(readMarkdown(editor!)).length).toBe(3);
    clickAction("col-delete");
    const back = pipeLines(readMarkdown(editor!));
    expect(back).toHaveLength(3);
    expect(back[2]).toBe("|    | d |");
    expect(back[0]).toContain("b");
  });
});
