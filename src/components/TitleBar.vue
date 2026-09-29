<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Icon from "./Icon.vue";
import MenuList, { type MenuEntry } from "./MenuList.vue";
import { runCommand, shortcutOf, tipFor } from "../lib/commands";
import { displayShortcut } from "../lib/shortcut";
import { isMac } from "../lib/platform";
import { useSettingsStore } from "../stores/settings";
import { useTabsStore } from "../stores/tabs";
import { useNoticeStore } from "../stores/notice";
import { useVaultStore } from "../stores/vault";
import { useGitStore } from "../stores/git";
import { useWebdavStore } from "../stores/webdav";
import { useUiStore } from "../stores/ui";
import { useContextMenuStore } from "../stores/contextMenu";
import { THEMES, isDarkTheme, themeCommandId, themeName } from "../lib/themes";

const settings = useSettingsStore();
const tabs = useTabsStore();
const vault = useVaultStore();
const git = useGitStore();
const webdav = useWebdavStore();
const ui = useUiStore();
const ctxMenu = useContextMenuStore();
const win = getCurrentWindow();
const menuOpen = ref(false);
const menuHost = ref<HTMLElement | null>(null);

const MENU: MenuEntry[] = [
  {
    kind: "sub", label: "文件", items: [
      { kind: "item", label: "新建笔记", command: "file.newNote" },
      { kind: "item", label: "新建文件夹", command: "file.newFolder" },
      { kind: "sep" },
      { kind: "item", label: "打开笔记库…", command: "file.openVault" },
      { kind: "item", label: "切换笔记库", command: "file.switchVault" },
      { kind: "sep" },
      { kind: "item", label: "导入笔记库", command: "file.importVault" },
      { kind: "item", label: "导出笔记库", command: "file.exportVault" },
      { kind: "sep" },
      { kind: "item", label: "历史版本", command: "file.history" },
      { kind: "item", label: "回收站", command: "file.trash" },
      { kind: "sep" },
      { kind: "item", label: "立即保存", command: "file.save" },
      { kind: "item", label: "关闭标签页", command: "tab.close" },
      { kind: "item", label: "退出", command: "file.quit" },
    ],
  },
  {
    kind: "sub", label: "编辑", items: [
      { kind: "item", label: "撤销", command: "edit.undo" },
      { kind: "item", label: "重做", command: "edit.redo" },
      { kind: "sep" },
      { kind: "item", label: "剪切", command: "edit.cut" },
      { kind: "item", label: "复制", command: "edit.copy" },
      { kind: "item", label: "粘贴", command: "edit.paste" },
      { kind: "sep" },
      { kind: "item", label: "查找", command: "edit.find" },
      { kind: "item", label: "替换", command: "edit.replace" },
    ],
  },
  {
    kind: "sub", label: "视图", items: [
      { kind: "item", label: "显示侧栏", command: "view.toggleSidebar", checked: () => settings.sidebarVisible },
      { kind: "item", label: "显示格式工具栏", command: "view.toggleToolbar", checked: () => settings.toolbarVisible },
      { kind: "item", label: "显示状态栏", command: "view.toggleStatusbar", checked: () => settings.statusbarVisible },
      { kind: "sep" },
      {
        kind: "sub", label: "主题", items: THEMES.flatMap((t, i): MenuEntry[] => [
          ...(t.dark && !THEMES[i - 1].dark ? [{ kind: "sep" } as const] : []),
          { kind: "item", label: t.name, command: themeCommandId(t.id), checked: () => settings.theme === t.id },
        ]),
      },
      { kind: "sep" },
      { kind: "item", label: "放大" },
      { kind: "item", label: "缩小" },
      { kind: "item", label: "重置缩放" },
    ],
  },
  {
    kind: "sub", label: "帮助", items: [
      { kind: "item", label: "操作指南", command: "help.guide" },
      { kind: "sep" },
      { kind: "item", label: "命令面板", command: "palette.commands" },
      { kind: "item", label: "快捷键设置", command: "help.shortcuts" },
      { kind: "item", label: "关于", command: "help.about" },
      { kind: "item", label: "打开日志目录" },
    ],
  },
];

const syncHost = ref<HTMLElement | null>(null);
const syncMenu = ref<{ x: number; y: number } | null>(null);

function onDocDown(e: MouseEvent) {
  if (menuOpen.value && menuHost.value && !menuHost.value.contains(e.target as Node)) menuOpen.value = false;
  if (syncMenu.value && syncHost.value && !syncHost.value.contains(e.target as Node)) syncMenu.value = null;
}

function openSyncMenu(e: MouseEvent) {
  if (syncMenu.value) {
    syncMenu.value = null;
    return;
  }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  syncMenu.value = { x: Math.max(4, rect.right - 260), y: rect.bottom + 4 };
}

