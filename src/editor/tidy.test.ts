// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { undo } from "@milkdown/kit/prose/history";
import { createEditor, readMarkdown } from "./createEditor";
import { DEFAULT_TIDY_RULES, describeTidy, fixHeadingLevels, normalizeTidyRules, tidyString, tidyTransaction, type TidyRules } from "./tidy";

const only = (id: keyof TidyRules): TidyRules =>
  Object.fromEntries(Object.keys(DEFAULT_TIDY_RULES).map((k) => [k, k === id])) as TidyRules;

describe("文字规则", () => {
  it("中英文之间加空格", () => {
    expect(tidyString("使用React开发，版本1.0发布")).toBe("使用 React 开发，版本 1.0 发布");
    expect(tidyString("中文 English", only("cjkSpacing"))).toBe("中文 English");
  });

  it("中文后的半角标点改全角，并去掉标点后的空格", () => {
    expect(tidyString("你好,世界! 真的吗?", only("cjkPunct"))).toBe("你好，世界！真的吗？");
    expect(tidyString("时间:10点;地点:北京.", only("cjkPunct"))).toBe("时间：10点；地点：北京。");
    expect(tidyString("你好 , 世界", only("cjkPunct"))).toBe("你好，世界");
  });

  it("不改英文里的标点、小数点、省略号和文件名", () => {
    const keep = ["Hello, world.", "版本 1.0 发布", "中文...English", "打开 readme.md 看看", "a,b;c", "http://x.com"];
    for (const s of keep) expect(tidyString(s, only("cjkPunct"))).toBe(s);
    expect(tidyString("笔记.md", only("cjkPunct"))).toBe("笔记.md");
  });

  it("全角英文和数字改半角", () => {
    expect(tidyString("ＡＢＣ１２３和ｘｙｚ", only("fullwidthAlnum"))).toBe("ABC123和xyz");
    expect(tidyString("ＡＢＣ１２３和ｘｙｚ")).toBe("ABC123 和 xyz");
  });

  it("去掉行尾空格", () => {
    expect(tidyString("第一行  \n第二行\t ", only("trailingSpace"))).toBe("第一行\n第二行");
    expect(tidyString("中间 的 空格", only("trailingSpace"))).toBe("中间 的 空格");
  });

  it("全部关闭时不改任何内容", () => {
    const off = normalizeTidyRules(Object.fromEntries(Object.keys(DEFAULT_TIDY_RULES).map((k) => [k, false])));
    expect(tidyString("使用React,ＡＢＣ  ", off)).toBe("使用React,ＡＢＣ  ");
  });

  it("读取设置时补齐缺失的规则、忽略非法值", () => {
    expect(normalizeTidyRules({ cjkSpacing: false, headingLevels: "yes" })).toEqual({ ...DEFAULT_TIDY_RULES, cjkSpacing: false });
    expect(normalizeTidyRules(null)).toEqual(DEFAULT_TIDY_RULES);
  });
});

describe("标题跳级", () => {
  it("每级最多比上级深一级，子标题跟着上移", () => {
    expect(fixHeadingLevels([1, 3, 4, 3, 2, 4])).toEqual([1, 2, 3, 2, 2, 3]);
    expect(fixHeadingLevels([3, 4, 2])).toEqual([3, 4, 2]);
    expect(fixHeadingLevels([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("在编辑器里整理", () => {
  let editor: Editor | null = null;

  afterEach(async () => {
    await editor?.destroy();
    editor = null;
    document.body.innerHTML = "";
  });

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

  function run(e: Editor, rules: TidyRules = DEFAULT_TIDY_RULES) {
    return e.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { tr, counts, total } = tidyTransaction(view.state, rules);
      if (tr.docChanged) view.dispatch(tr);
      return { counts, total };
    });
  }

  it("保留加粗、链接等格式，不动行内代码和代码块", async () => {
    const e = await setup("使用**React**开发,运行`npm run 构建`命令。见[官网](https://a.com/x,y)说明\n\n```js\nconst a=1,中文=2\n```\n");
    const { counts } = run(e);
    expect(readMarkdown(e)).toBe("使用 **React** 开发，运行 `npm run 构建` 命令。见[官网](https://a.com/x,y)说明\n\n```js\nconst a=1,中文=2\n```\n");
    expect(counts.cjkPunct).toBe(1);
    expect(counts.cjkSpacing).toBe(4);
  });

  it("双向链接原样保留", async () => {
    const e = await setup("参考[[编辑器选型|选型]]和[[Rust 笔记]],再看看\n");
    run(e);
    expect(readMarkdown(e)).toBe("参考[[编辑器选型|选型]]和[[Rust 笔记]]，再看看\n");
  });

  it("有选区时只整理选中的部分", async () => {
    const e = await setup("第一段English\n\n第二段English\n");
    e.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 11)));
    });
    run(e);
    expect(readMarkdown(e)).toBe("第一段 English\n\n第二段English\n");
  });

  it("整理结果一步撤销", async () => {
    const src = "使用React,ＡＢＣ\n";
    const e = await setup(src);
    run(e);
    expect(readMarkdown(e)).not.toBe(src);
    e.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      undo(view.state, view.dispatch);
    });
    expect(readMarkdown(e)).toBe(src);
  });

  it("修正标题跳级（默认关闭）", async () => {
    const e = await setup("# 一\n\n### 三\n\n#### 四\n");
    expect(run(e).counts.headingLevels).toBe(0);
    const { counts } = run(e, { ...DEFAULT_TIDY_RULES, headingLevels: true });
    expect(counts.headingLevels).toBe(2);
    expect(readMarkdown(e)).toBe("# 一\n\n## 三\n\n### 四\n");
  });

  it("没有需要整理的地方时不产生改动", async () => {
    const e = await setup("已经很整齐的 English 句子。\n");
    const { total, counts } = run(e);
    expect(total).toBe(0);
    expect(describeTidy(counts)).toBe("没有需要整理的地方");
  });
});

describe("状态栏提示", () => {
  it("按规则列出处数", () => {
    const counts = { cjkSpacing: 12, cjkPunct: 5, fullwidthAlnum: 0, blankLines: 0, trailingSpace: 0, headingLevels: 0 };
    expect(describeTidy(counts)).toBe("已整理 17 处：中英文空格 12 处、标点 5 处");
  });
});
