import { describe, expect, it } from "vitest";
import { countWords } from "./wordcount";

describe("countWords", () => {
  it("中文按字计数", () => expect(countWords("多台电脑")).toBe(4));
  it("英文按词计数", () => expect(countWords("hello world, it's fine")).toBe(4));
  it("中英混排", () => expect(countWords("服务器用 WebDAV 协议")).toBe(7));
  it("标点和空白不计", () => expect(countWords("，。！  \n")).toBe(0));
});
