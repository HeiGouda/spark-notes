import { Editor, defaultValueCtx, editorViewOptionsCtx, remarkStringifyOptionsCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark, remarkPreserveEmptyLinePlugin } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { trailing } from "@milkdown/kit/plugin/trailing";
import { $prose, $remark, getMarkdown } from "@milkdown/kit/utils";
import { Plugin, TextSelection, type Command, type EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node } from "@milkdown/kit/prose/model";
import { keydownHandler } from "@milkdown/kit/prose/keymap";
import { exitCode } from "@milkdown/kit/prose/commands";
import { prism } from "@milkdown/plugin-prism";
import { codeBlockView } from "./codeBlockView";
import { handleDrop, handlePaste, imageView, type AttachmentHost } from "./attachments";
import { editorLinkClick } from "./link";
import { tableBarPlugin } from "./tableBar";
import { headingsOf, type Heading } from "./navigate";
import { suggestHandlesKey, wikiClick, wikiPlugins, wikiStringifyHandlers, type WikiHost } from "./wikilink";
import { highlightPlugins, highlightStringifyHandlers } from "./highlight";
import { floatBarPlugin, slashHandlesKey, slashPlugin, type FormatHost } from "./popups";
import { findPlugin } from "./find";
import { aiBlockPlugin } from "./aiBlock";
import { countWords } from "../lib/wordcount";
import type { ActiveMarks } from "../stores/editor";

export interface CursorInfo {
  block: string;
  marks: ActiveMarks;
  line: number;
  col: number;
  pos: number;
}

export interface EditorOptions {
  root: HTMLElement;
  markdown: string;
  onChange: (markdown: string) => void;
  onCursor: (info: CursorInfo) => void;
  onWords: (words: number) => void;
  /** 文档内容变化（每次变化立即调用） */
  onDocChange?: () => void;
  /** 文档变化后的标题列表（大纲） */
  onOutline?: (headings: Heading[]) => void;
  onError: (context: string, err: unknown) => void;
  /** 附件的保存与显示；不提供时（如测试）图片按原始 src 显示，不处理粘贴 / 拖入文件 */
  attachments?: Omit<AttachmentHost, "onError">;
  /** 双向链接的补全与跳转；不提供时链接只显示、不弹补全 */
  wiki?: WikiHost;
  /** 编辑器内按键：按当前快捷键执行编辑器命令，已处理时返回 true */
  onKey?: (event: KeyboardEvent) => boolean;
  /** 浮动格式条与斜杠菜单 */
  format?: FormatHost;
  /** 点击链接时打开 */
  onOpenLink?: (href: string) => void;
}

interface MdNode {
  type: string;
  title?: string | null;
  children?: MdNode[];
}

/** Milkdown 把 remark 给出的 `title: null` 直接交给 ProseMirror，没有标题的图片会解析失败 */
const imageTitleFix = $remark("ttnote-image-title", () => () => (tree: unknown) => {
  const walk = (n: MdNode) => {
    if (n.type === "image" && n.title == null) delete n.title;
    n.children?.forEach(walk);
  };
  walk(tree as MdNode);
});

/**
 * 去掉“保留空行”插件：它会把空段落写成 `<br />`，往纯 Markdown 文件里混入 HTML。
 * 空段落按标准 Markdown 处理（保存时省略）。
 */
const commonmarkPlugins = commonmark.filter(
  (p) => p !== remarkPreserveEmptyLinePlugin.plugin && p !== remarkPreserveEmptyLinePlugin.options,
);

/** 行首输入 ```语言 后回车，生成代码框（Typora 方式） */
const codeFenceOnEnter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== "paragraph") return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  const m = /^```([^\s`]*)$/.exec($from.parent.textContent);
  if (!m) return false;
  const start = $from.before();
  const tr = state.tr.replaceWith(start, $from.after(), state.schema.nodes.code_block.create({ language: m[1] }));
  tr.setSelection(TextSelection.create(tr.doc, start + 1));
  dispatch?.(tr.scrollIntoView());
  return true;
};

/** 代码框内回车保持当前行缩进 */
const newlineKeepIndent: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.name !== "code_block") return false;
  const before = $from.parent.textContent.slice(0, $from.parentOffset);
  const indent = /^[ \t]*/.exec(before.slice(before.lastIndexOf("\n") + 1))?.[0] ?? "";
  dispatch?.(state.tr.insertText("\n" + indent).scrollIntoView());
  return true;
};

const tabInCode: Command = (state, dispatch) => {
  if (state.selection.$from.parent.type.name !== "code_block") return false;
  dispatch?.(state.tr.insertText("    ").scrollIntoView());
  return true;
};

