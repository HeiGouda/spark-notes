// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { createEditor, readMarkdown } from "./createEditor";
import { toggleHighlight, splitHighlight } from "./highlight";
import { insertFootnote } from "./footnote";
import { buildPattern, currentDoc, findMatches, replaceAll, replaceOne } from "./find";
import { applyLink, currentLink } from "./link";
import { filterSlash } from "./popups";
import { FORMAT_ACTIONS } from "./formatActions";

let editor: Editor | null = null;

async function setup(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  editor = await createEditor({
    root, markdown,
    onChange: () => {}, onCursor: () => {}, onWords: () => {},
    onError: (c, e) => { throw new Error(`${c}: ${e}`); },
  });
  return editor;
}

function select(e: Editor, from: number, to: number) {
  e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
  });
}

afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

describe("高亮 ==文字==", () => {
  it("解析与原样保存", async () => {
    const src = "前 ==重点== 后，a == b 不是高亮\n";
    const e = await setup(src);
    expect(readMarkdown(e)).toBe(src);
    expect(document.querySelector(".pm mark")?.textContent).toBe("重点");
  });

  it("切换高亮", async () => {
    const e = await setup("hello\n");
    select(e, 1, 6);
    expect(toggleHighlight(e)).toBe(true);
    expect(readMarkdown(e).trim()).toBe("==hello==");
    toggleHighlight(e);
    expect(readMarkdown(e).trim()).toBe("hello");
  });

  it("splitHighlight 不跨行、不接受空内容", () => {
    expect(splitHighlight("a ==b== c").map((n) => n.type)).toEqual(["text", "highlight", "text"]);
    expect(splitHighlight("====").every((n) => n.type === "text")).toBe(true);
  });
});

describe("脚注", () => {
  it("插入引用和定义，编号递增，可以往返", async () => {
    const e = await setup("正文[^1]\n\n[^1]: 已有\n");
    select(e, 3, 3);
    expect(insertFootnote(e)).toBe(true);
    const md = readMarkdown(e);
    expect(md).toContain("[^2]");
    expect(md).toMatch(/^\[\^2\]:/m);
    expect(md).toContain("[^1]: 已有");
  });
});

describe("查找与替换", () => {
  it("普通查找、大小写、正则替换", async () => {
    const e = await setup("同步 Sync sync\n\n再同步一次\n");
    const plain = buildPattern("sync", { caseSensitive: false, regex: false })!;
    expect(findMatches(currentDoc(e), plain)).toHaveLength(2);
    const cs = buildPattern("sync", { caseSensitive: true, regex: false })!;
    expect(findMatches(currentDoc(e), cs)).toHaveLength(1);
    const zh = buildPattern("同步", { caseSensitive: false, regex: false })!;
    const zhMatches = findMatches(currentDoc(e), zh);
    expect(zhMatches).toHaveLength(2);
    replaceOne(e, zhMatches[1], zh, "同步过", false);
    expect(readMarkdown(e)).toContain("再同步过一次");

    const re = buildPattern("(s)ync", { caseSensitive: false, regex: true })!;
    const n = replaceAll(e, findMatches(currentDoc(e), re), re, "$1YNC", true);
    expect(n).toBe(2);
    expect(readMarkdown(e)).toContain("SYNC sYNC");
  });

  it("无效正则返回 null；特殊字符按字面查找", () => {
    expect(buildPattern("(", { caseSensitive: false, regex: true })).toBeNull();
    expect(buildPattern("a.b", { caseSensitive: false, regex: false })!.test("axb")).toBe(false);
  });

  it("双向链接占一个位置，不影响后面的定位", async () => {
    const e = await setup("见 [[周报]] 同步\n");
    const p = buildPattern("同步", { caseSensitive: false, regex: false })!;
    const [m] = findMatches(currentDoc(e), p);
    replaceOne(e, m, p, "OK", false);
    expect(readMarkdown(e).trim()).toBe("见 [[周报]] OK");
  });
});

describe("链接", () => {
  it("给选中文字加链接、修改、移除；空选区时插入地址", async () => {
    const e = await setup("点这里\n");
    select(e, 1, 4);
    applyLink(e, "https://a.com");
    expect(readMarkdown(e).trim()).toBe("[点这里](https://a.com)");
    select(e, 2, 2);
    expect(currentLink(e).href).toBe("https://a.com");
    applyLink(e, "https://b.com");
    expect(readMarkdown(e).trim()).toBe("[点这里](https://b.com)");
    select(e, 2, 2);
    applyLink(e, "");
    expect(readMarkdown(e).trim()).toBe("点这里");
    select(e, 4, 4);
    applyLink(e, "https://c.com");
    expect(readMarkdown(e).trim()).toBe("点这里<https://c.com>");
  });
});

describe("斜杠菜单与浮动格式条", () => {
  async function setupWithFormat(markdown: string, ran: string[]) {
    const root = document.createElement("div");
    document.body.append(root);
    editor = await createEditor({
      root, markdown,
      onChange: () => {}, onCursor: () => {}, onWords: () => {},
      onError: (c, e) => { throw new Error(`${c}: ${e}`); },
      format: {
        run: (id) => {
          ran.push(id);
          if (id === "table") FORMAT_ACTIONS.table.run!(editor!);
        },
        shortcut: () => null,
      },
    });
    return editor;
  }

  it("输入 /bg 后回车：删除斜杠文字并插入表格", async () => {
    const ran: string[] = [];
    const e = await setupWithFormat("x\n", ran);
    e.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 2)).insertText("/bg"));
      expect((document.querySelector(".slash") as HTMLElement).style.display).toBe("block");
      const handled = view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: "Enter" })));
      expect(handled).toBe(true);
    });
    expect(ran).toEqual(["table"]);
    expect(readMarkdown(e)).not.toContain("/bg");
    expect(readMarkdown(e)).toMatch(/^\|/m);
  });

  it("Esc 关闭后同一个 / 不再弹出", async () => {
    const e = await setupWithFormat("x\n", []);
    e.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 2)).insertText("/"));
      view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: "Escape" })));
      view.dispatch(view.state.tr.insertText("b"));
    });
    expect((document.querySelector(".slash") as HTMLElement).style.display).toBe("none");
  });

  it("选中文字时显示浮动格式条，并标出已有格式", async () => {
    const e = await setupWithFormat("**粗** 普通\n", []);
    e.action((ctx) => ctx.get(editorViewCtx).focus());
    select(e, 1, 2);
    const bar = document.querySelector(".floatbar") as HTMLElement;
    expect(bar.style.display).toBe("flex");
    expect(bar.querySelector(".btn")!.classList.contains("is-active")).toBe(true);
    select(e, 3, 3);
    expect(bar.style.display).toBe("none");
  });
});

describe("斜杠菜单筛选", () => {
  it("按名称、英文、拼音首字母筛选", () => {
    expect(filterSlash("").length).toBeGreaterThan(10);
    expect(filterSlash("标题").map((i) => i.id)).toEqual(["h1", "h2", "h3"]);
    expect(filterSlash("bg").map((i) => i.id)).toEqual(["table"]);
    expect(filterSlash("code").map((i) => i.id)).toEqual(["codeBlock"]);
    expect(filterSlash("不存在")).toEqual([]);
  });
});
