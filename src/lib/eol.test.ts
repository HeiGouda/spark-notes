import { describe, expect, it } from "vitest";
import { applyEol, detectEol, toLf } from "./eol";

describe("eol", () => {
  it("识别换行符", () => {
    expect(detectEol("a\r\nb\n")).toBe("\r\n");
    expect(detectEol("a\nb\r\n")).toBe("\n");
    expect(detectEol("")).toBe("\n");
  });

  it("CRLF 文件往返不变", () => {
    const src = "---\r\na: 1\r\n---\r\n\r\n正文\r\n";
    expect(applyEol(toLf(src), detectEol(src))).toBe(src);
  });

  it("LF 文件保持 LF", () => {
    expect(applyEol("a\r\nb\n", "\n")).toBe("a\nb\n");
  });
});
