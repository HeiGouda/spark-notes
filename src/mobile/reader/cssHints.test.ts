// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { hintOf, parseCss, sizeOf, styleResolver } from "./cssHints";

describe("从书的样式表读版式", () => {
  it("字号换成相对正文的倍数", () => {
    expect(sizeOf("1.25em")).toBe(1.25);
    expect(sizeOf("150%")).toBe(1.5);
    expect(sizeOf("x-large")).toBe(1.5);
    expect(sizeOf("24px")).toBe(1.5);
    expect(sizeOf("auto")).toBeUndefined();
  });

  it("只留对齐、字号和粗细", () => {
    expect(hintOf("color: red; text-align: center !important; font-weight: 700")).toEqual({ align: "center", bold: true });
    expect(hintOf("margin: 0")).toBeNull();
  });

  it("跳过 @font-face、@media 和伪元素", () => {
    const rules = parseCss(`/* 注释 */ @font-face { font-family: x; src: url(a.ttf) }
      @media screen { .a { text-align: center } }
      h1, .t::before { font-size: 2em }
      .b { text-align: right }`);
    expect(rules.map((r) => r.selector)).toEqual(["h1", ".b"]);
  });

  it("特异度高的规则后套，行内 style 最后", () => {
    document.body.innerHTML = '<p id="x" class="c">甲</p><p class="c" style="text-align: left">乙</p>';
    const styleOf = styleResolver(["#x { text-align: right } .c { text-align: center; font-size: 1.2em }"]);
    const [a, b] = Array.from(document.querySelectorAll("p"));
    expect(styleOf(a!)).toEqual({ align: "right", size: 1.2 });
    expect(styleOf(b!)).toEqual({ align: "left", size: 1.2 });
  });
});
