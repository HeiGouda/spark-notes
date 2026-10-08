import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { api, dirOf, type ChatMessage } from "../lib/api";
import { mindDescMessages, mindMapMessages, tooLongMessage } from "../lib/ai";
import { formatTokens, messagesTokens } from "../lib/aiModels";
import { splitFrontMatter } from "../lib/frontmatter";
import { toLf } from "../lib/eol";
import { DOC_EXT, docName } from "../lib/doctype";
import { parseAiMind, serializeMind, type MindDoc } from "../diagram/mindmap";
import { AiCancelled, useAiStore } from "./ai";
import { useTabsStore } from "./tabs";
import { useVaultStore } from "./vault";
import { useEditorStore } from "./editor";
import { useNoticeStore } from "./notice";
import { useSearchStore } from "./search";
import { useSettingsStore } from "./settings";

/** 生成时选的布局；“自动”按一级分支的数量决定 */
export type MindGenLayout = "auto" | "right" | "left" | "balanced";

export const MIND_GEN_LAYOUTS: { id: MindGenLayout; label: string }[] = [
  { id: "auto", label: "自动" },
  { id: "right", label: "向右" },
  { id: "left", label: "向左" },
  { id: "balanced", label: "左右平衡" },
];

/** 一级分支达到这个数量时，“自动”用左右平衡，否则向右 */
const BALANCED_FROM = 5;

export interface MindGen {
  /** 根据哪篇笔记生成；根据描述生成时为 null */
  source: string | null;
  /** 根据描述生成时的描述 */
  desc: string;
  layout: MindGenLayout;
  /** 画进已有的空白思维导图，而不是新开草稿 */
  inplace: boolean;
  status: "running" | "done" | "stopped" | "error";
  /** 目前收到的回复全文 */
  text: string;
  error: string | null;
  cancel: (() => void) | null;
}

export type MindGenTarget = { kind: "folder"; folder: string } | { kind: "inplace"; path: string } | { kind: "regen"; path: string };

export interface MindGenDialog {
  desc: string;
  layout: MindGenLayout;
  target: MindGenTarget;
}

/** 解析 AI 的回复并套上所选布局；生成中和保留时用的是同一张图 */
export function aiMindDoc(text: string, fallbackRoot: string, layout: MindGenLayout): { doc: MindDoc; skipped: number } {
  const r = parseAiMind(text, fallbackRoot);
  if (layout !== "auto") r.doc.canvas = { ...r.doc.canvas, structure: layout };
  else if (r.doc.root.children.length >= BALANCED_FROM) r.doc.canvas = { ...r.doc.canvas, structure: "balanced" };
  return r;
}

/** 用根节点文字做文件名：去掉文件名里不能用的字符，过长时截短 */
export function mindFileName(rootText: string): string {
  const clean = rootText.replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return [...clean].slice(0, 40).join("").trim() || "思维导图";
}

/**
 * AI 生成思维导图（需求文档 5.18）：根据笔记全文，或根据描述（含笔记里选中的文字）。
 * 生成期间放在草稿标签页里（或画进空白思维导图），不写磁盘；结束后由用户选择保留或丢弃。
 */
