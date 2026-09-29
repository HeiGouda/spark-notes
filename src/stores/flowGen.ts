import { defineStore } from "pinia";
import { ref, watch } from "vue";
import type { ChatMessage } from "../lib/api";
import { api } from "../lib/api";
import { formatTokens, messagesTokens } from "../lib/aiModels";
import { DOC_EXT } from "../lib/doctype";
import { aiFlowTitle, flowFileName, flowGenMessages, flowReviseMessages, parseAiFlow, type GenDir } from "../diagram/flowGen";
import { serializeFlow, type FlowDoc } from "../diagram/flowchart";
import { AiCancelled, useAiStore } from "./ai";
import { useTabsStore } from "./tabs";
import { useVaultStore } from "./vault";
import { useNoticeStore } from "./notice";
import { useSearchStore } from "./search";
import { useSettingsStore } from "./settings";

export interface FlowGen {
  /** 画进已有的空白流程图，而不是新开草稿 */
  inplace: boolean;
  /** 草稿保留时写入的文件夹 */
  folder: string;
  desc: string;
  dir: GenDir;
  status: "running" | "done" | "stopped" | "error";
  /** 当前这一版的回复全文（生成中为目前收到的部分） */
  text: string;
  /** 按意见修改之前的那一版，用于“回到上一版” */
  prev: string | null;
  /** 当前这次请求是按意见修改 */
  revising: boolean;
  error: string | null;
  cancel: (() => void) | null;
}

export type FlowGenTarget = { kind: "folder"; folder: string } | { kind: "inplace"; path: string } | { kind: "regen"; path: string };

export interface FlowGenDialog {
  desc: string;
  dir: GenDir;
  target: FlowGenTarget;
}

/**
 * AI 生成流程图（需求文档 5.18）：新开草稿标签页（或画进空白流程图），生成期间不写磁盘；
 * 结束后可以按意见修改、回到上一版，由用户选择保留或丢弃。
 */
