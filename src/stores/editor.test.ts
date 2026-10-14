import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useEditorStore } from "./editor";

describe("editor store 按路径收回正文", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("当前编辑器切走后，保存仍能拿到那一篇里还没同步的内容", () => {
    const store = useEditorStore();
    const calls: string[] = [];
    const flushA = () => calls.push("a");
    const flushB = () => calls.push("b");
    const open = {} as never;
    store.bind("a.md", flushA);
    store.bind("b.md", flushB);
    store.attach(open, "a.md", flushA);
    store.detach(open);
    store.pull("b.md");
    store.pull("a.md");
    expect(calls).toEqual(["b", "a"]);
    store.unbind("b.md", flushB);
    store.pull("b.md");
    expect(calls).toEqual(["b", "a"]);
  });
});
