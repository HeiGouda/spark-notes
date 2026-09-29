<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { useMobile } from "./store";
import { activeTab, currentOverlay, open, page, reset, tab, toastMessage, type Tab } from "./nav";
import WelcomePage from "./pages/WelcomePage.vue";
import VaultForm from "./pages/VaultForm.vue";
import FirstSync from "./pages/FirstSync.vue";
import FilesPage from "./pages/FilesPage.vue";
import RecentPage from "./pages/RecentPage.vue";
import SearchPage from "./pages/SearchPage.vue";
import MePage from "./pages/MePage.vue";
import ReaderPage from "./pages/ReaderPage.vue";
import DiagramPage from "./pages/DiagramPage.vue";
import LibsSheet from "./overlays/LibsSheet.vue";
import BulkDialog from "./overlays/BulkDialog.vue";
import DeleteDialog from "./overlays/DeleteDialog.vue";

const store = useMobile();
const ready = ref(false);
const startError = ref("");

const TABS: [Tab, string, "folder" | "recent" | "search" | "me"][] = [
  ["files", "文件", "folder"],
  ["recent", "最近", "recent"],
  ["search", "搜索", "search"],
  ["me", "我的", "me"],
];

onMounted(async () => {
  try {
    await store.init();
    reset(store.homePage === "welcome" ? { p: "welcome" } : { p: "files", path: "" });
  } catch (e) {
    startError.value = e instanceof Error ? e.message : String(e);
  }
  ready.value = true;
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
      <main class="m-main">
        <WelcomePage v-if="page.p === 'welcome'" />
        <VaultForm v-else-if="page.p === 'form'" :key="`form-${page.id}`" :id="page.id" />
        <FirstSync v-else-if="page.p === 'firstsync'" :key="`fs-${page.id}`" :id="page.id" />
        <FilesPage v-else-if="page.p === 'files'" :key="`files-${page.path}`" :path="page.path" />
        <RecentPage v-else-if="page.p === 'recent'" />
        <SearchPage v-else-if="page.p === 'search'" />
        <MePage v-else-if="page.p === 'me'" />
        <ReaderPage v-else-if="page.p === 'note'" :key="`${page.path}#${page.heading ?? ''}`" :path="page.path" :heading="page.heading" />
        <DiagramPage v-else-if="page.p === 'diagram'" :key="page.path" :path="page.path" />
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
      </div>
    </template>
    <div class="m-toast" :class="{ on: toastMessage }">{{ toastMessage }}</div>
  </div>
</template>
