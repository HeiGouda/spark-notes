// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { undo } from "@milkdown/kit/prose/history";
import { createEditor, readMarkdown } from "./createEditor";
import { openAiBlock, type AiBlockHost } from "./aiBlock";
import { AiCancelled, type AiRun } from "../stores/ai";

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

/** 可以手动推送文字、结束的假请求 */
function fakeHost() {
  let push: (t: string) => void = () => {};
  let finish: (t: string) => void = () => {};
  let fail: (e: unknown) => void = () => {};
  const calls: { instruction: string; withNote: boolean }[] = [];
  let text = "";
  const host: AiBlockHost = {
    noteWords: () => 42,
    start: (instruction, withNote, onText) => {
      calls.push({ instruction, withNote });
      text = "";
      push = (t) => {
        text += t;
        onText(text);
      };
      const done = new Promise<string>((res, rej) => {
        finish = (t) => res(t);
        fail = rej;
      });
      const run: AiRun = { done, cancel: () => fail(new AiCancelled()) };
      return run;
    },
    undoKey: () => "Ctrl+Z",
    isCancel: (e) => e instanceof AiCancelled,
  };
  return { host, calls, push: (t: string) => push(t), finish: () => finish(text) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function cursorAt(e: Editor, pos: number) {
  e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  });
}

function send(instruction: string) {
  const input = document.querySelector<HTMLInputElement>(".ai-box input[aria-label='AI 指令']")!;
  input.value = instruction;
  document.querySelector<HTMLButtonElement>(".ai-box .btn-primary")!.click();
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".ai-pend-foot button")].find((b) => b.textContent === label)!;

describe("AI 指令", () => {
  it("回答流入待确认区域，接受后插入并可一步撤销", async () => {
    const e = await setup("第一段\n\n\n\n第三段\n");
    // 光标放到第一段后面插入的空段落里
    e.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insert(5, view.state.schema.nodes.paragraph.create()));
    });
    cursorAt(e, 6);
    const before = readMarkdown(e);
    const fake = fakeHost();
    openAiBlock(e, fake.host);
    expect(document.querySelector(".ai-box")?.textContent).toContain("附带当前笔记（约 42 字）");

    send("续写一段");
    expect(fake.calls).toEqual([{ instruction: "续写一段", withNote: true }]);
    fake.push("**冲突**时");
    fake.push("两份都保留");
    expect(document.querySelector(".ai-pend-body")?.textContent).toBe("**冲突**时两份都保留");
    expect(readMarkdown(e)).toBe(before);

    fake.finish();
    await tick();
    expect(document.querySelector(".ai-state")?.textContent).toBe("待确认");
    button("接受").click();
    expect(readMarkdown(e)).toBe("第一段\n\n**冲突**时两份都保留\n\n第三段\n");
    expect(document.querySelector(".ai-block")).toBeNull();

    e.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      undo(view.state, view.dispatch);
    });
    expect(readMarkdown(e)).toBe(before);
  });

  it("放弃不改动笔记；停止后已收到的内容仍可接受", async () => {
    const e = await setup("正文\n");
    cursorAt(e, 3);
    const fake = fakeHost();
    openAiBlock(e, fake.host);
    send("写个提纲");
    fake.push("一、背景");
    button("停止").click();
    await tick();
    expect(document.querySelector(".ai-state")?.textContent).toBe("待确认");
    button("放弃").click();
    expect(readMarkdown(e)).toBe("正文\n");
    expect(document.querySelector(".ai-block")).toBeNull();
  });

  it("请求失败时显示原因，可以重新生成", async () => {
    const e = await setup("正文\n");
    const host: AiBlockHost = {
      ...fakeHost().host,
      start: () => { throw new Error("笔记过长"); },
    };
    openAiBlock(e, host);
    send("总结");
    expect(document.querySelector(".ai-pend .git-error")?.textContent).toBe("笔记过长");
    expect(button("重新生成")).toBeTruthy();
  });
});
