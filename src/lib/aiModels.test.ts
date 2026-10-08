import { describe, expect, it } from "vitest";
import { builtinContext, estimateTokens, formatTokens, normalizeModels, resolveContext, sendBudget, type AiModelEntry } from "./aiModels";

describe("模型上下文长度", () => {
  it("优先级：手动填写 > 服务商返回 > 内置表 > 128K", () => {
    expect(resolveContext({ name: "qwen-plus", context: 50_000, providerContext: 1_000_000 })).toEqual({ tokens: 50_000, source: "manual" });
    expect(resolveContext({ name: "qwen-plus", context: null, providerContext: 1_000_000 })).toEqual({ tokens: 1_000_000, source: "provider" });
    expect(resolveContext({ name: "qwen-max", context: null, providerContext: null })).toEqual({ tokens: 32_768, source: "builtin" });
    expect(resolveContext({ name: "my-finetune", context: null, providerContext: null })).toEqual({ tokens: 128_000, source: "default" });
  });

  it("内置表支持厂商前缀和 -32k 之类的后缀，并认得当前主力模型", () => {
    expect(builtinContext("qwen/qwen-long")).toBe(10_000_000);
    expect(builtinContext("moonshot-v1-8k")).toBe(8_192);
    expect(builtinContext("some-model-32k")).toBe(32_768);
    expect(builtinContext("unknown")).toBeNull();
    expect(builtinContext("qwen3.8-max")).toBe(1_000_000);
    expect(builtinContext("kimi-k3")).toBe(1_000_000);
    expect(builtinContext("kimi-k2.6")).toBe(262_144);
    expect(builtinContext("glm-5.3")).toBe(1_000_000);
    expect(builtinContext("MiniMax-M3")).toBe(1_000_000);
    expect(builtinContext("deepseek-v4-pro")).toBe(128_000);
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
  const strip = (list: AiModelEntry[]) => list.map(({ id: _id, ...rest }) => rest);

  it("迁移更早版本的单个模型名：用旧的接口地址，认出服务商", () => {
    const r = normalizeModels(undefined, { baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.6" });
    expect(r.migrated).toBe(true);
    expect(r.legacyBaseUrl).toBe("https://api.moonshot.cn/v1");
    expect(strip(r.models)).toEqual([{ provider: "kimi", baseUrl: "https://api.moonshot.cn/v1", name: "kimi-k2.6", label: "", context: null, providerContext: null }]);
  });

  it("迁移旧的模型列表：服务商返回的上下文按模型名并入，去掉空名与重复", () => {
    const r = normalizeModels([{ name: " a ", context: "8192" }, { name: "a" }, { name: "" }, { name: "b", context: -1 }], {
      baseUrl: "https://example.com/v1",
      providerContexts: { b: 32768 },
    });
    expect(r.migrated).toBe(true);
    expect(strip(r.models)).toEqual([
      { provider: "custom", baseUrl: "https://example.com/v1", name: "a", label: "", context: 8192, providerContext: null },
      { provider: "custom", baseUrl: "https://example.com/v1", name: "b", label: "", context: null, providerContext: 32768 },
    ]);
  });

  it("新格式原样读取；不同接口地址下的同名模型都保留", () => {
    const saved = [
      { id: "x", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", name: "deepseek-v4-pro", label: "DeepSeek V4 Pro", context: null, providerContext: null },
      { id: "y", provider: "custom", baseUrl: "https://proxy.example.com/v1", name: "deepseek-v4-pro", label: "", context: 64000, providerContext: null },
    ];
    const r = normalizeModels(saved, { baseUrl: "https://api.deepseek.com/v1" });
    expect(r.migrated).toBe(false);
    expect(r.legacyBaseUrl).toBeNull();
    expect(r.models).toEqual(saved);
  });
});
