import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";

/** 图的编辑区响应的命令，与 appCommands 里 scope 为 diagram 的命令一一对应 */
export type DiagramAction =
  | "addChild" | "addSibling" | "addSiblingBefore" | "addParent" | "delete" | "edit" | "toggleFold" | "undo" | "redo" | "center"
  | "summary" | "aiArrange" | "duplicate" | "zoomFit" | "zoom100";

/** 查找栏在图上查找与替换（需求文档 5.18） */
export interface DiagramFind {
  /** 按查找条件重新计算命中，返回命中数；select 为 true 时选中第 current 处并滚到它 */
  search(pattern: RegExp | null, current: number, select: boolean): number;
  replaceOne(current: number, pattern: RegExp, replacement: string, regex: boolean): void;
  /** 全部替换算一步操作，返回替换了几处 */
  replaceAll(pattern: RegExp, replacement: string, regex: boolean): number;
  clear(): void;
  /** 选中节点的文字，打开查找栏时作为查找词 */
  selectedText(): string;
  focus(): void;
  readonly(): boolean;
}

export interface DiagramHandle {
  path: string;
  run: (action: DiagramAction) => void;
  find: DiagramFind;
}

/** 当前打开的图：供命令、状态栏、查找栏使用 */
export const useDiagramStore = defineStore("diagram", () => {
  const handle = shallowRef<DiagramHandle | null>(null);
  const nodes = ref(0);
  const edges = ref(0);
  const selected = ref(0);
  const zoom = ref(1);
  /** 图的内容每次变化加一，查找栏据此重新计算命中 */
  const version = ref(0);

  function attach(h: DiagramHandle) {
    handle.value = h;
  }

  function detach(h: DiagramHandle) {
    if (handle.value === h) handle.value = null;
  }

  function run(action: DiagramAction) {
    handle.value?.run(action);
  }

  return { handle, nodes, edges, selected, zoom, version, attach, detach, run };
});
