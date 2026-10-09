// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@milkdown/kit/core";
import { createEditor, readMarkdown } from "./createEditor";

let editor: Editor | null = null;

afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

describe("读书笔记里的位置标记", () => {
  it("打开再保存后，划线后面的 HTML 注释原样还在", async () => {
    const src = [
      "## 第三章",
      "",
      "> 我们的语言发展成为一种八卦的工具",
      "<!-- spark-anno 9c21 epubcfi(/6/4) 2026-10-09T09:30:00.000Z -->",
      "",
      "八卦是大规模协作的基础",
      "",
    ].join("\n");
    const root = document.createElement("div");
    document.body.append(root);
    editor = await createEditor({
      root,
      markdown: src,
      onChange: () => {},
      onCursor: () => {},
      onWords: () => {},
      onError: (c, e) => { throw new Error(`${c}: ${e}`); },
    });
    const saved = readMarkdown(editor);
    expect(saved).toContain("<!-- spark-anno 9c21 epubcfi(/6/4) 2026-10-09T09:30:00.000Z -->");
    expect(saved).toContain("八卦是大规模协作的基础");
    const marker = root.querySelector(".anno-marker") as HTMLElement | null;
    expect(marker).toBeTruthy();
    expect(marker?.style.display).toBe("none");
    expect(marker?.textContent ?? "").toBe("");
  });
});
