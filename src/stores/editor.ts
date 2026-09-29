import { defineStore } from "pinia";
import { computed, markRaw, ref, shallowRef } from "vue";
import type { Editor } from "@milkdown/kit/core";
import { currentHeadingIndex, type Heading } from "../editor/navigate";

export interface ActiveMarks {
  strong: boolean;
  emphasis: boolean;
  strike: boolean;
  code: boolean;
  highlight: boolean;
  link: boolean;
}

/** 当前正在编辑的笔记的编辑器实例与光标状态，供工具栏和状态栏使用 */
export const useEditorStore = defineStore("editor", () => {
  const editor = shallowRef<Editor | null>(null);
  const path = ref<string | null>(null);
  const block = ref("正文");
  const marks = ref<ActiveMarks>({ strong: false, emphasis: false, strike: false, code: false, highlight: false, link: false });
  const line = ref(1);
  const col = ref(1);
  const words = ref(0);
  /** 文档每次变化加一，查找栏据此重新计算命中 */
  const docVersion = ref(0);
  const headings = shallowRef<Heading[]>([]);
  /** 光标位置（文档坐标），用于大纲高亮当前章节 */
  const cursor = ref(0);
  const currentHeading = computed(() => currentHeadingIndex(headings.value, cursor.value));
  /** 立即把编辑器里的最新内容同步到标签页（跳过监听器的防抖） */
  let pullFn: (() => void) | null = null;

  function attach(e: Editor, notePath: string, pull: () => void) {
    editor.value = markRaw(e);
    path.value = notePath;
    pullFn = pull;
  }

  function detach(e: Editor) {
    if (editor.value !== e) return;
    editor.value = null;
    path.value = null;
    pullFn = null;
    words.value = 0;
    line.value = 1;
    col.value = 1;
    block.value = "正文";
    headings.value = [];
    cursor.value = 0;
  }

  function pull(notePath?: string) {
    if (pullFn && (notePath === undefined || notePath === path.value)) pullFn();
  }

  return { editor, path, block, marks, line, col, words, docVersion, headings, cursor, currentHeading, attach, detach, pull };
});
