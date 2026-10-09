import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { load, type Store } from "@tauri-apps/plugin-store";
import { mobileApi, type CloudBook, type ShelfBook, type ShelfUsage } from "./api";
import { useMobile } from "./store";
import { toast } from "./nav";
import { convertFileSrc } from "@tauri-apps/api/core";
import { extractCover } from "./reader/cover";

let store: Store | null = null;

async function open(): Promise<Store> {
  store ??= await load("mobile.json", { defaults: {}, autoSave: false });
  return store;
}

export type ShelfSort = "recent" | "added" | "name";

export function bookStem(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** 还没有阅读进度时，“最近阅读”和“导入时间”都按导入先后排 */
export function sortBooks(books: ShelfBook[], key: ShelfSort): ShelfBook[] {
  const out = [...books];
  if (key === "name") out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  else out.sort((a, b) => b.addedMs - a.addedMs);
  return out;
}

/**
 * 书架用哪个笔记库：在“我的 → 书架”里选过且还在的就用它；
 * 没选过（或选的库已删掉）时跟着当前笔记库走，不要让已经连上笔记库的人再去设置里选一遍。
 */
export function resolveShelfVault(chosen: string | null, vaultIds: string[], currentId: string | null): string | null {
  if (chosen && vaultIds.includes(chosen)) return chosen;
  if (currentId && vaultIds.includes(currentId)) return currentId;
  return vaultIds[0] ?? null;
}

export const METERED_LIMIT = 20 * 1024 * 1024;

/** 书架上的进度文字：没读过是“未读”，读到最后是“已读完” */
export function progressLabel(fraction: number | undefined): string {
  if (fraction == null || fraction <= 0) return "未读";
  if (fraction >= 0.995) return "已读完";
  return `读到 ${Math.max(1, Math.round(fraction * 100))}%`;
}

export interface DownloadState {
  name: string;
  percent: number;
}

export const useShelf = defineStore("shelf", () => {
  const books = ref<ShelfBook[]>([]);
  const cloud = ref<CloudBook[]>([]);
  const mobile = useMobile();
  /** 用户在书架设置里明确选的库；没选过是 null */
  const chosenVaultId = ref<string | null>(null);
  const vaultId = computed(() =>
    resolveShelfVault(chosenVaultId.value, mobile.vaults.map((v) => v.id), mobile.currentId),
  );
  const remoteDir = ref("spark-books");
  const usage = ref<ShelfUsage>({ books: 0, bytes: 0 });
  const sort = ref<ShelfSort>("recent");
  const error = ref("");
  /** 每本书读到的位置（书 id → 0～1） */
  const progress = ref<Record<string, number>>({});
  /** 正在下载的书（云端相对路径 → 进度）。放在这里而不是云端页里，离开页面后下载照常进行、回来还能看到进度 */
  const downloads = ref<Record<string, DownloadState>>({});
  /** 书 id → 封面图片地址；空字符串表示书里没有封面，用颜色代替；不在里面的还没取过 */
  const covers = ref<Record<string, string>>({});
  let coverRun: Promise<void> | null = null;
  const coverFailed = new Set<string>();

  async function loadCovers() {
    const found = await mobileApi.shelfCovers();
    covers.value = Object.fromEntries(Object.entries(found).map(([id, path]) => [id, path ? convertFileSrc(path) : ""]));
  }

  /** 给还没有封面的书逐本去书里取封面，在后台慢慢做，不挡着书架 */
  function ensureCovers(): Promise<void> {
    coverRun ??= (async () => {
      try {
        await loadCovers();
        for (const book of books.value) {
          if (book.id in covers.value || coverFailed.has(book.id)) continue;
          try {
            const opened = await mobileApi.shelfBookFile(book.id);
            // 个别文件解析很慢或卡住时不能挡住后面的书
            const data = await Promise.race([
              extractCover(convertFileSrc(opened.path), opened.name),
              new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("取封面超时")), 20_000)),
            ]);
            await mobileApi.shelfCoverSave(book.id, data ?? new Uint8Array());
            // 取到一本就显示一本
            await loadCovers();
          } catch (e) {
            // 这次取不出来就先用颜色，下次打开 App 再试
            coverFailed.add(book.id);
            console.warn("取封面失败", book.name, e);
          }
        }
        await loadCovers();
      } finally {
        coverRun = null;
      }
    })();
    return coverRun;
  }

  const shown = computed(() => sortBooks(books.value, sort.value));
  const onCloud = computed(() => new Set(cloud.value.filter((b) => b.localId).map((b) => b.localId)));

  async function persist() {
    const s = await open();
    await s.set("shelfVaultId", chosenVaultId.value);
    await s.set("shelfRemoteDir", remoteDir.value);
    await s.save();
  }

  async function refreshLocal() {
    books.value = await mobileApi.shelfList();
    usage.value = await mobileApi.shelfUsage();
    progress.value = await mobileApi.shelfProgress().catch(() => progress.value);
  }

  /** 刚导入的书先放上书架，不等重新读整个书架 */
  function addLocal(added: ShelfBook[]) {
    const ids = new Set(added.map((b) => b.id));
    books.value = [...added, ...books.value.filter((b) => !ids.has(b.id))];
  }

  function setDownload(rel: string, state: DownloadState | null) {
    const next = { ...downloads.value };
    if (state) next[rel] = state;
    else delete next[rel];
    downloads.value = next;
  }

  /** 下载一本书。下载期间离开云端页也不会中断，完成或失败时弹提示 */
  async function download(book: CloudBook): Promise<void> {
    const id = vaultId.value;
    if (!id || downloads.value[book.rel]) return;
    setDownload(book.rel, { name: book.name, percent: 0 });
    try {
      await mobileApi.shelfDownload(id, remoteDir.value, book.rel, ({ done, total }) => {
        const size = total || book.size;
        setDownload(book.rel, { name: book.name, percent: size ? Math.min(99, Math.floor((done / size) * 100)) : 0 });
      });
      setDownload(book.rel, null);
      await refreshLocal();
      await refreshCloud().catch(() => {});
      void ensureCovers().catch(() => {});
      toast(`《${bookStem(book.name)}》已加入书架`);
    } catch (e) {
      setDownload(book.rel, null);
      toast(`《${bookStem(book.name)}》下载失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function init() {
    const s = await open();
    const id = await s.get<unknown>("shelfVaultId");
    const dir = await s.get<unknown>("shelfRemoteDir");
    chosenVaultId.value = typeof id === "string" && id ? id : null;
    remoteDir.value = typeof dir === "string" && dir.trim() ? dir.trim() : "spark-books";
    await refreshLocal().catch((e) => {
      error.value = e instanceof Error ? e.message : String(e);
    });
  }

  async function setVault(id: string | null) {
    chosenVaultId.value = id;
    await persist();
  }

  async function setRemoteDir(dir: string) {
    remoteDir.value = dir.trim() || "spark-books";
    await persist();
  }

  async function refreshCloud() {
    if (!vaultId.value) throw new Error("先选择读书笔记库");
    cloud.value = await mobileApi.shelfCloud(vaultId.value, remoteDir.value);
    error.value = "";
  }

  return {
    books, cloud, vaultId, remoteDir, usage, sort, error, shown, onCloud, progress, downloads, covers,
    init, refreshLocal, addLocal, refreshCloud, setVault, setRemoteDir, download, ensureCovers,
  };
});
