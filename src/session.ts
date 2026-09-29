import { watch } from "vue";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "./stores/settings";
import { useVaultStore } from "./stores/vault";
import { useTabsStore } from "./stores/tabs";
import { useSearchStore } from "./stores/search";
import { useNoticeStore } from "./stores/notice";
import { useGitStore } from "./stores/git";
import { useWebdavStore } from "./stores/webdav";

/** 笔记库文件在外部发生变化（Rust 端监听并合并后发出）：刷新文件树、索引和受影响的标签页 */
export async function installVaultEvents(): Promise<void> {
  const vault = useVaultStore();
  const tabs = useTabsStore();
  const search = useSearchStore();
  // 逐个处理：询问“保留哪一份”的弹窗还开着时又来一批变化，不能对同一篇笔记重复询问
  let queue = Promise.resolve();
  await listen<string[]>("vault-changed", (e) => {
    queue = queue.then(async () => {
      try {
        await vault.refresh();
        search.schedule();
        await tabs.onExternalChange(e.payload);
        useGitStore().onExternalChange();
      } catch (err) {
        useNoticeStore().report("处理外部修改失败", err);
      }
    });
  });
}

/** 把打开的标签页、展开的文件夹、排序方式记到本机设置里，下次打开同一笔记库时恢复 */
export function installSessionPersistence(): void {
  const settings = useSettingsStore();
  const vault = useVaultStore();
  const tabs = useTabsStore();

  watch(
    () => ({
      tabs: tabs.tabs.map((t) => t.path),
      active: tabs.activePath,
      expanded: [...vault.expanded],
      sortKey: vault.sortKey,
      sortDesc: vault.sortDesc,
    }),
    (state) => {
      if (vault.root && !vault.switching) settings.patchVaultUi(vault.root, state);
    },
  );
}

/** 打开笔记库后跟踪 Git 状态；编辑时重置自动提交的等待。 */
export function installGit(): void {
  const vault = useVaultStore();
  const tabs = useTabsStore();
  const git = useGitStore();
  watch(
    () => vault.root,
    (path) => {
      if (path) void git.attach(path);
      else git.reset();
    },
    { immediate: true },
  );
  watch(() => tabs.editedTick, () => git.bumpActivity());
  watch(() => tabs.savedTick, () => useWebdavStore().scheduleAfterSave());
  watch(
    () => vault.root,
    (path) => {
      if (path) void useWebdavStore().attach(path);
      else useWebdavStore().reset();
    },
    { immediate: true },
  );
}