function cursorInfo(state: EditorState): CursorInfo {
  const { selection, doc, schema } = state;
  const { $head, from, to, empty } = selection;
  const has = (name: string) => {
    const type = schema.marks[name];
    if (!type) return false;
    return empty ? !!type.isInSet(state.storedMarks ?? $head.marks()) : doc.rangeHasMark(from, to, type);
  };
  const parent = $head.parent;
  let line = 0;
  doc.nodesBetween(0, $head.pos, (n) => {
    if (n.isTextblock) {
      line++;
      return false;
    }
    return true;
  });
  let col = $head.parentOffset + 1;
  if (parent.type.name === "code_block") {
    const before = parent.textContent.slice(0, $head.parentOffset);
    line += (before.match(/\n/g) ?? []).length;
    col = before.length - before.lastIndexOf("\n");
  }
  return {
    block: parent.type.name === "heading" ? `H${parent.attrs.level}` : "正文",
    marks: {
      strong: has("strong"),
      emphasis: has("emphasis"),
      strike: has("strike_through"),
      code: has("inlineCode"),
      highlight: has("highlight"),
      link: has("link"),
    },
    line: Math.max(line, 1),
    col,
    pos: $head.pos,
  };
}

/** 点击任务项左侧的复选框切换完成状态 */
function toggleTaskOnClick(view: EditorView, _pos: number, node: Node, nodePos: number, event: MouseEvent): boolean {
  if (node.type.name !== "list_item" || node.attrs.checked == null) return false;
  const dom = view.nodeDOM(nodePos);
  if (!(dom instanceof HTMLElement)) return false;
  const rect = dom.getBoundingClientRect();
  if (event.clientX - rect.left > 22) return false;
  view.dispatch(view.state.tr.setNodeMarkup(nodePos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
  return true;
}

export async function createEditor(opts: EditorOptions): Promise<Editor> {
  let editor: Editor | null = null;

  // 与编辑位置相关、不可自定义的按键；格式快捷键按命令表中当前生效的快捷键分发（opts.onKey）
  const bindings: Record<string, Command> = {
    Enter: (s, d, v) => codeFenceOnEnter(s, d, v) || newlineKeepIndent(s, d, v),
    "Mod-Enter": exitCode,
    Tab: tabInCode,
  };
  const fixedKeys = keydownHandler(bindings);
  const onKeyDown = (view: EditorView, event: KeyboardEvent): boolean => {
    if (fixedKeys(view, event)) return true;
    if (!opts.onKey || !editor) return false;
    try {
      return opts.onKey(event);
    } catch (err) {
      opts.onError("执行快捷键失败", err);
      return true;
    }
  };

  let wordTimer = 0;
  let lastDoc: Node | null = null;
  const report = (state: EditorState) => {
    opts.onCursor(cursorInfo(state));
    if (state.doc === lastDoc) return;
    lastDoc = state.doc;
    opts.onDocChange?.();
    clearTimeout(wordTimer);
    wordTimer = window.setTimeout(() => {
      opts.onWords(countWords(state.doc.textBetween(0, state.doc.content.size, "\n", "\n")));
      opts.onOutline?.(headingsOf(state.doc));
    }, 150);
  };
  const cursorPlugin = $prose(() => new Plugin({
    view: (view) => {
      report(view.state);
      return { update: (v) => report(v.state), destroy: () => clearTimeout(wordTimer) };
    },
  }));

  const host: AttachmentHost | null = opts.attachments ? { ...opts.attachments, onError: opts.onError } : null;

  const make = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, opts.root);
      ctx.set(defaultValueCtx, opts.markdown);
      // 与多数 Markdown 编辑器的默认写法一致，减少保存时对原文的改写
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({
        ...prev,
        bullet: "-" as const,
        rule: "-" as const,
        handlers: { ...prev.handlers, ...wikiStringifyHandlers, ...highlightStringifyHandlers } as typeof prev.handlers,
      }));
      const openWiki = wikiClick(opts.wiki);
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        attributes: { class: "pm", spellcheck: "false" },
        // 双向链接补全、斜杠菜单打开时，方向键 / 回车 / Tab / Esc 交给弹窗
        handleKeyDown: (view, event) =>
          (suggestHandlesKey(view.state, event) && opts.wiki) || (slashHandlesKey(view.state, event) && opts.format)
            ? false
            : onKeyDown(view, event),
        handleClickOn: (view, pos, node, nodePos, event, direct) =>
          toggleTaskOnClick(view, pos, node, nodePos, event) || (direct && openWiki(view, pos, node)),
        // 在 click 上阻止默认行为：只在 mouseup 里 preventDefault 拦不住 <a>，WebView 会自己跳转并失败
        handleDOMEvents: {
          click: (view, event) => {
            const href = editorLinkClick(view, event);
            if (href == null) return false;
            event.preventDefault();
            if (href) opts.onOpenLink?.(href);
            return true;
          },
        },
        ...(host ? { handlePaste: handlePaste(host), handleDrop: handleDrop(host) } : {}),
      }));
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prev) => {
        if (markdown !== prev) opts.onChange(markdown);
      });
    })
    .use(imageTitleFix)
    .use(commonmarkPlugins)
    .use(wikiPlugins(opts.wiki))
    .use(highlightPlugins)
    .use(gfm)
    .use(tableBarPlugin())
    .use(history)
    .use(listener)
    .use(clipboard)
    .use(trailing)
    .use(prism)
    .use(codeBlockView)
    .use(cursorPlugin)
    .use(findPlugin)
    .use(aiBlockPlugin);
  if (host) make.use(imageView(host));
  if (opts.format) make.use([floatBarPlugin(opts.format), slashPlugin(opts.format)].flat());
  editor = await make.create();
  return editor;
}

export function readMarkdown(editor: Editor): string {
  return editor.action(getMarkdown());
}