function syncAction(fn: () => unknown) {
  syncMenu.value = null;
  void fn();
}

function openSyncSettings() {
  ui.settingsSection = "sync";
  ui.settingsOpen = true;
}
onMounted(() => document.addEventListener("mousedown", onDocDown, true));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocDown, true));

function gitSyncActive() {
  return webdav.mode === "git" || (!webdav.configured && git.isRepo);
}

function onSync(e: MouseEvent) {
  if (!vault.root) return;
  if (webdav.mode === "webdav") {
    openSyncMenu(e);
    return;
  }
  if (gitSyncActive()) {
    void git.syncFromTitle();
    return;
  }
  openSyncSettings();
}

async function run(id: string) {
  try {
    await runCommand(id);
  } catch (e) {
    useNoticeStore().report("执行命令失败", e);
  }
}

async function winAction(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    useNoticeStore().report("窗口操作失败", e);
  }
}

function onTabMouseUp(e: MouseEvent, path: string) {
  if (e.button === 1) void tabs.close(path);
}

function onTabMenu(e: MouseEvent, path: string) {
  const idx = tabs.tabs.findIndex((t) => t.path === path);
  ctxMenu.show(e, [
    { kind: "item", label: "关闭", hint: displayShortcut(shortcutOf("tab.close")), action: () => tabs.close(path) },
    { kind: "item", label: "关闭其他", action: () => tabs.closeOthers(path), disabled: tabs.tabs.length < 2 },
    { kind: "item", label: "关闭右侧", action: () => tabs.closeRight(path), disabled: idx === tabs.tabs.length - 1 },
    { kind: "sep" },
    { kind: "item", label: "固定标签页", action: () => tabs.pin(path), disabled: !tabs.tabs[idx]?.preview },
    { kind: "item", label: "在文件树中定位", action: () => { vault.reveal(path); vault.selected = path; } },
  ]);
}

const dragFrom = ref<number | null>(null);
const dropAt = ref<number | null>(null);

