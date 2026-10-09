<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { useMobile } from "./store";
import { useMobileAi } from "./ai";
import { useShelf } from "./shelf";
import { activeTab, currentOverlay, exitBump, open, page, reset, tab, toastMessage, type Tab } from "./nav";
import WelcomePage from "./pages/WelcomePage.vue";
import VaultForm from "./pages/VaultForm.vue";
import FirstSync from "./pages/FirstSync.vue";
import FilesPage from "./pages/FilesPage.vue";
import RecentPage from "./pages/RecentPage.vue";
import SearchPage from "./pages/SearchPage.vue";
import ShelfPage from "./pages/ShelfPage.vue";
import CloudShelfPage from "./pages/CloudShelfPage.vue";
import AssistantPage from "./pages/AssistantPage.vue";
import MePage from "./pages/MePage.vue";
import ShelfSettingsPage from "./pages/ShelfSettingsPage.vue";
import AiModelsPage from "./pages/AiModelsPage.vue";
import AiModelFormPage from "./pages/AiModelFormPage.vue";
import ReaderSettingsPage from "./pages/ReaderSettingsPage.vue";
import AboutPage from "./pages/AboutPage.vue";
import AiSheet from "./chat/AiSheet.vue";
import ReaderPage from "./pages/ReaderPage.vue";
import DiagramPage from "./pages/DiagramPage.vue";
import EbookPage from "./pages/EbookPage.vue";
import LibsSheet from "./overlays/LibsSheet.vue";
import BulkDialog from "./overlays/BulkDialog.vue";
import DeleteDialog from "./overlays/DeleteDialog.vue";
import AskDialog from "./overlays/AskDialog.vue";

const store = useMobile();
const ai = useMobileAi();
const shelf = useShelf();
const ready = ref(false);
const startError = ref("");

const TABS: [Tab, string, "folder" | "book" | "spark" | "me"][] = [
  ["files", "文件", "folder"],
  ["shelf", "书架", "book"],
  ["assistant", "助手", "spark"],
  ["me", "我的", "me"],
];

onMounted(async () => {
  try {
    await Promise.all([store.init(), ai.init(), shelf.init()]);
    reset(store.homePage === "welcome" ? { p: "welcome" } : { p: "files", path: "" });
  } catch (e) {
    startError.value = e instanceof Error ? e.message : String(e);
  }
  ready.value = true;
});

// 在首页再返回时，页面左右弹一下，提醒再返回一次才退出
const bumping = ref(false);
let bumpTimer = 0;
watch(exitBump, () => {
  bumping.value = false;
  clearTimeout(bumpTimer);
  void nextTick(() => {
    bumping.value = true;
    bumpTimer = window.setTimeout(() => (bumping.value = false), 400);
  });
});

// 同步时发现删除太多，直接弹出确认框
watch(
  () => store.sync.state,
  (state) => {
    if (state === "held" && !currentOverlay.value) open({ t: "bulk" });
  },
);
</script>

<template>
  <div class="m-app">
    <div v-if="startError" class="m-empty">Spark 启动失败：{{ startError }}</div>
    <template v-else-if="ready">
      <main class="m-main" :class="{ bump: bumping }">
        <WelcomePage v-if="page.p === 'welcome'" />
        <VaultForm v-else-if="page.p === 'form'" :key="`form-${page.id}`" :id="page.id" />
        <FirstSync v-else-if="page.p === 'firstsync'" :key="`fs-${page.id}`" :id="page.id" />
        <FilesPage v-else-if="page.p === 'files'" :key="`files-${page.path}`" :path="page.path" />
        <RecentPage v-else-if="page.p === 'recent'" />
        <SearchPage v-else-if="page.p === 'search'" />
        <ShelfPage v-else-if="page.p === 'shelf'" />
        <CloudShelfPage v-else-if="page.p === 'cloud'" />
        <AssistantPage v-else-if="page.p === 'assistant'" />
        <MePage v-else-if="page.p === 'me'" />
        <ShelfSettingsPage v-else-if="page.p === 'shelf-settings'" />
        <AiModelsPage v-else-if="page.p === 'ai-models'" />
        <AiModelFormPage v-else-if="page.p === 'ai-model'" :key="`model-${page.id ?? 'new'}`" :id="page.id" />
        <ReaderSettingsPage v-else-if="page.p === 'reader-settings'" />
        <AboutPage v-else-if="page.p === 'about'" />
        <ReaderPage v-else-if="page.p === 'note'" :key="`${page.path}#${page.heading ?? ''}`" :path="page.path" :heading="page.heading" />
        <DiagramPage v-else-if="page.p === 'diagram'" :key="page.path" :path="page.path" />
        <EbookPage v-else-if="page.p === 'ebook'" :key="page.id" :id="page.id" />
      </main>
      <nav v-if="activeTab" class="m-tabs">
        <button v-for="[key, label, icon] in TABS" :key="key" :class="{ on: activeTab === key }" @click="tab(key)">
          <Icon :name="icon" />{{ label }}
        </button>
      </nav>
      <div v-if="currentOverlay && ['libs', 'bulk', 'del'].includes(currentOverlay.t)" class="m-ovl">
        <LibsSheet v-if="currentOverlay.t === 'libs'" />
        <BulkDialog v-else-if="currentOverlay.t === 'bulk'" />
        <DeleteDialog v-else-if="currentOverlay.t === 'del'" :id="currentOverlay.id" />
        <AiSheet v-else-if="currentOverlay.t === 'ai'" :quote="currentOverlay.quote" />
      </div>
    </template>
    <AskDialog />
    <div class="m-toast" :class="{ on: toastMessage }">{{ toastMessage }}</div>
  </div>
</template>
