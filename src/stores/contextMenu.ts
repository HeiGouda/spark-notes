import { defineStore } from "pinia";
import { shallowRef } from "vue";
import type { MenuEntry } from "../components/MenuList.vue";

/** 全局唯一的右键菜单，同一时间只显示一个 */
export const useContextMenuStore = defineStore("contextMenu", () => {
  const menu = shallowRef<{ items: MenuEntry[]; x: number; y: number } | null>(null);

  function show(e: MouseEvent, items: MenuEntry[]) {
    e.preventDefault();
    e.stopPropagation();
    menu.value = { items, x: e.clientX, y: e.clientY };
  }

  function hide() {
    menu.value = null;
  }

  return { menu, show, hide };
});