export const useMindGenStore = defineStore("mindGen", () => {
  /** 标签页路径 → 生成状态 */
  const gens = ref<Record<string, MindGen>>({});
  /** 正在写入磁盘的保留：按钮停用，也避免连点保存出两份 */
  const saving = ref<Record<string, true>>({});
  const dialog = ref<MindGenDialog | null>(null);
  const notice = () => useNoticeStore();

  /** 同一文件夹下不重名的草稿路径：`基本名.mind.mmd`、`基本名 1.mind.mmd`…… */
  function draftPath(dir: string, base: string): string {
    const vault = useVaultStore();
    const tabs = useTabsStore();
    const taken = new Set([...vault.docPaths, ...tabs.tabs.map((t) => t.path)].map((p) => p.toLowerCase()));
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

  function fresh(source: string | null, desc: string, layout: MindGenLayout, inplace: boolean): MindGen {
    return { source, desc, layout, inplace, status: "running", text: "", error: null, cancel: null };
  }

  /** 把整篇笔记生成思维导图 */
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
    const path = draftPath(dirOf(notePath), `${docName(notePath)} 导图`);
    gens.value = { ...gens.value, [path]: fresh(notePath, "", "auto", false) };
    useTabsStore().openDraft(path, "mind");
    run(path, messages);
  }

  /** 打开“AI 生成思维导图”对话框；desc 为预先填好的文字（笔记里选中的） */
  function openDialog(target: MindGenTarget, desc = "") {
    if (!useAiStore().ensureConfigured()) return;
    if (target.kind === "regen") {
      const g = gens.value[target.path];
      if (!g) return;
      dialog.value = { desc: g.desc, layout: g.layout, target };
    } else {
      dialog.value = { desc, layout: "auto", target };
    }
  }

  /** 描述超过长度上限时返回提示 */
  function checkDesc(desc: string): string | null {
    const tokens = messagesTokens(mindDescMessages(desc));
    const budget = useAiStore().defaultBudget();
    return tokens > budget ? `描述过长（约 ${formatTokens(tokens)} tokens，当前模型最多可发送约 ${formatTokens(budget)} tokens）` : null;
  }

  function submit(desc: string, layout: MindGenLayout) {
    const d = dialog.value;
    if (!d || !desc.trim() || checkDesc(desc)) return;
    dialog.value = null;
    let path: string;
    if (d.target.kind === "folder") {
      path = draftPath(d.target.folder, "AI 思维导图");
      gens.value = { ...gens.value, [path]: fresh(null, desc, layout, false) };
      useTabsStore().openDraft(path, "mind");
    } else if (d.target.kind === "inplace") {
      path = d.target.path;
      gens.value = { ...gens.value, [path]: fresh(null, desc, layout, true) };
    } else {
      path = d.target.path;
      const g = gens.value[path];
      if (!g) return;
      g.cancel?.();
      Object.assign(g, { desc, layout, status: "running", text: "", error: null });
    }
    run(path, mindDescMessages(desc));
  }

  function run(path: string, messages: ChatMessage[]) {
    const gen = gens.value[path];
    if (!gen) return;
    const job = useAiStore().run(messages, (full) => {
      const g = gens.value[path];
      if (!g || g.cancel !== job.cancel) return;
      g.text = full;
      nameDraft(path);
    });
    gen.cancel = job.cancel;
    job.done.then(
      (full) => {
        const g = gens.value[path];
        if (!g || g.cancel !== job.cancel) return;
        g.text = full;
        g.status = "done";
        g.cancel = null;
        nameDraft(path);
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

  /** 根据描述生成的草稿：标签页标题换成 AI 给的主题 */
  function nameDraft(path: string) {
    const g = gens.value[path];
    const tab = useTabsStore().tabs.find((t) => t.path === path);
    if (!g || g.source || !tab?.draft) return;
    const root = parseAiMind(g.text, "").doc.root.text.trim();
    if (root && tab.name !== root) tab.name = root;
  }

  function stop(path: string) {
    gens.value[path]?.cancel?.();
  }

  /** 根据笔记生成的直接重来；根据描述生成的打开对话框，可以改描述和布局 */
  async function regenerate(path: string) {
    const gen = gens.value[path];
    if (!gen) return;
    if (!gen.source) {
      openDialog({ kind: "regen", path });
      return;
    }
    let body: string;
    try {
      body = await noteText(gen.source);
    } catch (e) {
      notice().report("读取笔记失败", e);
      return;
    }
    gen.cancel?.();
    Object.assign(gen, { status: "running", text: "", error: null });
    run(path, mindMapMessages(docName(gen.source), body));
  }

  /**
   * 保留。草稿写成新文件；画进空白思维导图时返回生成的图，由标签页交给编辑器作为一步操作写入。
   */
  async function keep(path: string): Promise<MindDoc | null> {
    const gen = gens.value[path];
    const vault = useVaultStore();
    if (!gen || !vault.root || gen.status === "running" || saving.value[path]) return null;
    const tab = useTabsStore().tabs.find((t) => t.path === path);
    const { doc } = aiMindDoc(gen.text, tab?.name ?? docName(path), gen.layout);
    if (!doc.root.children.length) return null;
    saving.value = { ...saving.value, [path]: true };
    if (gen.inplace) {
      forget(path);
      endSaving(path);
      return doc;
    }
    try {
      const content = serializeMind(doc);
      const name = gen.source ? docName(path) : mindFileName(doc.root.text);
      // 在表格簿里生成的作为新的一张表放进同一个簿
      const rel = await vault.createDocIn(dirOf(path), "mind", name);
      await api.writeNote(vault.root, rel, content);
      // 等待期间标签页被关掉（等于丢弃）：文件放进回收站，不留下
      if (!gens.value[path]) {
        endSaving(path);
        await api.trash(vault.root, rel).catch(() => {});
        return null;
      }
      const view = useSettingsStore().diagramView(vault.root, path);
      if (view.zoom !== undefined) useSettingsStore().patchDiagramView(vault.root, rel, { zoom: view.zoom });
      forget(path);
      endSaving(path);
      useTabsStore().finalizeDraft(path, rel, content);
      await vault.refresh();
      await vault.appendToOrder(rel);
      useSearchStore().schedule();
    } catch (e) {
      endSaving(path);
      notice().report("保存思维导图失败", e);
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

  return { gens, saving, dialog, start, openDialog, checkDesc, submit, stop, regenerate, keep, discard };
});
