import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { api, dirOf } from "../lib/api";
import { mindMapMessages, tooLongMessage } from "../lib/ai";
import { messagesTokens } from "../lib/aiModels";
import { splitFrontMatter } from "../lib/frontmatter";
import { toLf } from "../lib/eol";
import { DOC_EXT, docName } from "../lib/doctype";
import { parseAiMind, serializeMind } from "../diagram/mindmap";
import { AiCancelled, useAiStore } from "./ai";
import { useTabsStore } from "./tabs";
import { useVaultStore } from "./vault";
import { useEditorStore } from "./editor";
import { useNoticeStore } from "./notice";
import { useSearchStore } from "./search";
import { useSettingsStore } from "./settings";

export interface MindGen {
  /** 生成依据的笔记 */
  source: string;
  status: "running" | "done" | "stopped" | "error";
  /** 目前收到的回复全文 */
  text: string;
  error: string | null;
  cancel: (() => void) | null;
}

/**
 * AI 把笔记生成思维导图（需求文档 5.18）：生成期间放在草稿标签页里，不写磁盘；
 * 结束后由用户选择保留（写入 `笔记名 导图.mind.mmd`）或丢弃。
 */
export const useMindGenStore = defineStore("mindGen", () => {
  /** 草稿路径 → 生成状态 */
  const gens = ref<Record<string, MindGen>>({});
  /** 正在写入磁盘的保留：按钮停用，也避免连点保存出两份 */
  const saving = ref<Record<string, true>>({});
  const notice = () => useNoticeStore();

  /** 同一文件夹下不重名的草稿路径：`笔记名 导图.mind.mmd`、`笔记名 导图 1.mind.mmd`…… */
  function draftPath(notePath: string): string {
    const vault = useVaultStore();
    const tabs = useTabsStore();
    const dir = dirOf(notePath);
    const taken = new Set([...vault.docPaths, ...tabs.tabs.map((t) => t.path)].map((p) => p.toLowerCase()));
    const base = `${docName(notePath)} 导图`;
    for (let i = 0; ; i++) {
      const name = i ? `${base} ${i}` : base;
      const rel = `${dir ? `${dir}/` : ""}${name}${DOC_EXT.mind}`;
      if (!taken.has(rel.toLowerCase())) return rel;
    }
  }

  async function noteText(notePath: string): Promise<string> {
    const tabs = useTabsStore();
    useEditorStore().pull(notePath);
    const open = tabs.tabs.find((t) => t.path === notePath);
    if (open) return open.body;
    const vault = useVaultStore();
    return splitFrontMatter(toLf((await api.readNote(vault.root!, notePath)).content)).body;
  }

  async function start(notePath: string): Promise<void> {
    const ai = useAiStore();
    const vault = useVaultStore();
    if (!vault.root || !ai.ensureConfigured()) return;
    let body: string;
    try {
      body = await noteText(notePath);
    } catch (e) {
      notice().report("读取笔记失败", e);
      return;
    }
    const messages = mindMapMessages(docName(notePath), body);
    const tokens = messagesTokens(messages);
    const budget = ai.defaultBudget();
    if (tokens > budget) {
      notice().report("无法生成思维导图", tooLongMessage(tokens, budget));
      return;
    }
    const path = draftPath(notePath);
    gens.value = { ...gens.value, [path]: { source: notePath, status: "running", text: "", error: null, cancel: null } };
    useTabsStore().openDraft(path, "mind");
    run(path, messages);
  }

  function run(path: string, messages: ReturnType<typeof mindMapMessages>) {
    const gen = gens.value[path];
    if (!gen) return;
    const job = useAiStore().run(messages, (full) => {
      const g = gens.value[path];
      if (g) g.text = full;
    });
    gen.cancel = job.cancel;
    job.done.then(
      (full) => {
        const g = gens.value[path];
        if (!g) return;
        g.text = full;
        g.status = "done";
        g.cancel = null;
      },
      (e: unknown) => {
        const g = gens.value[path];
        if (!g) return;
        g.cancel = null;
        if (e instanceof AiCancelled) g.status = "stopped";
        else {
          g.status = "error";
          g.error = e instanceof Error ? e.message : String(e);
        }
      },
    );
  }

  function stop(path: string) {
    gens.value[path]?.cancel?.();
  }

  async function regenerate(path: string) {
    const gen = gens.value[path];
    if (!gen) return;
    let body: string;
    try {
      body = await noteText(gen.source);
    } catch (e) {
      notice().report("读取笔记失败", e);
      return;
    }
    Object.assign(gen, { status: "running", text: "", error: null });
    run(path, mindMapMessages(docName(gen.source), body));
  }

  async function keep(path: string) {
    const gen = gens.value[path];
    const vault = useVaultStore();
    if (!gen || !vault.root || gen.status === "running" || saving.value[path]) return;
    saving.value = { ...saving.value, [path]: true };
    try {
      const content = serializeMind(parseAiMind(gen.text, docName(path)).doc);
      const rel = await api.createNote(vault.root, dirOf(path), docName(path), "mind");
      await api.writeNote(vault.root, rel, content);
      if (!gens.value[path]) {
        endSaving(path);
        await api.trash(vault.root, rel).catch(() => {});
        return;
      }
      const view = useSettingsStore().diagramView(vault.root, path);
      if (view.zoom !== undefined) useSettingsStore().patchDiagramView(vault.root, rel, { zoom: view.zoom });
      forget(path);
      endSaving(path);
      useTabsStore().finalizeDraft(path, rel, content);
      await vault.refresh();
      useSearchStore().schedule();
    } catch (e) {
      endSaving(path);
      notice().report("保存思维导图失败", e);
    }
  }

  function endSaving(path: string) {
    if (!saving.value[path]) return;
    const next = { ...saving.value };
    delete next[path];
    saving.value = next;
  }

  function discard(path: string) {
    if (saving.value[path]) return;
    stop(path);
    forget(path);
    void useTabsStore().close(path);
  }

  function forget(path: string) {
    const next = { ...gens.value };
    delete next[path];
    gens.value = next;
  }

  /** 草稿标签页被直接关掉时，停止请求并丢弃 */
  watch(
    () => useTabsStore().tabs.map((t) => t.path),
    (paths) => {
      const open = new Set(paths);
      for (const p of Object.keys(gens.value)) {
        if (!open.has(p)) {
          stop(p);
          forget(p);
        }
      }
    },
  );

  return { gens, saving, start, stop, regenerate, keep, discard };
});
