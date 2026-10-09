import { describe, expect, it } from "vitest";
import { zhError } from "./errors";

describe("报错换成中文", () => {
  it("文件系统的英文报错", () => {
    expect(zhError("读取书籍失败：No such file or directory (os error 2)")).toBe("读取书籍失败：找不到文件");
    expect(zhError("保存失败 /a：No space left on device (os error 28)")).toBe("保存失败 /a：手机存储空间不足");
  });

  it("网络的英文报错", () => {
    expect(zhError("下载失败：timed out reading response")).toBe("下载失败：网络超时，请稍后再试");
    expect(zhError("Failed to fetch")).toBe("网络请求失败");
    expect(zhError("读取远端目录失败：dns error: failed to lookup address information")).toBe("读取远端目录失败：找不到服务器，请检查网址和网络");
  });

  it("本来就是中文的原样保留", () => {
    expect(zhError("先选择读书笔记库")).toBe("先选择读书笔记库");
  });
});
