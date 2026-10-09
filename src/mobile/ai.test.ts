// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AiModelEntry } from "../lib/aiModels";
import { useMobileAi } from "./ai";
import { useMobileChat } from "./chat";

const saved = new Map<string, unknown>();
const calls: string[] = [];
const chats = new Map<string, string>();

const entry = (over: Partial<AiModelEntry> = {}): AiModelEntry => ({
  id: "m1",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  name: "claude-sonnet-5-5",
  label: "Claude Sonnet 5.5",
  context: null,
  providerContext: null,
  ...over,
});

beforeEach(() => {
  saved.clear();
  calls.length = 0;
  chats.clear();
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd === "plugin:store|load") return { rid: 1 };
      if (cmd === "plugin:store|get") {
        const value = saved.get(String(args?.key));
        return value === undefined ? [null, false] : [value, true];
      }
      if (cmd === "plugin:store|set") {
        const key = String(args?.key ?? "");
        saved.set(key, args?.value);
        return null;
      }
      if (cmd === "plugin:store|save") return null;
      if (cmd === "chat_list") {
        return [...chats.entries()].map(([id, json]) => {
          const v = JSON.parse(json) as { title?: string; updatedAt?: number };
          return { id, title: v.title ?? "新对话", updatedAt: v.updatedAt ?? 0 };
        });
      }
      if (cmd === "chat_read") {
        const json = chats.get(String(args?.id));
        if (!json) throw new Error("读取会话失败：找不到");
        return json;
      }
      if (cmd === "chat_write") {
        chats.set(String(args?.id), String(args?.json));
        return null;
      }
      if (cmd === "ai_chat") throw new Error("测试环境没有 AI 服务");
      if (cmd === "ai_cancel") return null;
      if (cmd === "chat_delete") {
        chats.delete(String(args?.id));
        return null;
      }
      throw new Error(`测试里没有这个调用：${cmd}`);
    },
    transformCallback: () => 0,
  };
  setActivePinia(createPinia());
});

describe("手机 AI 模型", () => {
  it("还没有模型时，默认模型为空", async () => {
    const ai = useMobileAi();
    await ai.init();
    expect(ai.models).toEqual([]);
    expect(ai.defaultModel).toBeNull();
    expect(ai.configured).toBe(false);
  });

  it("添加第一个模型后它成为默认模型，并写进配置", async () => {
    const ai = useMobileAi();
    await ai.init();
    ai.upsert(entry());
    await vi.waitFor(() => expect(calls).toContain("plugin:store|set"));
    expect(ai.defaultModel?.id).toBe("m1");
    expect(saved.get("aiDefaultModel")).toBe("m1");
  });

  it("删掉默认模型后，改用列表里的第一个", async () => {
    saved.set("aiModels", [entry(), entry({ id: "m2", name: "deepseek-v4-pro", label: "DeepSeek V4 Pro" })]);
    saved.set("aiDefaultModel", "m1");
    const ai = useMobileAi();
    await ai.init();
    ai.remove("m1");
    expect(ai.models.map((m) => m.id)).toEqual(["m2"]);
    expect(ai.defaultModel?.id).toBe("m2");
  });

  it("默认模型的 id 在列表里找不到时，用第一个", async () => {
    saved.set("aiModels", [entry()]);
    saved.set("aiDefaultModel", "不存在");
    const ai = useMobileAi();
    await ai.init();
    expect(ai.defaultModel?.id).toBe("m1");
  });

  it("损坏的模型条目会被丢掉", async () => {
    saved.set("aiModels", [entry(), { id: "坏的" }, null, entry({ id: "m2", name: "" })]);
    const ai = useMobileAi();
    await ai.init();
    expect(ai.models.map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("手机 AI 会话", () => {
  async function chat() {
    const ai = useMobileAi();
    await ai.init();
    ai.upsert(entry());
    const c = useMobileChat();
    await c.openLatest();
    return c;
  }

  it("第一次打开是一个没保存的新对话", async () => {
    const c = await chat();
    expect(c.current?.title).toBe("新对话");
    expect(c.current?.messages).toEqual([]);
    expect(c.saved).toBe(false);
    expect(chats.size).toBe(0);
  });

  it("发送第一条消息后按内容命名，并写到会话文件", async () => {
    const c = await chat();
    c.draft = "八卦为什么能促进大规模协作？";
    await c.send();
    await vi.waitFor(() => expect(chats.size).toBe(1));
    expect(c.current?.title).toBe("八卦为什么能促进大规模协作？");
    expect(c.current?.messages[0]?.role).toBe("user");
    expect(c.current?.messages[0]?.content).toBe("八卦为什么能促进大规模协作？");
    expect(chats.size).toBe(1);
    expect(JSON.parse([...chats.values()][0]).title).toBe("八卦为什么能促进大规模协作？");
  });

  it("问 AI 会新建一个对话，并把选中的文字作为引用填进输入框", async () => {
    const c = await chat();
    c.draft = "先写了一半";
    c.ask("我们的语言发展成为一种八卦的工具");
    expect(c.current?.messages).toEqual([]);
    expect(c.saved).toBe(false);
    expect(c.draft).toBe("> 我们的语言发展成为一种八卦的工具\n\n");
  });

  it("删除会话后，列表里不再有它", async () => {
    const c = await chat();
    c.draft = "第一条";
    await c.send();
    await vi.waitFor(() => expect(chats.size).toBe(1));
    const id = c.current?.id ?? "";
    await c.remove(id);
    expect(chats.has(id)).toBe(false);
    expect(c.current?.id).not.toBe(id);
  });

  it("重命名只改标题，消息不变", async () => {
    const c = await chat();
    c.draft = "原来的标题";
    await c.send();
    await vi.waitFor(() => expect(chats.size).toBe(1));
    const id = c.current?.id ?? "";
    await c.rename(id, "语言与协作");
    expect(c.current?.title).toBe("语言与协作");
    expect(c.current?.messages[0]?.content).toBe("原来的标题");
  });
});

declare global {
  interface Window {
    __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>; transformCallback: () => number };
  }
}
