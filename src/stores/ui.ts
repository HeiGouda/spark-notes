import { defineStore } from "pinia";
import { ref } from "vue";

export type SidebarView = "files" | "search" | "tags" | "favorites" | "outline" | "scm" | "chat";
export type PaletteMode = "commands" | "files";

/** 界面状态：左栏视图、搜索词、命令面板、查找栏、链接输入框、快捷键弹窗 */
export const useUiStore = defineStore("ui", () => {
  const view = ref<SidebarView>("files");
  const query = ref("");
  /** 每次请求聚焦搜索框时加一 */
  const focusSearch = ref(0);

  const palette = ref<PaletteMode | null>(null);
  const findOpen = ref(false);
  const findReplace = ref(false);
  /** 每次请求聚焦查找框时加一 */
  const findFocus = ref(0);
  const findSeed = ref("");
  const linkOpen = ref(false);
  const keysOpen = ref(false);
  const settingsOpen = ref(false);
  const settingsSection = ref("general");
  const historyOpen = ref(false);
  const trashOpen = ref(false);
  const vaultOpen = ref(false);
  const guideOpen = ref(false);
  /** 快捷键弹窗正在录入组合键：此时全局快捷键不生效 */
  const recording = ref(false);
  /** “AI 对话”标签页是否打开，以及右侧显示笔记还是对话（需求文档 5.17） */
  const chatOpen = ref(false);
  const mainView = ref<"note" | "chat">("note");
  /** 离开对话时左栏回到的视图 */
  let lastView: SidebarView = "files";

  function openChat() {
    if (view.value !== "chat") lastView = view.value;
    view.value = "chat";
    chatOpen.value = true;
    mainView.value = "chat";
  }

  /** 回到笔记：左栏离开会话列表 */
  function showNotes() {
    mainView.value = "note";
    if (view.value === "chat") view.value = lastView;
  }

  function closeChat() {
    chatOpen.value = false;
    showNotes();
  }

  function search(q?: string) {
    if (mainView.value === "chat") mainView.value = "note";
    view.value = "search";
    if (q !== undefined) query.value = q;
    focusSearch.value++;
  }

  function openFind(replace: boolean, seed: string) {
    findOpen.value = true;
    if (replace) findReplace.value = true;
    if (seed) findSeed.value = seed;
    findFocus.value++;
  }

  function closeFind() {
    findOpen.value = false;
  }

  return {
    view, query, focusSearch, search,
    palette, findOpen, findReplace, findFocus, findSeed, openFind, closeFind, linkOpen, keysOpen, recording,
    settingsOpen, settingsSection, historyOpen, trashOpen, vaultOpen, guideOpen,
    chatOpen, mainView, openChat, showNotes, closeChat,
  };
});
