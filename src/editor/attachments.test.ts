// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@milkdown/kit/core";
import { createEditor, readMarkdown } from "./createEditor";
import { attachmentName, clipboardFiles, handlePaste, insertAttachments, isImageName, joinImageTitle, splitImageTitle } from "./attachments";
import type { EditorView } from "@milkdown/kit/prose/view";

let editor: Editor | null = null;

afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

describe("attachmentName", () => {
  const at = new Date(2026, 8, 24, 16, 5, 9);
  it("截图的通用文件名改成带时间的名字", () => {
    expect(attachmentName(new File(["x"], "image.png", { type: "image/png" }), at)).toBe("image-20260924-160509.png");
    expect(attachmentName(new File(["x"], "", { type: "image/jpeg" }), at)).toBe("image-20260924-160509.jpeg");
  });
  it("其他文件保留原名", () => {
    expect(attachmentName(new File(["x"], "报告.pdf"), at)).toBe("报告.pdf");
  });
  it("按扩展名识别图片", () => {
    expect(isImageName("a.PNG")).toBe(true);
    expect(isImageName("a.pdf")).toBe(false);
  });
});

describe("图片宽度", () => {
  it("从 title 里读写宽度，普通说明不受影响", () => {
    expect(splitImageTitle("")).toEqual({ title: "", width: null });
    expect(splitImageTitle("封面")).toEqual({ title: "封面", width: null });
    expect(splitImageTitle("w=240")).toEqual({ title: "", width: 240 });
    expect(splitImageTitle("封面|w=320")).toEqual({ title: "封面", width: 320 });
    expect(joinImageTitle("封面", 180)).toBe("封面|w=180");
    expect(joinImageTitle("w=240", null)).toBe("");
    expect(joinImageTitle("", 10)).toBe("w=48");
  });

  it("打开时按记下的宽度显示，放大后写回 Markdown", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    editor = await createEditor({
      root,
      markdown: '![图](a.png "w=240")\n',
      onChange: () => {},
      onCursor: () => {},
      onWords: () => {},
      onError: () => {},
      attachments: { resolve: (src) => `asset://resolved/${src}`, save: async () => ({ link: "", name: "", isImage: true }) },
    });
    const img = root.querySelector("img") as HTMLImageElement;
    expect(img.style.width).toBe("240px");
    expect(img.getAttribute("src")).toBe("asset://resolved/a.png");
    (root.querySelectorAll(".img-zoom")[1] as HTMLButtonElement).click();
    expect(readMarkdown(editor)).toContain("w=300");
    expect((root.querySelector("img") as HTMLImageElement).style.width).toBe("300px");
  });
});

describe("剪贴板文件", () => {
  it("files 为空时从 items 里取截图", () => {
    const file = new File(["x"], "image.png", { type: "image/png" });
    const data = {
      files: [] as File[],
      items: [{ kind: "file", getAsFile: () => file }],
    } as unknown as DataTransfer;
    expect(clipboardFiles(data)).toEqual([file]);
  });
});

describe("图片显示", () => {
  it("相对路径经 resolve 转换后显示，Markdown 仍保存原路径", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    editor = await createEditor({
      root,
      markdown: "![图](<a b.assets/x.png>)\n",
      onChange: () => {},
      onCursor: () => {},
      onWords: () => {},
      onError: () => {},
      attachments: { resolve: (src) => `asset://resolved/${src}`, save: async () => ({ link: "", name: "", isImage: true }) },
    });
    const img = root.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("asset://resolved/a b.assets/x.png");
    expect(readMarkdown(editor)).toContain("(<a b.assets/x.png>)");
  });
});

describe("insertAttachments", () => {
  it("图片插入为图片，其他文件插入为链接，含空格的路径可正确往返", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    editor = await createEditor({
      root,
      markdown: "开头\n",
      onChange: () => {},
      onCursor: () => {},
      onWords: () => {},
      onError: (c, e) => {
        throw new Error(`${c}: ${e}`);
      },
    });
    insertAttachments(editor, [
      { link: "周 报.assets/image-1.png", name: "image-1.png", isImage: true },
      { link: "周 报.assets/报告.pdf", name: "报告.pdf", isImage: false },
    ]);
    const md = readMarkdown(editor);
    expect(md).toContain("![image-1](<周 报.assets/image-1.png>)");
    expect(md).toContain("[报告.pdf](<周 报.assets/报告.pdf>)");
  });
});

describe("粘贴附件", () => {
  it("保存期间编辑器已销毁时不再插入，并提示附件位置", async () => {
    const errors: string[] = [];
    let dispatched = false;
    const view = { isDestroyed: true, dispatch: () => (dispatched = true) } as unknown as EditorView;
    const paste = handlePaste({
      resolve: (s) => s,
      save: async (f) => ({ link: `n.assets/${f.name}`, name: f.name, isImage: true }),
      onError: (c, e) => errors.push(`${c}: ${e}`),
    });
    const event = { clipboardData: { files: [new File(["x"], "a.png")] }, preventDefault: () => {} } as unknown as ClipboardEvent;
    expect(paste(view, event)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatched).toBe(false);
    expect(errors).toEqual(["笔记已切换，附件已保存但没有插入链接: n.assets/a.png"]);
  });
});
