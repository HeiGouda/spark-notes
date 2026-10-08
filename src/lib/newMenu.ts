import type { MenuEntry } from "../components/MenuList.vue";
import { shortcutOf } from "./commands";
import { displayShortcut } from "./shortcut";
import { useVaultStore } from "../stores/vault";
import { useFlowGenStore } from "../stores/flowGen";
import { useMindGenStore } from "../stores/mindGen";

/** 文件树“新建”下拉菜单与右键菜单共用；dir 省略时按选中项决定位置 */
export function newItems(dir?: string): MenuEntry[] {
  const vault = useVaultStore();
  const hint = (id: string) => displayShortcut(shortcutOf(id));
  return [
    { kind: "item", label: "新建笔记", hint: hint("file.newNote"), action: () => vault.newNote(dir) },
    { kind: "item", label: "新建思维导图", hint: hint("file.newMind"), action: () => vault.newDoc("mind", dir) },
    { kind: "item", label: "新建流程图", hint: hint("file.newFlow"), action: () => vault.newDoc("flow", dir) },
    { kind: "item", label: "新建表格簿", hint: hint("file.newBook"), action: () => vault.newBook(dir) },
    { kind: "item", label: "AI 生成流程图…", action: () => useFlowGenStore().openDialog({ kind: "folder", folder: dir ?? vault.targetDir() }) },
    { kind: "item", label: "AI 生成思维导图…", action: () => useMindGenStore().openDialog({ kind: "folder", folder: dir ?? vault.targetDir() }) },
    { kind: "item", label: "新建文件夹", hint: hint("file.newFolder"), action: () => vault.newFolder(dir) },
  ];
}
