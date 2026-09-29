import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey, Selection, type EditorState } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { closeHistory } from "@milkdown/kit/prose/history";
import type { AiRun } from "../stores/ai";

/** 斜杠菜单“AI 指令”：在光标处输入指令，回答流入待确认区域（需求文档 5.16） */
export interface AiBlockHost {
  /** 当前笔记的字数，用于“附带当前笔记（约 N 字）” */
  noteWords: () => number;
  /** 发出请求；笔记过长等情况直接抛出错误 */
  start: (instruction: string, withNote: boolean, onText: (full: string) => void) => AiRun;
  /** 撤销的快捷键，用于提示 */
  undoKey: () => string;
  isCancel: (e: unknown) => boolean;
}

interface BlockState {
  pos: number | null;
}

const key = new PluginKey<BlockState>("ttnote-ai-block");

type Phase = "prompt" | "running" | "done" | "error";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function sparkle(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ico ico-sm ai-mark");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-sparkle");
  svg.append(use);
  return svg;
}

class AiBlock {
  readonly dom = el("div", "ai-block");
  private phase: Phase = "prompt";
  private instruction = "";
  private withNote = true;
  private result = "";
  private error = "";
  private run: AiRun | null = null;
  private input: HTMLInputElement | null = null;

  constructor(private editor: Editor, private host: AiBlockHost) {
    this.dom.contentEditable = "false";
    this.render();
  }

  private view(): EditorView {
    return this.editor.action((ctx) => ctx.get(editorViewCtx));
  }

  private render() {
    this.dom.replaceChildren();
    if (this.phase === "prompt") this.renderPrompt();
    else this.renderPending();
  }

  private renderPrompt() {
    const box = el("div", "ai-box");
    const row = el("div", "ai-input");
    const input = el("input");
    input.placeholder = "告诉 AI 要写什么，例如：根据上文续写一段“冲突处理”的说明";
    input.value = this.instruction;
    input.setAttribute("aria-label", "AI 指令");
    const send = el("button", "btn-primary", "发送");
    send.type = "button";
    const go = () => {
      this.instruction = input.value.trim();
      if (this.instruction) this.start();
    };
    send.addEventListener("click", go);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        go();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    row.append(sparkle(), input, send);
    const foot = el("div", "ai-foot");
    const label = el("label", "git-check");
    const check = el("input");
    check.type = "checkbox";
    check.checked = this.withNote;
    check.addEventListener("change", () => (this.withNote = check.checked));
    label.append(check, `附带当前笔记（约 ${this.host.noteWords().toLocaleString("zh-CN")} 字）`);
    foot.append(label, el("span", "hint", "Enter 发送 · Esc 取消"));
    box.append(row, foot);
    this.dom.append(box);
    this.input = input;
  }

  private renderPending() {
    const box = el("div", "ai-pend");
    const head = el("div", "ai-pend-head");
    const state = { running: "生成中…", done: "待确认", error: "失败", prompt: "" }[this.phase];
    head.append(sparkle(), el("span", "q", this.instruction), el("span", "ai-state", state));
    const body = el("div", "ai-pend-body");
    if (this.phase === "error") body.append(el("p", "git-error", this.error));
    else body.textContent = this.result || "正在等待回复…";
    if (this.phase === "running") body.append(el("span", "caret"));
    const foot = el("div", "ai-pend-foot");
    const button = (text: string, cls: string, fn: () => void) => {
      const b = el("button", cls, text);
      b.type = "button";
      b.addEventListener("click", fn);
      foot.append(b);
    };
    if (this.phase === "running") button("停止", "fb-txt", () => this.stop());
    if (this.phase === "done") button("接受", "btn-primary", () => this.accept());
    if (this.phase !== "running") {
      button("放弃", "fb-txt", () => this.close());
      button("重新生成", "fb-txt", () => this.start());
    }
    if (this.phase === "done") {
      const undo = this.host.undoKey();
      if (undo) foot.append(el("span", "hint", `接受后可用 ${undo} 撤销`));
    }
    box.append(head, body, foot);
    this.dom.append(box);
    this.input = null;
  }

