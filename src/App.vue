<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import IconSprite from "./components/IconSprite.vue";
import TitleBar from "./components/TitleBar.vue";
import Sidebar from "./components/Sidebar.vue";
import FormatToolbar from "./components/FormatToolbar.vue";
import NoteEditor from "./components/NoteEditor.vue";
import DiagramView from "./components/DiagramView.vue";
import StatusBar from "./components/StatusBar.vue";
import SheetBar from "./components/SheetBar.vue";
import ContextMenu from "./components/ContextMenu.vue";
import { dispatchShortcut, runCommand } from "./lib/commands";
import { useSettingsStore } from "./stores/settings";
import { useTabsStore } from "./stores/tabs";
import { useBookStore } from "./stores/book";
import { useNoticeStore } from "./stores/notice";
import { useUiStore } from "./stores/ui";
import CommandPalette from "./components/CommandPalette.vue";
import FindBar from "./components/FindBar.vue";
import LinkPopover from "./components/LinkPopover.vue";
import KeysDialog from "./components/KeysDialog.vue";
import GitDialog from "./components/GitDialog.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import WebdavPlanDialog from "./components/WebdavPlanDialog.vue";
import ToastHost from "./components/ToastHost.vue";
import HistoryDialog from "./components/HistoryDialog.vue";
import TrashDialog from "./components/TrashDialog.vue";
import VaultDialog from "./components/VaultDialog.vue";
import GuideDialog from "./components/GuideDialog.vue";
import AiNoConfigDialog from "./components/AiNoConfigDialog.vue";
import AiSummaryDialog from "./components/AiSummaryDialog.vue";
import AiStructureDialog from "./components/AiStructureDialog.vue";
import FlowGenDialog from "./components/FlowGenDialog.vue";
import MindGenDialog from "./components/MindGenDialog.vue";
import ChatView from "./components/ChatView.vue";
import { useGitStore } from "./stores/git";

const settings = useSettingsStore();
const tabs = useTabsStore();
const book = useBookStore();
const ui = useUiStore();
const chatShown = computed(() => ui.chatOpen && ui.mainView === "chat");
const diagramShown = computed(() => !!tabs.active && tabs.active.kind !== "note");

/** 最近看过的笔记继续留着编辑器，切回来不用重新解析长文，滚动位置也还在。恢复会话时会连续激活每一篇，那段时间先不建 */
const WARM_NOTES = 8;
const warmNotes = ref<string[]>([]);
watch(
  () => [tabs.activePath, tabs.restoring] as const,
  ([path, restoring]) => {
    if (path && ui.mainView === "chat") ui.showNotes();
    if (restoring || !path) return;
    const tab = tabs.tabs.find((t) => t.path === path);
    if (!tab || tab.kind !== "note") return;
    const next = [path, ...warmNotes.value.filter((p) => p !== path)];
    warmNotes.value = next.slice(0, WARM_NOTES);
  },
  { immediate: true },
);
watch(
  () => tabs.tabs.map((t) => t.path).join("\0"),
  () => {
    const has = new Set(tabs.tabs.map((t) => t.path));
    const kept = warmNotes.value.filter((p) => has.has(p));
    if (kept.length !== warmNotes.value.length) warmNotes.value = kept;
  },
);
const shownNotes = computed(() => {
  const warm = new Set(warmNotes.value);
  return tabs.tabs.filter((t) => t.kind === "note" && warm.has(t.path));
});

/** 捕获阶段处理应用级快捷键，先于编辑器自身的按键映射 */
function onKeyDown(e: KeyboardEvent) {
  // 快捷键弹窗正在录入组合键时，按键交给弹窗
  if (ui.recording) return;
  const cmd = dispatchShortcut(e);
  if (!cmd) return;
  e.preventDefault();
  e.stopPropagation();
  runCommand(cmd.id).catch((err) => useNoticeStore().report(`执行“${cmd.title}”失败`, err));
}

let unlistenClose: (() => void) | null = null;
let unlistenQuit: (() => void) | null = null;

/** 文件拖到编辑器以外的区域时，阻止 WebView 直接打开该文件 */
function blockFileDrop(e: DragEvent) {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
}

onMounted(async () => {
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("dragover", blockFileDrop);
  window.addEventListener("drop", blockFileDrop);
  unlistenClose = await getCurrentWindow().onCloseRequested(async (event) => {
    await settings.flushVaultUi();
    const saved = await tabs.flushAll();
    if (!saved) {
      const quit = await ask("有笔记保存失败，退出将丢失这些修改。仍要退出吗？", {
        title: "Spark",
        kind: "warning",
        okLabel: "放弃修改并退出",
        cancelLabel: "取消",
      });
      if (!quit) {
        event.preventDefault();
        return;
      }
    }
    const gitErr = await useGitStore().commitOnExit();
    if (!gitErr) return;
    const quit = await ask(`${gitErr}。仍要退出吗？`, {
      title: "Spark",
      kind: "warning",
      okLabel: "仍要退出",
      cancelLabel: "取消",
    });
    if (!quit) event.preventDefault();
  });
  // macOS 菜单栏的“退出”（Cmd+Q）
  unlistenQuit = await listen("app-quit-requested", () => {
    getCurrentWindow().close().catch((e) => useNoticeStore().report("退出失败", e));
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("dragover", blockFileDrop);
  window.removeEventListener("drop", blockFileDrop);
  unlistenClose?.();
  unlistenQuit?.();
});
</script>

<template>
  <IconSprite />
  <div class="app">
    <TitleBar />
    <div class="body">
      <Sidebar v-if="settings.sidebarVisible" />
      <main class="main">
        <FormatToolbar v-if="settings.toolbarVisible && !chatShown && !diagramShown" />
        <DiagramView v-if="tabs.active && diagramShown" v-show="!chatShown" :key="tabs.active.path" :tab="tabs.active" />
        <!-- 切到 AI 对话、或切到别的笔记时，编辑器只隐藏不销毁，留下光标和阅读位置 -->
        <NoteEditor v-for="tab in shownNotes" v-show="tab.path === tabs.activePath && !chatShown" :key="tab.path" :tab="tab" />
        <div v-if="!tabs.active && !chatShown" class="main-empty">在左侧选择一篇笔记</div>
        <FindBar v-if="tabs.active && !chatShown" />
        <SheetBar v-if="book.activeBook && !chatShown" />
        <ChatView v-if="ui.chatOpen" v-show="chatShown" />
      </main>
    </div>
    <StatusBar v-if="settings.statusbarVisible" />
  </div>
  <ContextMenu />
  <CommandPalette />
  <LinkPopover />
  <KeysDialog v-if="ui.keysOpen" />
  <GitDialog />
  <SettingsDialog />
  <WebdavPlanDialog />
  <ToastHost />
  <HistoryDialog />
  <TrashDialog />
  <VaultDialog />
  <GuideDialog />
  <AiNoConfigDialog />
  <AiSummaryDialog />
  <AiStructureDialog />
  <FlowGenDialog />
  <MindGenDialog />
</template>
