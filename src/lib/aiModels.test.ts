import { describe, expect, it } from "vitest";
import { builtinContext, estimateTokens, formatTokens, normalizeModels, resolveContext, sendBudget } from "./aiModels";

describe("模型上下文长度", () => {
  it("优先级：手动填写 > 服务商返回 > 内置表 > 128K", () => {
    const provider = { "qwen-plus": 1_000_000 };
    expect(resolveContext({ name: "qwen-plus", context: 50_000 }, provider)).toEqual({ tokens: 50_000, source: "manual" });
    expect(resolveContext({ name: "qwen-plus", context: null }, provider)).toEqual({ tokens: 1_000_000, source: "provider" });
    expect(resolveContext({ name: "qwen-max", context: null }, provider)).toEqual({ tokens: 32_768, source: "builtin" });
    expect(resolveContext({ name: "my-finetune", context: null }, {})).toEqual({ tokens: 128_000, source: "default" });
  });

  it("内置表支持厂商前缀和 -32k 之类的后缀", () => {
    expect(builtinContext("qwen/qwen-long")).toBe(10_000_000);
    expect(builtinContext("moonshot-v1-8k")).toBe(8_192);
    expect(builtinContext("some-model-32k")).toBe(32_768);
    expect(builtinContext("unknown")).toBeNull();
  });

  it("给回复预留 8K 与 10% 中较小的一个", () => {
    expect(sendBudget(1_000_000)).toBe(1_000_000 - 8192);
    expect(sendBudget(32_768)).toBe(32_768 - 3276);
  });
});

describe("token 估算与显示", () => {
  it("中文约 1 字 1 token，其他约 4 个字符 1 token", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("hello world!")).toBe(3);
    expect(estimateTokens("")).toBe(0);
  });

  it("以 K、M 显示", () => {
    expect(formatTokens(12_345)).toBe("12.3K");
    expect(formatTokens(131_072)).toBe("131K");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(512)).toBe("512");
  });
});

describe("读取模型列表设置", () => {
  it("迁移旧版本的单个模型名，去掉空名与重复", () => {
    expect(normalizeModels(undefined, "deepseek-chat")).toEqual([{ name: "deepseek-chat", context: null }]);
    expect(normalizeModels([{ name: " a ", context: "8192" }, { name: "a" }, { name: "" }, { name: "b", context: -1 }])).toEqual([
      { name: "a", context: 8192 },
      { name: "b", context: null },
    ]);
  });
});
