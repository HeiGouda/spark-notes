import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node } from "@milkdown/kit/prose/model";
import { findTable, selectedRect } from "@milkdown/kit/prose/tables";

interface TableHit {
  pos: number;
  table: Node;
  row: number;
  col: number;
}

function hit(state: EditorState): TableHit | null {
  const found = findTable(state.selection.$from);
  if (!found) return null;
  try {
    const rect = selectedRect(state);
    return { pos: found.pos, table: found.node, row: rect.top, col: rect.left };
  } catch {
    return null;
  }
}

function cellsOf(row: Node): Node[] {
  const cells: Node[] = [];
  row.forEach((cell) => cells.push(cell));
  return cells;
}

function rowsOf(table: Node): Node[] {
  const rows: Node[] = [];
  table.forEach((row) => rows.push(row));
  return rows;
}

/** 列号对应到这一行的第几个单元格（考虑跨列） */
function childIndex(row: Node, col: number): number {
  let seen = 0;
  for (let i = 0; i < row.childCount; i++) {
    if (seen >= col) return i;
    seen += (row.child(i).attrs.colspan as number) || 1;
  }
  return row.childCount;
}

function emptyCell(view: EditorView, header: boolean): Node {
  const type = view.state.schema.nodes[header ? "table_header" : "table_cell"];
  return type.createAndFill()!;
}

function asRow(view: EditorView, header: boolean, cells: Node[]): Node {
  const cellType = view.state.schema.nodes[header ? "table_header" : "table_cell"];
  const rowType = view.state.schema.nodes[header ? "table_header_row" : "table_row"];
  return rowType.create(null, cells.map((cell) => cellType.create(cell.attrs, cell.content)));
}

/** 第一行始终是表头。少于两行时补一个空行，避免表格结构被拆掉 */
function writeRows(view: EditorView, at: TableHit, rows: Node[], cursorRow: number) {
  const schema = view.state.schema;
  let next = rows;
  if (next.length < 2) {
    const width = Math.max(next[0]?.childCount ?? 1, 1);
    const blank = Array.from({ length: width }, () => emptyCell(view, false));
    next = next.length ? [next[0], schema.nodes.table_row.create(null, blank)] : [schema.nodes.table_header_row.create(null, blank.map((c) => schema.nodes.table_header.create(c.attrs, c.content))), schema.nodes.table_row.create(null, blank)];
  }
  const built = next.map((row, i) => asRow(view, i === 0, cellsOf(row)));
  const table = at.table.type.create(at.table.attrs, built);
  let pos = at.pos + 1;
  const rowIndex = Math.max(0, Math.min(cursorRow, built.length - 1));
  for (let i = 0; i < rowIndex; i++) pos += built[i].nodeSize;
  let tr = view.state.tr.replaceWith(at.pos, at.pos + at.table.nodeSize, table);
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size))));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function insertRow(view: EditorView, where: "before" | "after") {
  const at = hit(view.state);
  if (!at) return;
  const rows = rowsOf(at.table);
  const index = where === "before" ? at.row : at.row + 1;
  const width = rows[Math.min(at.row, rows.length - 1)].childCount;
  const blank = view.state.schema.nodes.table_row.create(null, Array.from({ length: width }, () => emptyCell(view, false)));
  rows.splice(index, 0, blank);
  writeRows(view, at, rows, index);
}

function deleteRowAt(view: EditorView) {
  const at = hit(view.state);
  if (!at) return;
  const rows = rowsOf(at.table);
  rows.splice(at.row, 1);
  writeRows(view, at, rows, Math.max(0, at.row - 1));
}

function insertCol(view: EditorView, where: "before" | "after") {
  const at = hit(view.state);
  if (!at) return;
  const index = where === "before" ? at.col : at.col + 1;
  const rows = rowsOf(at.table).map((row) => {
    const cells = cellsOf(row);
    cells.splice(childIndex(row, index), 0, emptyCell(view, false));
    return row.type.create(row.attrs, cells);
  });
  writeRows(view, at, rows, at.row);
}

function deleteColAt(view: EditorView) {
  const at = hit(view.state);
  if (!at) return;
  const width = at.table.firstChild?.childCount ?? 0;
  if (width <= 1) {
    view.dispatch(view.state.tr.delete(at.pos, at.pos + at.table.nodeSize).scrollIntoView());
    view.focus();
    return;
  }
  const rows = rowsOf(at.table).map((row) => {
    const cells = cellsOf(row);
    cells.splice(childIndex(row, at.col), 1);
    return row.type.create(row.attrs, cells);
  });
  writeRows(view, at, rows, at.row);
}

function deleteWhole(view: EditorView) {
  const at = hit(view.state);
  if (!at) return;
  view.dispatch(view.state.tr.delete(at.pos, at.pos + at.table.nodeSize).scrollIntoView());
  view.focus();
}

const GROUPS: { id: string; label: string; danger?: boolean; run: (view: EditorView) => void }[][] = [
  [
    { id: "row-before", label: "上方插入行", run: (v) => insertRow(v, "before") },
    { id: "row-after", label: "下方插入行", run: (v) => insertRow(v, "after") },
    { id: "row-delete", label: "删除行", danger: true, run: deleteRowAt },
  ],
  [
    { id: "col-before", label: "左侧插入列", run: (v) => insertCol(v, "before") },
    { id: "col-after", label: "右侧插入列", run: (v) => insertCol(v, "after") },
    { id: "col-delete", label: "删除列", danger: true, run: deleteColAt },
  ],
  [{ id: "table-delete", label: "删除表格", danger: true, run: deleteWhole }],
];

class TableBar {
  el: HTMLElement;
  private view: EditorView;
  private onScroll: () => void;

  constructor(view: EditorView) {
    this.view = view;
    this.el = document.createElement("div");
    this.el.className = "pop table-bar";
    this.el.style.display = "none";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "表格");
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    GROUPS.forEach((group, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "sep";
        this.el.append(sep);
      }
      for (const action of group) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.action = action.id;
        btn.textContent = action.label;
        if (action.danger) btn.className = "danger";
        btn.addEventListener("click", () => action.run(this.view));
        this.el.append(btn);
      }
    });
    document.body.append(this.el);
    this.onScroll = () => this.place();
    this.view.dom.closest(".editor")?.addEventListener("scroll", this.onScroll);
    this.place();
  }

  update(view: EditorView) {
    this.view = view;
    this.place();
  }

  place() {
    const found = findTable(this.view.state.selection.$from);
    const dom = found ? this.view.nodeDOM(found.pos) : null;
    const table = dom instanceof HTMLElement ? (dom.tagName === "TABLE" ? dom : dom.querySelector("table")) : null;
    if (!table) {
      this.el.style.display = "none";
      return;
    }
    this.el.style.display = "flex";
    const r = table.getBoundingClientRect();
    const top = r.top - this.el.offsetHeight - 6;
    this.el.style.top = `${top < 8 ? r.bottom + 6 : top}px`;
    this.el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - this.el.offsetWidth - 8))}px`;
  }

  destroy() {
    this.view.dom.closest(".editor")?.removeEventListener("scroll", this.onScroll);
    this.el.remove();
  }
}

export function tableBarPlugin() {
  return $prose(() => new Plugin({
    key: new PluginKey("ttnote-table-bar"),
    view: (view) => {
      const bar = new TableBar(view);
      return { update: (v) => bar.update(v), destroy: () => bar.destroy() };
    },
  }));
}
