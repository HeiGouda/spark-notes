import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { api } from "./lib/api";
import { useNoticeStore } from "./stores/notice";
import { insertAttachments, type SavedAttachment } from "./editor/attachments";
import { registerCommands, shortcutOf, type AppCommand } from "./lib/commands";
import { useSettingsStore } from "./stores/settings";
import { useVaultStore } from "./stores/vault";
import { useTabsStore } from "./stores/tabs";
import { useEditorStore } from "./stores/editor";
import { useUiStore } from "./stores/ui";
import { useGitStore } from "./stores/git";
import { useWebdavStore } from "./stores/webdav";
import { FORMAT_ACTIONS, HEADING_LABELS, HEADING_SHORTCUTS, setBlockLevel } from "./editor/formatActions";
import { selectionText } from "./editor/find";
import { describeTidy, tidyTransaction } from "./editor/tidy";
import { editorViewCtx } from "@milkdown/kit/core";
import { displayShortcut } from "./lib/shortcut";
import { openAiBlock } from "./editor/aiBlock";
import { readMarkdown } from "./editor/createEditor";
import { countWords } from "./lib/wordcount";
import { instructionMessages, tooLongMessage } from "./lib/ai";
import { messagesTokens } from "./lib/aiModels";
import { AiCancelled, useAiStore } from "./stores/ai";
import { useChatStore } from "./stores/chat";
import { THEMES, themeCommandId } from "./lib/themes";

/** 插入类的格式工具，在命令面板里归到“插入” */
const INSERT_ACTIONS = new Set(["codeBlock", "hr", "table", "wikilink", "footnote"]);

