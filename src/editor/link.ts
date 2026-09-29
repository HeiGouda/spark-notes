import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorState } from "@milkdown/kit/prose/state";
import type { MarkType } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";

/** 插入 / 修改 / 移除链接（Ctrl+K，原型 M4 浮层 6） */

/** 光标所在链接的范围；选区为空时向两侧扩展到整段链接文字 */
function linkRange(state: EditorState, type: MarkType): { from: number; to: number; href: string } | null {
  const { $from, from, to, empty } = state.selection;
  if (!empty) {
    let href: string | null = null;
    state.doc.nodesBetween(from, to, (n) => {
      const m = type.isInSet(n.marks);
      if (m && href === null) href = m.attrs.href as string;
    });
    return href === null ? null : { from, to, href };
  }
  const parent = $from.parent;
  const start = $from.start();
  let offset = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const mark = type.isInSet(child.marks);
    const childFrom = start + offset;
    const childTo = childFrom + child.nodeSize;
    if (mark && from >= childFrom && from <= childTo) {
      // 相邻的同一链接片段合并
      let a = childFrom;
      let b = childTo;
      for (let j = i - 1, o = offset; j >= 0; j--) {
        const c = parent.child(j);
        o -= c.nodeSize;
        if (!mark.isInSet(c.marks)) break;
        a = start + o;
      }
      for (let j = i + 1, o = offset + child.nodeSize; j < parent.childCount; j++) {
        const c = parent.child(j);
        if (!mark.isInSet(c.marks)) break;
        o += c.nodeSize;
        b = start + o;
      }
      return { from: a, to: b, href: mark.attrs.href as string };
    }
    offset += child.nodeSize;
  }
  return null;
}

export interface LinkTarget {
  /** 已有链接的地址，没有时为空 */
  href: string;
  /** 弹窗定位用的位置 */
  pos: number;
}

export function currentLink(editor: Editor): LinkTarget {
  return editor.action((ctx) => {
    const { state } = ctx.get(editorViewCtx);
    const found = linkRange(state, state.schema.marks.link);
    return { href: found?.href ?? "", pos: state.selection.from };
  });
}

/** 设置链接：地址为空时移除链接；没有选中文字时插入地址本身作为链接文字 */
export function applyLink(editor: Editor, href: string): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const type = state.schema.marks.link;
    const existing = linkRange(state, type);
    const url = href.trim();
    let tr = state.tr;
    if (!url) {
      if (existing) tr = tr.removeMark(existing.from, existing.to, type);
    } else if (existing) {
      tr = tr.removeMark(existing.from, existing.to, type).addMark(existing.from, existing.to, type.create({ href: url }));
    } else if (state.selection.empty) {
      const at = state.selection.from;
      tr = tr.insertText(url, at).addMark(at, at + url.length, type.create({ href: url })).removeStoredMark(type);
    } else {
      tr = tr.addMark(state.selection.from, state.selection.to, type.create({ href: url }));
    }
    view.dispatch(tr.scrollIntoView());
    view.focus();
  });
}

export function linkCoords(editor: Editor, pos: number): { left: number; bottom: number } {
  return editor.action((ctx) => ctx.get(editorViewCtx).coordsAtPos(pos));
}

export function focusEditor(editor: Editor): void {
  editor.action((ctx) => ctx.get(editorViewCtx).focus());
}

/**
 * 能用系统浏览器打开的地址。
 * `www.baidu.com` 这种没写协议的网址补上 https；笔记路径返回 null，交给笔记跳转。
 */
export function externalUrl(href: string): string | null {
  const raw = href.trim();
  if (!raw || /\s/.test(raw)) return null;
  if (/^(https?:|mailto:)/i.test(raw)) return raw;
  if (/^www\./i.test(raw)) return `https://${raw}`;
  const host = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+(?:[/:?#]|$)/i;
  if (host.test(raw) && !/^[a-z0-9.-]+\.md(?:$|[?#])/i.test(raw)) return `https://${raw}`;
  return null;
}

/** 点击落在链接上时返回地址；不是链接返回 null */
export function editorLinkClick(view: EditorView, event: MouseEvent): string | null {
  if (event.button !== 0) return null;
  const el = event.target instanceof Element ? event.target : null;
  const anchor = el?.closest("a");
  if (!anchor || !view.dom.contains(anchor)) return null;
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (at) {
    const mark = view.state.doc.resolve(at.pos).marks().find((m) => m.type.name === "link");
    if (mark) return String(mark.attrs.href ?? "");
  }
  return anchor.getAttribute("href") ?? "";
}