export const useFlowGenStore = defineStore("flowGen", () => {
  /** 标签页路径 → 生成状态 */
  const gens = ref<Record<string, FlowGen>>({});
  /** 正在写入磁盘的保留：按钮停用，也避免连点保存出两份 */
  const saving = ref<Record<string, true>>({});
  const dialog = ref<FlowGenDialog | null>(null);
  const notice = () => useNoticeStore();

  function tooLong(messages: ChatMessage[], what: string): string | null {
    const tokens = messagesTokens(messages);
    const budget = useAiStore().defaultBudget();
    return tokens > budget ? `${what}过长（约 ${formatTokens(tokens)} tokens，当前模型最多可发送约 ${formatTokens(budget)} tokens）` : null;
  }

  function openDialog(target: FlowGenTarget, desc = "") {
    if (!useAiStore().ensureConfigured()) return;
    if (target.kind === "regen") {
      const g = gens.value[target.path];
      if (!g) return;
      dialog.value = { desc: g.desc, dir: g.dir, target };
    } else {
      dialog.value = { desc, dir: "auto", target };
    }
  }

  /** 输入框里的描述超过长度上限时返回提示 */
  function checkDesc(desc: string, dir: GenDir): string | null {
    return tooLong(flowGenMessages(desc, dir), "描述");
  }

  /** 同一文件夹下不重名的草稿路径 */
  function draftPath(folder: string): string {
    const vault = useVaultStore();
    const tabs = useTabsStore();
    const taken = new Set([...vault.docPaths, ...tabs.tabs.map((t) => t.path)].map((p) => p.toLowerCase()));
    for (let i = 0; ; i++) {
      const rel = `${folder ? `${folder}/` : ""}${i ? `AI 流程图 ${i}` : "AI 流程图"}${DOC_EXT.flow}`;
      if (!taken.has(rel.toLowerCase())) return rel;
    }
  }

  function submit(desc: string, dir: GenDir) {
    const d = dialog.value;
    if (!d || !desc.trim() || checkDesc(desc, dir)) return;
    dialog.value = null;
    const fresh = (inplace: boolean, folder: string): FlowGen => ({
      inplace, folder, desc, dir, status: "running", text: "", prev: null, revising: false, error: null, cancel: null,
    });
    let path: string;
    if (d.target.kind === "folder") {
      path = draftPath(d.target.folder);
      gens.value = { ...gens.value, [path]: fresh(false, d.target.folder) };
      useTabsStore().openDraft(path, "flow");
    } else if (d.target.kind === "inplace") {
      path = d.target.path;
      gens.value = { ...gens.value, [path]: fresh(true, "") };
    } else {
      path = d.target.path;
      const g = gens.value[path];
      if (!g) return;
      g.cancel?.();
      Object.assign(g, { desc, dir, status: "running", text: "", prev: null, revising: false, error: null });
    }
    run(path, flowGenMessages(desc, dir));
  }

  function run(path: string, messages: ChatMessage[]) {
    const gen = gens.value[path];
    if (!gen) return;
    const job = useAiStore().run(messages, (full) => {
      const g = gens.value[path];
      if (!g || g.cancel !== job.cancel) return;
      g.text = full;
      nameDraft(path, full);
    });
    gen.cancel = job.cancel;
    job.done.then(
      (full) => {
        const g = gens.value[path];
        if (!g || g.cancel !== job.cancel) return;
        g.text = full;
        g.status = "done";
        g.cancel = null;
        nameDraft(path, full);
      },
      (e: unknown) => {
        const g = gens.value[path];
        if (!g || g.cancel !== job.cancel) return;
        g.cancel = null;
        if (e instanceof AiCancelled) g.status = "stopped";
        else {
          g.status = "error";
          g.error = e instanceof Error ? e.message : String(e);
        }
      },
    );
  }

  /** 草稿标签页的标题换成 AI 给的标题 */
  function nameDraft(path: string, text: string) {
    const tab = useTabsStore().tabs.find((t) => t.path === path);
    const title = aiFlowTitle(text);
    if (tab?.draft && title && tab.name !== title) tab.name = title;
  }

  function stop(path: string) {
    gens.value[path]?.cancel?.();
  }

  /** 按意见修改当前这一版 */
  function revise(path: string, feedback: string): boolean {
    const g = gens.value[path];
    if (!g || g.status === "running" || !feedback.trim()) return false;
    const current = parseAiFlow(g.text, g.dir, g.status === "done");
    if (!current.doc.nodes.length) return false;
    const messages = flowReviseMessages(g.desc, g.dir, current, feedback);
    const long = tooLong(messages, "流程图和修改意见");
    if (long) {
      notice().report("无法修改流程图", long);
      return false;
    }
    Object.assign(g, { prev: g.text, text: "", status: "running", revising: true, error: null });
    run(path, messages);
    return true;
  }

  /** 回到按意见修改之前的那一版，只保留一级 */
  function back(path: string) {
    const g = gens.value[path];
    if (!g || g.status === "running" || g.prev === null) return;
    Object.assign(g, { text: g.prev, prev: null, status: "done", revising: false, error: null });
    nameDraft(path, g.text);
  }

  /**
   * 保留。草稿写成新文件；画进空白流程图时返回生成的图，由标签页交给编辑器作为一步操作写入。
   */
  async function keep(path: string): Promise<FlowDoc | null> {
    const g = gens.value[path];
    const vault = useVaultStore();
    if (!g || !vault.root || g.status === "running" || saving.value[path]) return null;
    const result = parseAiFlow(g.text, g.dir, g.status === "done");
    if (!result.doc.nodes.length) return null;
    saving.value = { ...saving.value, [path]: true };
    if (g.inplace) {
      forget(path);
      endSaving(path);
      return result.doc;
    }
    const content = serializeFlow(result.doc);
    try {
      const rel = await api.createNote(vault.root, g.folder, flowFileName(result.title), "flow");
      await api.writeNote(vault.root, rel, content);
      // 等待期间标签页被关掉（等于丢弃）：文件放进回收站，不留下
      if (!gens.value[path]) {
        endSaving(path);
        await api.trash(vault.root, rel).catch(() => {});
        return null;
      }
      // 生成期间的缩放跟着新文件走
      const view = useSettingsStore().diagramView(vault.root, path);
      if (view.zoom !== undefined) useSettingsStore().patchDiagramView(vault.root, rel, { zoom: view.zoom });
      forget(path);
      endSaving(path);
      useTabsStore().finalizeDraft(path, rel, content);
      await vault.refresh();
      useSearchStore().schedule();
    } catch (e) {
      endSaving(path);
      notice().report("保存流程图失败", e);
    }
    return null;
  }

  function endSaving(path: string) {
    if (!saving.value[path]) return;
    const next = { ...saving.value };
    delete next[path];
    saving.value = next;
  }

  function discard(path: string) {
    const g = gens.value[path];
    if (!g || saving.value[path]) return;
    stop(path);
    forget(path);
    if (!g.inplace) void useTabsStore().close(path);
  }

  function forget(path: string) {
    const next = { ...gens.value };
    delete next[path];
    gens.value = next;
  }

  /** 标签页被直接关掉时，停止请求并丢弃 */
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

  return { gens, saving, dialog, openDialog, checkDesc, submit, stop, revise, back, keep, discard };
});