  focus() {
    setTimeout(() => this.input?.focus(), 0);
  }

  private start() {
    this.run?.cancel();
    this.result = "";
    this.error = "";
    try {
      const run = this.host.start(this.instruction, this.withNote, (full) => {
        this.result = full;
        const body = this.dom.querySelector(".ai-pend-body");
        if (body) {
          body.textContent = full;
          body.append(el("span", "caret"));
        }
      });
      this.run = run;
      this.phase = "running";
      this.render();
      run.done.then(
        (text) => {
          if (this.run !== run) return;
          this.result = text;
          this.phase = text.trim() ? "done" : "error";
          if (!text.trim()) this.error = "AI 没有返回内容";
          this.render();
        },
        (e: unknown) => {
          if (this.run !== run || this.host.isCancel(e)) return;
          this.error = e instanceof Error ? e.message : String(e);
          this.phase = "error";
          this.render();
        },
      );
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.phase = "error";
      this.render();
    }
  }

  /** 停止后已收到的内容仍可接受 */
  private stop() {
    const run = this.run;
    this.run = null;
    run?.cancel();
    this.phase = this.result.trim() ? "done" : "error";
    if (!this.result.trim()) this.error = "已停止";
    this.render();
  }

  private accept() {
    const view = this.view();
    const pos = key.getState(view.state)?.pos;
    if (pos == null) return;
    const doc = this.editor.action((ctx) => ctx.get(parserCtx)(this.result.trim()));
    if (!doc) {
      this.error = "无法解析 AI 的回答";
      this.phase = "error";
      this.render();
      return;
    }
    const target = view.state.doc.nodeAt(pos);
    const replaceEmpty = !!target && target.type.name === "paragraph" && target.content.size === 0;
    const tr = closeHistory(view.state.tr);
    try {
      if (replaceEmpty) tr.replaceWith(pos, pos + target.nodeSize, doc.content);
      else tr.insert(pos, doc.content);
    } catch (e) {
      this.error = `无法插入到这个位置：${e instanceof Error ? e.message : String(e)}`;
      this.phase = "error";
      this.render();
      return;
    }
    const end = tr.mapping.map(pos + (replaceEmpty ? target.nodeSize : 0));
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1));
    tr.setMeta(key, { pos: null });
    this.dispose();
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }

  close() {
    const view = this.view();
    this.dispose();
    view.dispatch(view.state.tr.setMeta(key, { pos: null }));
    view.focus();
  }

  dispose() {
    this.run?.cancel();
    this.run = null;
    if (active === this) active = null;
  }
}

let active: AiBlock | null = null;

export const aiBlockPlugin = $prose(() => new Plugin<BlockState>({
  key,
  state: {
    init: () => ({ pos: null }),
    apply(tr, prev) {
      const meta = tr.getMeta(key) as BlockState | undefined;
      if (meta) return meta;
      return prev.pos == null ? prev : { pos: tr.mapping.map(prev.pos, -1) };
    },
  },
  props: {
    decorations(state: EditorState) {
      const pos = key.getState(state)?.pos;
      if (pos == null || !active) return null;
      const block = active;
      return DecorationSet.create(state.doc, [
        Decoration.widget(pos, () => block.dom, { key: "ai-block", side: -1, stopEvent: () => true, ignoreSelection: true }),
      ]);
    },
  },
  view: () => ({ destroy: () => active?.dispose() }),
}));

/** 在光标所在段落前打开 AI 指令输入框 */
export function openAiBlock(editor: Editor, host: AiBlockHost): void {
  active?.dispose();
  const block = new AiBlock(editor, host);
  active = block;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { $from } = view.state.selection;
    const pos = $from.depth > 0 ? $from.before($from.depth) : $from.pos;
    view.dispatch(view.state.tr.setMeta(key, { pos }));
  });
  block.focus();
}
