<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import IconSprite from "./components/IconSprite.vue";
import TitleBar from "./components/TitleBar.vue";
import Sidebar from "./components/Sidebar.vue";
import FormatToolbar from "./components/FormatToolbar.vue";
import NoteEditor from "./components/NoteEditor.vue";
import StatusBar from "./components/StatusBar.vue";
import ContextMenu from "./components/ContextMenu.vue";
import { dispatchShortcut, runCommand } from "./lib/commands";
import { useSettingsStore } from "./stores/settings";
import { useTabsStore } from "./stores/tabs";
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
import ChatView from "./components/ChatView.vue";
import { useGitStore } from "./stores/git";

const settings = useSettingsStore();
const tabs = useTabsStore();
const ui = useUiStore();
const chatShown = computed(() => ui.chatOpen && ui.mainView === "chat");

/** 从文件树、快速打开等处打开笔记时回到笔记 */
watch(() => tabs.activePath, (path) => {
  if (path && ui.mainView === "chat") ui.showNotes();
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
        <FormatToolbar v-if="settings.toolbarVisible && !chatShown" />
        <!-- 切到 AI 对话时编辑器只隐藏不销毁，保留光标位置供“插入到笔记”使用 -->
        <NoteEditor v-if="tabs.active" v-show="!chatShown" :key="tabs.active.path" :tab="tabs.active" />
        <div v-else-if="!chatShown" class="main-empty">在左侧选择一篇笔记</div>
        <FindBar v-if="tabs.active && !chatShown" />
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
</template>