function onTabDragStart(e: DragEvent, idx: number) {
  dragFrom.value = idx;
  e.dataTransfer?.setData("application/x-ttnote-tab", String(idx));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

function onTabDragOver(e: DragEvent, idx: number) {
  if (dragFrom.value === null) return;
  e.preventDefault();
  dropAt.value = idx;
}

function onTabDrop(idx: number) {
  if (dragFrom.value !== null) tabs.reorder(dragFrom.value, idx);
  dragFrom.value = dropAt.value = null;
}
</script>

<template>
  <header class="titlebar" :class="{ 'with-sidebar': settings.sidebarVisible, 'is-mac': isMac }" data-tauri-drag-region>
    <div ref="menuHost" class="tb-left" data-tauri-drag-region>
      <img class="tb-logo" src="/logo.png" alt="Spark" width="20" height="20" draggable="false" />
      <button class="btn" :class="{ 'is-active': menuOpen }" title="菜单" @click="menuOpen = !menuOpen"><Icon name="menu" /></button>
      <MenuList v-if="menuOpen" :items="MENU" @done="menuOpen = false" />
      <button class="btn" :title="tipFor('显示/隐藏侧栏', 'view.toggleSidebar')" @click="run('view.toggleSidebar')"><Icon name="sidebar" /></button>
      <button class="btn" :title="tipFor('后退', 'nav.back')" :disabled="!tabs.canBack" @click="run('nav.back')"><Icon name="left" /></button>
      <button class="btn" :title="tipFor('前进', 'nav.forward')" :disabled="!tabs.canForward" @click="run('nav.forward')"><Icon name="right" /></button>
    </div>
    <div class="tabs" role="tablist">
      <button
        v-if="ui.chatOpen"
        class="tab"
        :class="{ 'is-active': ui.mainView === 'chat' }"
        role="tab"
        :aria-selected="ui.mainView === 'chat'"
        title="AI 对话"
        @click="run('ai.chat')"
        @mouseup="$event.button === 1 && ui.closeChat()"
      >
        <span class="name">AI 对话</span>
        <span class="x" :title="tipFor('关闭', 'tab.close')" @click.stop="ui.closeChat()"><Icon name="close" sm /></span>
      </button>
      <button
        v-for="(t, i) in tabs.tabs"
        :key="t.path"
        class="tab"
        :class="{ 'is-active': ui.mainView === 'note' && t.path === tabs.activePath, 'is-preview': t.preview, 'is-drop': dropAt === i && dragFrom !== i }"
        role="tab"
        :aria-selected="ui.mainView === 'note' && t.path === tabs.activePath"
        :title="t.path"
        draggable="true"
        @click="ui.showNotes(); tabs.activate(t.path)"
        @dblclick="tabs.pin(t.path)"
        @mouseup="onTabMouseUp($event, t.path)"
        @contextmenu="onTabMenu($event, t.path)"
        @dragstart="onTabDragStart($event, i)"
        @dragover="onTabDragOver($event, i)"
        @drop.prevent="onTabDrop(i)"
        @dragend="dragFrom = dropAt = null"
      >
        <span class="name">{{ t.name }}</span>
        <span class="x" :title="tipFor('关闭', 'tab.close')" @click.stop="tabs.close(t.path)"><Icon name="close" sm /></span>
      </button>
      <button class="btn tab-add" :title="tipFor('新建笔记', 'file.newNote')" :disabled="!vault.root" @click="run('file.newNote')"><Icon name="plus" sm /></button>
    </div>
    <div class="tb-drag" data-tauri-drag-region />
    <div class="tb-right" data-tauri-drag-region>
      <div ref="syncHost" class="sync-host">
        <button class="btn sync" :class="{ 'is-active': syncMenu }" :title="syncMenu ? undefined : (webdav.mode === 'webdav' ? webdav.title : (gitSyncActive() ? git.syncTitle : '尚未配置同步\n点击打开同步设置'))" :disabled="!vault.root" @click="onSync($event)">
          <Icon name="sync" />
          <span v-if="webdav.mode === 'webdav' && webdav.badge !== 'unknown'" class="dot" :class="webdav.badge === 'failed' ? 'is-bad' : `is-${webdav.badge}`" />
          <span v-else-if="gitSyncActive() && git.dirty" class="dot git-dirty" />
        </button>
        <div v-if="syncMenu" class="menu sync-menu" role="menu" :style="{ left: `${syncMenu.x}px`, top: `${syncMenu.y}px` }">
          <div class="sync-status" :class="{ 'is-bad': webdav.failed || webdav.preview?.guard }">
            <template v-if="webdav.busy === 'upload'">正在上传…</template>
            <template v-else-if="webdav.busy === 'download'">正在从云端同步…</template>
            <template v-else-if="webdav.busy === 'check'">正在检查云端…</template>
            <template v-else-if="webdav.preview?.guard">{{ webdav.preview.guard }}</template>
            <template v-else-if="webdav.failed">上次操作失败：{{ webdav.failed }}</template>
            <template v-else>{{ webdav.lastSyncText }}</template>
          </div>
          <div class="menu-sep" />
          <button class="menu-item" role="menuitem" :disabled="!!webdav.busy" @click="syncAction(() => webdav.start('upload'))">
            <span class="mark"><Icon name="push" sm /></span>
            <span class="label">上传本地改动</span>
            <span class="hint">{{ webdav.uploadCount ? webdav.uploadCount : webdav.localDirty ? "有改动" : "" }}</span>
          </button>
          <button class="menu-item" role="menuitem" :disabled="!!webdav.busy" @click="syncAction(() => webdav.start('download'))">
            <span class="mark"><Icon name="pull" sm /></span>
            <span class="label">从云端同步</span>
            <span class="hint">{{ webdav.downloadCount || "" }}</span>
          </button>
          <button class="menu-item" role="menuitem" :disabled="!!webdav.busy" @click="syncAction(() => webdav.check(true))">
            <span class="mark" />
            <span class="label">检查云端更新</span>
            <span class="hint" />
          </button>
          <div class="menu-sep" />
          <button class="menu-item" role="menuitem" @click="syncAction(openSyncSettings)">
            <span class="mark"><Icon name="settings" sm /></span>
            <span class="label">同步设置</span>
            <span class="hint" />
          </button>
        </div>
      </div>
      <button class="btn" :title="tipFor('全文搜索', 'search.focus')" :disabled="!vault.root" @click="run('search.focus')"><Icon name="search" /></button>
      <button class="btn" :title="tipFor(`切换到${themeName(settings.toggleThemeTarget)}`, 'view.toggleNight')" @click="run('view.toggleNight')">
        <Icon :name="isDarkTheme(settings.theme) ? 'sun' : 'moon'" />
      </button>
      <button class="btn" :title="tipFor('设置', 'app.settings')" @click="run('app.settings')"><Icon name="settings" /></button>
    </div>
    <div v-if="!isMac" class="win">
      <button title="最小化" @click="winAction(() => win.minimize())"><Icon name="min" /></button>
      <button title="最大化" @click="winAction(() => win.toggleMaximize())"><Icon name="max" /></button>
      <button class="close" title="关闭" @click="winAction(() => win.close())"><Icon name="close" /></button>
    </div>
  </header>
</template>
