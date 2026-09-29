import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { $view } from "@milkdown/kit/utils";
import { imageSchema } from "@milkdown/kit/preset/commonmark";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { Node } from "@milkdown/kit/prose/model";

/** 保存好的附件：link 为相对笔记所在目录的路径 */
export interface SavedAttachment {
  link: string;
  name: string;
  isImage: boolean;
}

export interface AttachmentHost {
  /** 把笔记里的 src 转成可显示的 URL */
  resolve: (src: string) => string;
  save: (file: File) => Promise<SavedAttachment>;
  onError: (context: string, err: unknown) => void;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
/** 写入图片 title 的宽度，例如 `w=320` 或 `说明|w=320`，标准 Markdown 能原样往返 */
const WIDTH_MARK = /^(?:([\s\S]*)\|)?w=(\d+)$/;
export const IMAGE_MIN_W = 48;
export const IMAGE_MAX_W = 1600;

export function clampImageWidth(width: number): number {
  return Math.round(Math.min(IMAGE_MAX_W, Math.max(IMAGE_MIN_W, width)));
}

/** 从图片 title 里拆出真正的说明和宽度；没有宽度标记时原样返回 */
export function splitImageTitle(raw: unknown): { title: string; width: number | null } {
  const title = typeof raw === "string" ? raw : "";
  const m = WIDTH_MARK.exec(title);
  if (!m) return { title, width: null };
  const width = Number(m[2]);
  if (!Number.isInteger(width) || width < IMAGE_MIN_W || width > IMAGE_MAX_W) return { title, width: null };
  return { title: m[1] ?? "", width };
}

export function joinImageTitle(raw: unknown, width: number | null): string {
  const base = splitImageTitle(raw).title;
  if (width == null) return base;
  const w = clampImageWidth(width);
  return base ? `${base}|w=${w}` : `w=${w}`;
}

/** 剪贴板里的文件。Windows 截图有时只出现在 items 里，files 是空的 */
export function clipboardFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const direct = [...data.files];
  if (direct.length) return direct;
  const out: File[] = [];
  for (const item of data.items ?? []) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}

export function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name);
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** 截图粘贴时文件名通常是 image.png，改成带时间的名字，避免附件目录里都是 image 1、image 2 */
export function attachmentName(file: File, now = new Date()): string {
  const name = file.name?.trim();
  if (name && !/^image\.\w+$/i.test(name)) return name;
  const ext = name?.split(".").pop() || file.type.split("/")[1] || "png";
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `image-${stamp}.${ext}`;
}

/** 在当前选区插入附件：图片插入图片节点，其他文件插入链接 */
export function insertSaved(view: EditorView, items: SavedAttachment[]): void {
  const { schema } = view.state;
  let tr = view.state.tr;
  for (const [i, item] of items.entries()) {
    if (i > 0) tr = tr.insertText(" ");
    if (item.isImage) {
      tr = tr.replaceSelectionWith(schema.nodes.image.create({ src: item.link, alt: item.name.replace(/\.[^.]+$/, "") }), false);
    } else {
      const from = tr.selection.from;
      tr = tr.insertText(item.name, from, tr.selection.to);
      tr = tr.addMark(from, from + item.name.length, schema.marks.link.create({ href: item.link }));
      tr = tr.removeStoredMark(schema.marks.link);
    }
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export function insertAttachments(editor: Editor, items: SavedAttachment[]): void {
  editor.action((ctx) => insertSaved(ctx.get(editorViewCtx), items));
}

async function saveAll(host: AttachmentHost, files: File[]): Promise<SavedAttachment[]> {
  const out: SavedAttachment[] = [];
  for (const f of files) {
    try {
      out.push(await host.save(f));
    } catch (e) {
      host.onError(`保存附件失败 ${f.name}`, e);
    }
  }
  return out;
}

/** 保存附件期间可能切换了笔记，编辑器已经销毁时不能再往里插入 */
function stillOpen(host: AttachmentHost, view: EditorView, items: SavedAttachment[]): boolean {
  if (!view.isDestroyed) return true;
  host.onError("笔记已切换，附件已保存但没有插入链接", items.map((i) => i.link).join("、"));
  return false;
}

export function handlePaste(host: AttachmentHost) {
  return (view: EditorView, event: ClipboardEvent): boolean => {
    const files = clipboardFiles(event.clipboardData);
    if (!files.length) return false;
    event.preventDefault();
    void saveAll(host, files).then((items) => {
      if (items.length && stillOpen(host, view, items)) insertSaved(view, items);
    });
    return true;
  };
}

export function handleDrop(host: AttachmentHost) {
  return (view: EditorView, event: DragEvent, _slice: unknown, moved: boolean): boolean => {
    const files = clipboardFiles(event.dataTransfer);
    if (moved || !files.length) return false;
    event.preventDefault();
    const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
    void saveAll(host, files).then((items) => {
      if (!items.length || !stillOpen(host, view, items)) return;
      if (pos != null) {
        const $pos = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size));
        view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
      }
      insertSaved(view, items);
    });
    return true;
  };
}

function zoomButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "img-zoom";
  b.textContent = label;
  b.title = label;
  return b;
}

/** 图片节点视图：相对路径转成可显示的地址；选中后可放大、缩小或拖动右下角，宽度写回 Markdown */
export function imageView(host: AttachmentHost) {
  return $view(imageSchema.node, () => (initial, view, getPos): NodeView => {
    let node: Node = initial;
    const wrap = document.createElement("span");
    wrap.className = "img-frame";
    wrap.contentEditable = "false";
    const img = document.createElement("img");
    img.draggable = false;
    img.addEventListener("load", () => img.classList.remove("is-broken"));
    img.addEventListener("error", () => {
      img.classList.add("is-broken");
      console.warn("图片加载失败", node.attrs.src, img.src);
    });
    const tools = document.createElement("span");
    tools.className = "img-tools";
    tools.contentEditable = "false";
    const zoomOut = zoomButton("缩小");
    const zoomIn = zoomButton("放大");
    tools.append(zoomOut, zoomIn);
    const handle = document.createElement("span");
    handle.className = "img-resize";
    handle.title = "拖动调整大小";
    wrap.append(img, tools, handle);

    const render = () => {
      img.src = host.resolve(node.attrs.src as string);
      img.alt = (node.attrs.alt as string) ?? "";
      const meta = splitImageTitle(node.attrs.title);
      const where = meta.title || String(node.attrs.src ?? "");
      if (where) img.title = where;
      else img.removeAttribute("title");
      if (meta.width) img.style.width = `${meta.width}px`;
      else img.style.removeProperty("width");
    };
    render();

    const shownWidth = () => splitImageTitle(node.attrs.title).width ?? (Math.round(img.getBoundingClientRect().width) || 240);

    const commit = (width: number) => {
      const pos = getPos();
      if (pos == null) return;
      const title = joinImageTitle(node.attrs.title, width);
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, title }));
      view.focus();
    };

    zoomOut.addEventListener("mousedown", (e) => e.preventDefault());
    zoomIn.addEventListener("mousedown", (e) => e.preventDefault());
    zoomOut.addEventListener("click", () => commit(shownWidth() * 0.8));
    zoomIn.addEventListener("click", () => commit(shownWidth() * 1.25));

    let move: ((ev: MouseEvent) => void) | null = null;
    let up: ((ev: MouseEvent) => void) | null = null;
    const stopDrag = () => {
      if (move) window.removeEventListener("mousemove", move);
      if (up) window.removeEventListener("mouseup", up);
      move = null;
      up = null;
    };
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = shownWidth();
      move = (ev) => {
        img.style.width = `${clampImageWidth(startW + ev.clientX - startX)}px`;
      };
      up = (ev) => {
        const next = clampImageWidth(startW + ev.clientX - startX);
        stopDrag();
        commit(next);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });

    return {
      dom: wrap,
      update(next) {
        if (next.type !== node.type) return false;
        node = next;
        render();
        return true;
      },
      selectNode() {
        wrap.classList.add("is-selected");
      },
      deselectNode() {
        wrap.classList.remove("is-selected");
      },
      stopEvent(e) {
        const t = e.target as globalThis.Node | null;
        return !!t && (tools.contains(t) || handle.contains(t));
      },
      ignoreMutation() {
        return true;
      },
      destroy() {
        stopDrag();
      },
    };
  });
}
