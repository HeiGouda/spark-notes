import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/kit/prose/tables/style/tables.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/editor.css";
import App from "./App.vue";
import { applyTheme, loadSettings, useSettingsStore } from "./stores/settings";
import { useVaultStore } from "./stores/vault";
import { useNoticeStore } from "./stores/notice";
import { registerAppCommands } from "./appCommands";
import { installGit, installSessionPersistence, installVaultEvents } from "./session";

async function bootstrap() {
  const pinia = createPinia();
  const app = createApp(App).use(pinia);
  const settings = useSettingsStore();
  let loadError: unknown = null;
  try {
    const s = await loadSettings();
    settings.hydrate(s);
  } catch (e) {
    loadError = e;
  }
  // 窗口默认隐藏（tauri.conf.json visible:false），主题应用后再显示，避免启动闪白
  applyTheme(settings.theme);
  registerAppCommands();
  installSessionPersistence();
  installGit();
  await installVaultEvents();
  app.mount("#app");
  if (loadError) useNoticeStore().report("读取设置失败，已使用默认设置", loadError);
  await nextTick();
  await getCurrentWindow().show();
  if (settings.openLastVault && settings.lastVault) await useVaultStore().openVault(settings.lastVault);
}

bootstrap().catch(async (e) => {
  console.error("启动失败", e);
  document.body.textContent = `Spark 启动失败：${e instanceof Error ? e.message : String(e)}`;
  await getCurrentWindow().show();
});
