import { describe, expect, it } from "vitest";
import { formatGitWhen } from "./gitTime";

describe("提交时间", () => {
  const now = new Date(2026, 8, 28, 16, 40, 0);

  it("今天、昨天和更早的日期", () => {
    expect(formatGitWhen(Math.floor(new Date(2026, 8, 28, 16, 40).getTime() / 1000), now)).toBe("今天 16:40");
    expect(formatGitWhen(Math.floor(new Date(2026, 8, 27, 21, 18).getTime() / 1000), now)).toBe("昨天 21:18");
    expect(formatGitWhen(Math.floor(new Date(2026, 8, 20, 9, 0).getTime() / 1000), now)).toBe("9月20日");
    expect(formatGitWhen(Math.floor(new Date(2025, 11, 1, 9, 0).getTime() / 1000), now)).toBe("2025年12月1日");
  });
});
