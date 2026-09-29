import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { ChatMessage } from "../lib/api";

const saved = new Map<string, string>();
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: {
    chatList: vi.fn(async () => []),
    chatRead: vi.fn(async (id: string) => saved.get(id)!),
    chatWrite: vi.fn(async (id: string, json: string) => void saved.set(id, json)),
    chatDelete: vi.fn(async (id: string) => void saved.delete(id)),
    chatDeleteImage: vi.fn(async () => {}),
    chatImageData: vi.fn(async () => "data:image/png;base64,AQID"),
    chatSaveImage: vi.fn(async () => "1-0.png"),
  },
}));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

/** 可控的假 AI：记录每次请求，手动推送文字、结束或失败 */
interface FakeCall {
  messages: ChatMessage[];
  model: string;
  push: (t: string) => void;
  finish: () => void;
  fail: (e: Error) => void;
  cancelled: boolean;
}
const calls: FakeCall[] = [];
vi.mock("./ai", () => {
  class AiCancelled extends Error {}
  const fake = {
    ensureConfigured: () => true,
    run(messages: ChatMessage[], onText: (full: string) => void, model: string) {
      let text = "";
      let resolve!: (t: string) => void;
      let reject!: (e: unknown) => void;
      const done = new Promise<string>((res, rej) => ((resolve = res), (reject = rej)));
      const call: FakeCall = {
        messages, model, cancelled: false,
        push: (t) => onText((text += t)),
        finish: () => resolve(text),
        fail: (e) => reject(e),
      };
      calls.push(call);
      return { done, cancel: () => ((call.cancelled = true), reject(new AiCancelled())) };
    },
  };
  return { AiCancelled, useAiStore: () => fake };
});

const { useChatStore } = await import("./chat");
const { useSettingsStore } = await import("./settings");

const flush = () => new Promise((r) => setTimeout(r, 0));

async function sendAndReply(chat: ReturnType<typeof useChatStore>, text: string, reply: string) {
  chat.draft = text;
  const sending = chat.send();
  await flush();
  const call = calls[calls.length - 1];
  call.push(reply);
  call.finish();
  await sending;
  return call;
}

describe("AI 对话", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    saved.clear();
    calls.length = 0;
    useSettingsStore().aiModels = [{ name: "qwen-plus", context: 1_000_000 }, { name: "small", context: 400 }];
  });

  it("发送后自动命名、存盘，回复逐字写入并随会话保存", async () => {
    const chat = useChatStore();
    await chat.newChat();
    chat.draft = "帮我写一段冲突处理的说明";
    const sending = chat.send();
    await flush();
    expect(chat.running).toBe(true);
    expect(calls[0].model).toBe("qwen-plus");
    expect(calls[0].messages.map((m) => m.role)).toEqual(["system", "user"]);
    calls[0].push("冲突时");
    expect(chat.current!.messages[1].content).toBe("冲突时");
    calls[0].push("两份都保留");
    calls[0].finish();
    await sending;
    expect(chat.running).toBe(false);
    expect(chat.current!.title).toBe("帮我写一段冲突处理的说明");
    const stored = JSON.parse(saved.get(chat.current!.id)!);
    expect(stored.messages.map((m: { content: string }) => m.content)).toEqual(["帮我写一段冲突处理的说明", "冲突时两份都保留"]);
    expect(chat.list[0].title).toBe("帮我写一段冲突处理的说明");
  });

  it("每个会话只带自己的消息；上下文不够时只发送最近的消息", async () => {
    const chat = useChatStore();
    await chat.newChat();
    await sendAndReply(chat, "第一问".repeat(120), "第一答".repeat(120));
    await sendAndReply(chat, "第二问", "第二答");
    const firstId = chat.current!.id;

    await chat.newChat();
    const call = await sendAndReply(chat, "新会话的问题", "好");
    expect(call.messages.map((m) => m.content)).toEqual([expect.any(String), "新会话的问题"]);

    await chat.open(firstId);
    chat.setModel("small");
    const tight = await sendAndReply(chat, "第三问", "第三答");
    expect(tight.model).toBe("small");
    const contents = tight.messages.slice(1).map((m) => m.content as string);
    expect(contents).toEqual(["第二问", "第二答", "第三问"]);
    expect(chat.plan.omitted).toBeGreaterThan(0);
  });

  it("带图片的请求失败时提示可能是模型不支持图片；失败的回复不再发送", async () => {
    const chat = useChatStore();
    await chat.newChat();
    await chat.addFiles([new File([new Uint8Array([1, 2, 3])], "截图.png", { type: "image/png" })]);
    expect(chat.pending).toHaveLength(1);
    chat.draft = "这张图是什么";
    const sending = chat.send();
    await flush();
    const content = calls[0].messages[1].content as { type: string }[];
    expect(content.map((p) => p.type)).toEqual(["text", "image_url"]);
    calls[0].fail(new Error("请求失败（HTTP 400）"));
    await sending;
    expect(chat.current!.messages[1].error).toContain("当前模型可能不支持图片");

    const next = await sendAndReply(chat, "换个问题", "好的");
    expect(next.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
  });

  it("停止后保留已收到的内容；重新生成替换最后一条回复", async () => {
    const chat = useChatStore();
    await chat.newChat();
    chat.draft = "写个提纲";
    const sending = chat.send();
    await flush();
    calls[0].push("一、背景");
    chat.stop();
    await sending;
    expect(calls[0].cancelled).toBe(true);
    expect(chat.current!.messages[1].content).toBe("一、背景");

    const again = chat.regenerate();
    await flush();
    expect(calls[1].messages.map((m) => m.role)).toEqual(["system", "user"]);
    calls[1].push("一、目标");
    calls[1].finish();
    await again;
    expect(chat.current!.messages.map((m) => m.content)).toEqual(["写个提纲", "一、目标"]);
  });

  it("同名图片按会话分开，只在内存里留当前会话的；移除未发送的图片会删除文件", async () => {
    const { api } = await import("../lib/api");
    const chat = useChatStore();
    await chat.newChat();
    await chat.addFiles([new File([new Uint8Array([1])], "a.png", { type: "image/png" })]);
    const id1 = chat.current!.id;
    await sendAndReply(chat, "看图", "好");
    expect(chat.images.get(`${id1}/1-0.png`)).toBe("data:image/png;base64,AQID");

    await chat.newChat();
    await chat.addFiles([new File([new Uint8Array([2])], "a.png", { type: "image/png" })]);
    const id2 = chat.current!.id;
    expect(chat.images.has(`${id1}/1-0.png`)).toBe(false);
    expect(chat.images.has(`${id2}/1-0.png`)).toBe(true);
    await chat.removePending(chat.pending[0].key);
    expect(api.chatDeleteImage).toHaveBeenCalledWith(id2, "1-0.png");
    expect(chat.images.has(`${id2}/1-0.png`)).toBe(false);

    await chat.open(id1);
    expect(api.chatDelete).toHaveBeenCalledWith(id2);
    await flush();
    expect(chat.images.get(`${id1}/1-0.png`)).toBe("data:image/png;base64,AQID");
  });
});
