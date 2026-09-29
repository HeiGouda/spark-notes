// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@milkdown/kit/core";
import { createEditor } from "./createEditor";
import { externalUrl } from "./link";

let editor: Editor | null = null;

afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

describe("externalUrl", () => {
  it("补全没写协议的网址，笔记路径不当成网址", () => {
    expect(externalUrl("https://baidu.com/a")).toBe("https://baidu.com/a");
    expect(externalUrl("www.baidu.com")).toBe("https://www.baidu.com");
    expect(externalUrl("baidu.com/s?wd=1")).toBe("https://baidu.com/s?wd=1");
    expect(externalUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(externalUrl("第一讲.md")).toBeNull();
    expect(externalUrl("readme.md")).toBeNull();
    expect(externalUrl("工作/周报")).toBeNull();
  });
});

describe("点击链接", () => {
  it("点击网址时阻止页面自己跳转，并把地址交出去", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const opened: string[] = [];
    editor = await createEditor({
      root,
      markdown: "[官网](www.baidu.com)\n",
      onChange: () => {},
      onCursor: () => {},
      onWords: () => {},
      onError: () => {},
      onOpenLink: (href) => opened.push(href),
    });
    const a = root.querySelector("a")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(opened).toEqual(["www.baidu.com"]);
  });
});
