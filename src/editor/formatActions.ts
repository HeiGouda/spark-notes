import type { CmdKey, Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { callCommand } from "@milkdown/kit/utils";
import type { EditorView } from "@milkdown/kit/prose/view";
import { undoCommand, redoCommand } from "@milkdown/kit/plugin/history";
import {
  createCodeBlockCommand,
  insertHrCommand,
  liftListItemCommand,
  sinkListItemCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import { insertTableCommand, toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { startWikiLink } from "./wikilink";
import { toggleHighlight } from "./highlight";
import { insertFootnote } from "./footnote";

/**
 * 格式工具清单，对应需求文档 4.3。快捷键为默认值，实际快捷键见命令注册表（可自定义）；
 * 有 `command` 的工具（需要弹窗等交互）通过应用命令执行。
 */
export interface FormatAction {
  id: string;
  title: string;
  shortcut: string | null;
  run: ((editor: Editor) => boolean) | null;
  /** 需要弹窗等异步交互的工具改为调用应用命令 */
  command?: string;
}

/** 命令的 key 在插件初始化后才赋值，必须在执行时读取 */
const cmd = <T>(command: { key: CmdKey<T> }, payload?: T) =>
  (editor: Editor) => editor.action(callCommand(command.key, payload));

const withView = (fn: (view: EditorView) => boolean) =>
  (editor: Editor) => editor.action((ctx) => fn(ctx.get(editorViewCtx)));

function clearFormat(view: EditorView): boolean {
  const { from, to, empty } = view.state.selection;
  const tr = empty ? view.state.tr.setStoredMarks([]) : view.state.tr.removeMark(from, to, null);
  view.dispatch(tr);
  return true;
}

/** 切换任务列表：不在列表中时先转为无序列表，再在普通项与任务项之间切换 */
function toggleTaskList(editor: Editor): boolean {
  const findItem = (view: EditorView) => {
    const { $from } = view.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type.name === "list_item") return { node, pos: $from.before(d) };
    }
    return null;
  };
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (!findItem(view)) callCommand(wrapInBulletListCommand.key)(ctx);
    const item = findItem(view);
    if (!item) return false;
    const checked = item.node.attrs.checked == null ? false : null;
    view.dispatch(view.state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked }));
    return true;
  });
}

export const HEADING_SHORTCUTS = ["Ctrl+0", "Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4", "Ctrl+5", "Ctrl+6"];

export function setBlockLevel(editor: Editor, level: number): boolean {
  return level === 0
    ? editor.action(callCommand(turnIntoTextCommand.key))
    : editor.action(callCommand(wrapInHeadingCommand.key, level));
}

export const FORMAT_ACTIONS: Record<string, FormatAction> = {
  undo: { id: "undo", title: "撤销", shortcut: "Ctrl+Z", run: cmd(undoCommand), command: "edit.undo" },
  redo: { id: "redo", title: "重做", shortcut: "Ctrl+Y", run: cmd(redoCommand), command: "edit.redo" },
  strong: { id: "strong", title: "加粗", shortcut: "Ctrl+B", run: cmd(toggleStrongCommand) },
  emphasis: { id: "emphasis", title: "斜体", shortcut: "Ctrl+I", run: cmd(toggleEmphasisCommand) },
  strike: { id: "strike", title: "删除线", shortcut: "Ctrl+Shift+X", run: cmd(toggleStrikethroughCommand) },
  highlight: { id: "highlight", title: "高亮", shortcut: "Ctrl+Shift+H", run: toggleHighlight },
  inlineCode: { id: "inlineCode", title: "行内代码", shortcut: "Ctrl+E", run: cmd(toggleInlineCodeCommand) },
  clear: { id: "clear", title: "清除格式", shortcut: "Ctrl+\\", run: withView(clearFormat) },
  bulletList: { id: "bulletList", title: "无序列表", shortcut: "Ctrl+Shift+8", run: cmd(wrapInBulletListCommand) },
  orderedList: { id: "orderedList", title: "有序列表", shortcut: "Ctrl+Shift+7", run: cmd(wrapInOrderedListCommand) },
  taskList: { id: "taskList", title: "任务列表", shortcut: "Ctrl+Shift+9", run: toggleTaskList },
  indent: { id: "indent", title: "增加缩进", shortcut: "Tab", run: cmd(sinkListItemCommand) },
  outdent: { id: "outdent", title: "减少缩进", shortcut: "Shift+Tab", run: cmd(liftListItemCommand) },
  quote: { id: "quote", title: "引用", shortcut: "Ctrl+Shift+Q", run: cmd(wrapInBlockquoteCommand) },
  codeBlock: { id: "codeBlock", title: "代码块", shortcut: "Ctrl+Shift+K", run: cmd(createCodeBlockCommand) },
  hr: { id: "hr", title: "分割线", shortcut: null, run: cmd(insertHrCommand) },
  link: { id: "link", title: "链接", shortcut: "Ctrl+K", run: null, command: "insert.link" },
  wikilink: { id: "wikilink", title: "双向链接", shortcut: null, run: startWikiLink },
  image: { id: "image", title: "图片", shortcut: "Ctrl+Shift+I", run: null, command: "insert.image" },
  table: { id: "table", title: "表格", shortcut: "Ctrl+T", run: cmd(insertTableCommand, { row: 3, col: 3 }) },
  footnote: { id: "footnote", title: "脚注", shortcut: null, run: insertFootnote },
  tidy: { id: "tidy", title: "一键整理", shortcut: "Ctrl+Shift+L", run: null, command: "format.tidy" },
  ai: { id: "ai", title: "AI 指令", shortcut: null, run: null, command: "ai.instruction" },
  find: { id: "find", title: "查找", shortcut: "Ctrl+F", run: null, command: "edit.find" },
  replace: { id: "replace", title: "替换", shortcut: "Ctrl+H", run: null, command: "edit.replace" },
};

/** 工具对应的命令 id（快捷键按命令记录，可自定义） */
export function commandIdOf(actionId: string): string {
  return FORMAT_ACTIONS[actionId]?.command ?? `format.${actionId}`;
}

export const HEADING_LABELS = ["正文", "标题 1", "标题 2", "标题 3", "标题 4", "标题 5", "标题 6"];
