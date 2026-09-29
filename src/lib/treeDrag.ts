import { ref } from "vue";

export type DropWhere = "into" | "before" | "after";

/** 文件树拖拽状态（同一时间只有一个拖拽） */
export const dragging = ref<string | null>(null);
export const dropTarget = ref<{ path: string; where: DropWhere } | null>(null);

export const DRAG_MIME = "application/x-ttnote-path";

export function endDrag() {
  dragging.value = null;
  dropTarget.value = null;
}