/** 默认快捷键见需求文档 4.3 与 5.13；null 表示默认无快捷键 */
export function registerAppCommands(): void {
  const settings = useSettingsStore();
  const vault = useVaultStore();
  const tabs = useTabsStore();
  const editor = useEditorStore();
  const ui = useUiStore();
  const git = useGitStore();
  const webdav = useWebdavStore();
  const hasEditor = () => !!editor.editor;
  const hasVault = () => !!vault.root;
  const onEditor = (fn: (e: NonNullable<typeof editor.editor>) => unknown) => () => {
    if (editor.editor) fn(editor.editor);
  };

  /** 选择本地图片，复制到当前笔记的附件目录后插入 */
  async function insertImageFromDialog() {
    const note = tabs.activePath;
    if (!vault.root || !note || !editor.editor) return;
    const picked = await open({
      multiple: true,
      title: "选择图片",
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"] }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    const items: SavedAttachment[] = [];
    for (const p of paths) {
      try {
        const link = await api.importAttachment(vault.root, note, p);
        items.push({ link, name: p.split(/[\\/]/).pop() ?? p, isImage: true });
      } catch (e) {
        useNoticeStore().report(`导入图片失败 ${p}`, e);
      }
    }
    // 弹窗期间可能切换了笔记，只插入到原来的笔记
    if (items.length && editor.editor && editor.path === note) insertAttachments(editor.editor, items);
  }

  /** 一键整理（需求文档 5.15），结果在状态栏提示 */
  function tidyNote(e: NonNullable<typeof editor.editor>) {
    const { counts, total } = e.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const result = tidyTransaction(view.state, settings.tidyRules);
      if (result.tr.docChanged) view.dispatch(result.tr);
      return result;
    });
    const undoKey = displayShortcut(shortcutOf("edit.undo"));
    useNoticeStore().inform(total && undoKey ? `${describeTidy(counts)} · ${undoKey} 撤销` : describeTidy(counts));
  }

  const ai = useAiStore();

  /** 斜杠菜单“AI 指令”（需求文档 5.16） */
  function openInstruction(e: NonNullable<typeof editor.editor>) {
    if (!ai.ensureConfigured()) return;
    openAiBlock(e, {
      noteWords: () => countWords(readMarkdown(e)),
      start: (instruction, withNote, onText) => {
        const messages = instructionMessages(instruction, withNote ? readMarkdown(e) : null);
        const tokens = messagesTokens(messages);
        const budget = ai.defaultBudget();
        if (tokens > budget) throw new Error(`${tooLongMessage(tokens, budget)}${withNote ? "，可以取消“附带当前笔记”后再试" : ""}`);
        return ai.run(messages, onText);
      },
      undoKey: () => displayShortcut(shortcutOf("edit.undo")),
      isCancel: (err) => err instanceof AiCancelled,
    });
  }

  const formatCommands: AppCommand[] = Object.values(FORMAT_ACTIONS)
    .filter((a) => !a.command && a.run)
    .map((a) => ({
      id: `format.${a.id}`,
      title: a.title,
      category: INSERT_ACTIONS.has(a.id) ? "插入" : "格式",
      scope: "editor" as const,
      defaultShortcut: a.shortcut,
      run: onEditor((e) => a.run!(e)),
      enabled: hasEditor,
    }));

  const headingCommands: AppCommand[] = HEADING_LABELS.map((label, level) => ({
    id: `format.h${level}`,
    title: level === 0 ? "转为正文" : `转为${label}`,
    category: "格式",
    scope: "editor" as const,
    defaultShortcut: HEADING_SHORTCUTS[level],
    run: onEditor((e) => setBlockLevel(e, level)),
    enabled: hasEditor,
  }));

  registerCommands([
    // 文件
    { id: "file.newNote", title: "新建笔记", category: "文件", defaultShortcut: "Ctrl+N", run: () => vault.newNote(), enabled: hasVault },
    { id: "file.newFolder", title: "新建文件夹", category: "文件", defaultShortcut: "Ctrl+Shift+N", run: () => vault.newFolder(), enabled: hasVault },
    { id: "file.openVault", title: "打开笔记库", category: "文件", defaultShortcut: null, run: () => vault.pickAndOpen() },
    { id: "file.save", title: "立即保存", category: "文件", defaultShortcut: "Ctrl+S", run: () => tabs.saveActive() },
    { id: "file.switchVault", title: "切换笔记库", category: "文件", defaultShortcut: null, run: () => (ui.vaultOpen = true) },
    {
      id: "file.exportVault",
      title: "导出笔记库",
      category: "文件",
      defaultShortcut: null,
      enabled: hasVault,
      run: async () => {
        if (!vault.root) return;
        const dest = await save({ title: "导出笔记库", defaultPath: `${vault.name}.zip`, filters: [{ name: "zip", extensions: ["zip"] }] });
        if (!dest) return;
        const n = await api.exportZip(vault.root, dest);
        useNoticeStore().inform(`已导出 ${n} 个文件`);
      },
    },
    {
      id: "file.importVault",
      title: "导入笔记库",
      category: "文件",
      defaultShortcut: null,
      run: async () => {
        const zip = await open({ title: "选择笔记库 zip", multiple: false, filters: [{ name: "zip", extensions: ["zip"] }] });
        if (typeof zip !== "string") return;
        const parent = await open({ title: "选择导入到的位置", directory: true });
        if (typeof parent !== "string") return;
        const base = zip.split(/[\\/]/).pop()?.replace(/\.zip$/i, "") || "导入的笔记库";
        const sep = parent.includes("\\") ? "\\" : "/";
        const dest = `${parent.replace(/[\\/]+$/, "")}${sep}${base}`;
        const n = await api.importZip(zip, dest);
        useNoticeStore().inform(`已导入 ${n} 个文件`);
        await vault.openVault(dest);
      },
    },
    { id: "file.history", title: "历史版本", category: "文件", defaultShortcut: null, run: () => (ui.historyOpen = true), enabled: () => !!tabs.activePath },
    { id: "file.trash", title: "回收站", category: "文件", defaultShortcut: null, run: () => (ui.trashOpen = true), enabled: hasVault },
    { id: "app.settings", title: "设置", category: "通用", defaultShortcut: "Ctrl+,", run: () => { ui.settingsSection = "general"; ui.settingsOpen = true; } },
    { id: "file.quit", title: "退出", category: "文件", defaultShortcut: null, run: () => getCurrentWindow().close() },
    // 编辑
    { id: "edit.undo", title: "撤销", category: "编辑", scope: "editor", defaultShortcut: "Ctrl+Z", run: onEditor((e) => FORMAT_ACTIONS.undo.run!(e)), enabled: hasEditor },
    { id: "edit.redo", title: "重做", category: "编辑", scope: "editor", defaultShortcut: "Ctrl+Y", run: onEditor((e) => FORMAT_ACTIONS.redo.run!(e)), enabled: hasEditor },
    { id: "edit.cut", title: "剪切", category: "编辑", defaultShortcut: null, run: () => document.execCommand("cut"), enabled: hasEditor, hidden: true },
    { id: "edit.copy", title: "复制", category: "编辑", defaultShortcut: null, run: () => document.execCommand("copy"), enabled: hasEditor, hidden: true },
    { id: "edit.paste", title: "粘贴", category: "编辑", defaultShortcut: null, run: () => navigator.clipboard.readText().then((t) => document.execCommand("insertText", false, t)), enabled: hasEditor, hidden: true },
    {
      id: "edit.find",
      title: "查找",
      category: "编辑",
      defaultShortcut: "Ctrl+F",
      run: onEditor((e) => ui.openFind(false, selectionText(e))),
      enabled: hasEditor,
    },
    {
      id: "edit.replace",
      title: "替换",
      category: "编辑",
      defaultShortcut: "Ctrl+H",
      run: onEditor((e) => ui.openFind(true, selectionText(e))),
      enabled: hasEditor,
    },
    // 格式与插入
    ...headingCommands,
    ...formatCommands,
    { id: "format.tidy", title: "一键整理", category: "格式", scope: "editor", defaultShortcut: "Ctrl+Shift+L", run: onEditor(tidyNote), enabled: hasEditor },
    // AI
    { id: "ai.instruction", title: "AI 指令", category: "AI", scope: "editor", defaultShortcut: null, run: onEditor(openInstruction), enabled: hasEditor },
    {
      id: "ai.chat",
      title: "打开 AI 对话",
      category: "AI",
      defaultShortcut: null,
      run: () => {
        if (!ai.ensureConfigured()) return;
        ui.openChat();
        return useChatStore().ensureOpen();
      },
    },
    { id: "ai.summary", title: "总结当前笔记", category: "AI", defaultShortcut: null, run: () => ai.ensureConfigured() && (ai.summaryOpen = true), enabled: hasEditor },
    { id: "ai.structure", title: "AI 整理结构", category: "AI", defaultShortcut: null, run: () => ai.ensureConfigured() && (ai.structureOpen = true), enabled: hasEditor },
    { id: "insert.link", title: "插入链接", category: "插入", scope: "editor", defaultShortcut: "Ctrl+K", run: () => (ui.linkOpen = true), enabled: hasEditor },
    { id: "insert.image", title: "插入图片", category: "插入", defaultShortcut: "Ctrl+Shift+I", run: insertImageFromDialog, enabled: hasEditor },
    // 视图
    { id: "view.toggleSidebar", title: "显示/隐藏侧栏", category: "视图", defaultShortcut: "Ctrl+Shift+B", run: () => settings.toggleSidebar() },
    { id: "view.toggleToolbar", title: "显示/隐藏格式工具栏", category: "视图", defaultShortcut: null, run: () => settings.toggleToolbar() },
    { id: "view.toggleStatusbar", title: "显示/隐藏状态栏", category: "视图", defaultShortcut: null, run: () => settings.toggleStatusbar() },
    { id: "view.toggleNight", title: "切换深浅主题", category: "视图", defaultShortcut: null, run: () => settings.toggleDarkTheme() },
    ...THEMES.map((t) => ({
      id: themeCommandId(t.id), title: `主题：${t.name}`, category: "视图", defaultShortcut: null, run: () => settings.setTheme(t.id),
    })),
    // 标签页与导航
    {
      id: "tab.close",
      title: "关闭标签页",
      category: "标签页",
      defaultShortcut: "Ctrl+W",
      run: () => (ui.mainView === "chat" ? ui.closeChat() : tabs.activePath && tabs.close(tabs.activePath)),
      enabled: () => !!tabs.activePath || ui.mainView === "chat",
    },
    { id: "tab.next", title: "下一个标签页", category: "标签页", defaultShortcut: "Ctrl+Tab", run: () => tabs.cycle(1) },
    { id: "tab.prev", title: "上一个标签页", category: "标签页", defaultShortcut: "Ctrl+Shift+Tab", run: () => tabs.cycle(-1) },
    { id: "nav.back", title: "后退", category: "导航", defaultShortcut: "Alt+←", run: () => tabs.back(), enabled: () => tabs.canBack },
    { id: "nav.forward", title: "前进", category: "导航", defaultShortcut: "Alt+→", run: () => tabs.forward(), enabled: () => tabs.canForward },
    { id: "palette.files", title: "快速打开", category: "导航", defaultShortcut: "Ctrl+P", run: () => (ui.palette = "files"), enabled: hasVault },
    { id: "palette.commands", title: "命令面板", category: "导航", defaultShortcut: "Ctrl+Shift+P", run: () => (ui.palette = "commands") },
    // 搜索
    {
      id: "search.focus",
      title: "全文搜索",
      category: "搜索",
      defaultShortcut: "Ctrl+Shift+F",
      run: () => {
        if (!settings.sidebarVisible) settings.toggleSidebar();
        ui.search();
      },
      enabled: hasVault,
    },
    // 帮助
    { id: "git.settings", title: "Git 设置", category: "版本控制", defaultShortcut: null, run: () => git.openSettings(), enabled: hasVault },
    {
      id: "sync.now",
      title: "立即同步",
      category: "版本控制",
      defaultShortcut: null,
      enabled: hasVault,
      run: () => {
        if (webdav.mode === "webdav") return webdav.start("download");
        if (webdav.mode === "git" || (!webdav.configured && git.isRepo)) return git.syncFromTitle();
        ui.settingsSection = "sync";
        ui.settingsOpen = true;
      },
    },
    {
      id: "sync.upload",
      title: "上传本地改动到云端（WebDAV）",
      category: "版本控制",
      defaultShortcut: null,
      enabled: () => hasVault() && webdav.mode === "webdav",
      run: () => webdav.start("upload"),
    },
    { id: "git.sync", title: "一键同步", category: "版本控制", defaultShortcut: null, run: () => git.syncFromTitle(), enabled: hasVault },
    { id: "help.guide", title: "操作指南", category: "帮助", defaultShortcut: null, run: () => (ui.guideOpen = true) },
    { id: "help.shortcuts", title: "快捷键设置", category: "帮助", defaultShortcut: null, run: () => { ui.settingsSection = "keys"; ui.settingsOpen = true; } },
    {
      id: "help.about",
      title: "关于",
      category: "帮助",
      defaultShortcut: null,
      run: async () => message(`Spark ${await getVersion()}`, { title: "关于 Spark", kind: "info" }),
    },
  ]);
}
