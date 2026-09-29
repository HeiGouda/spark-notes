import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "../lib/api";
import { useNoticeStore } from "./notice";
import { useVaultStore } from "./vault";

const SYNC_DELAY = 400;

/**
 * 搜索索引的同步调度。`version` 每次同步后加一，标签、反向链接等视图据此刷新。
 * 改名 / 移动期间暂停同步：链接改写依赖改名前的索引。
 */
export const useSearchStore = defineStore("search", () => {
  const version = ref(0);
  const syncing = ref(false);
  const ready = ref(false);
  let timer = 0;
  let suspended = 0;
  let pending = false;
  let running: Promise<void> | null = null;

  async function syncNow(): Promise<void> {
    const root = useVaultStore().root;
    if (!root) return;
    if (suspended > 0) {
      pending = true;
      return;
    }
    if (running) {
      pending = true;
      return running;
    }
    syncing.value = true;
    running = api
      .indexSync(root)
      .then(() => {
        ready.value = true;
        version.value++;
      })
      .catch((e) => useNoticeStore().report("更新搜索索引失败", e))
      .finally(() => {
        running = null;
        syncing.value = false;
        if (pending) {
          pending = false;
          schedule();
        }
      });
    return running;
  }

  function schedule() {
    clearTimeout(timer);
    timer = window.setTimeout(() => void syncNow(), SYNC_DELAY);
  }

  /** 在 fn 执行期间暂停同步；等待进行中的同步结束后再开始 */
  async function paused<T>(fn: () => Promise<T>): Promise<T> {
    suspended++;
    try {
      if (running) await running;
      return await fn();
    } finally {
      suspended--;
    }
  }

  function reset() {
    ready.value = false;
    version.value++;
  }

  return { version, syncing, ready, syncNow, schedule, paused, reset };
});
