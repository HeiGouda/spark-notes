import { describe, expect, it } from "vitest";
import { isTheme, normalizeThemeMemory, toggleTarget } from "./themes";

describe("主题", () => {
  it("只认内置的五套主题", () => {
    for (const id of ["light", "paper", "green", "night", "black"]) expect(isTheme(id)).toBe(true);
    expect(isTheme("dark")).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it("旧设置只有 theme：当前主题那一侧用它，另一侧用默认值", () => {
    expect(normalizeThemeMemory("night", undefined, undefined)).toEqual({ lastLight: "light", lastDark: "night" });
    expect(normalizeThemeMemory("light", undefined, undefined)).toEqual({ lastLight: "light", lastDark: "night" });
  });

  it("记忆分组不对或不认识时回到默认值", () => {
    expect(normalizeThemeMemory("paper", "black", "green")).toEqual({ lastLight: "paper", lastDark: "night" });
    expect(normalizeThemeMemory("black", "sepia", 3)).toEqual({ lastLight: "light", lastDark: "black" });
  });

  it("当前主题覆盖它那一侧的记忆，另一侧保留", () => {
    expect(normalizeThemeMemory("green", "paper", "black")).toEqual({ lastLight: "green", lastDark: "black" });
  });

  it("切换在上次的浅色与深色主题之间来回", () => {
    let memory = normalizeThemeMemory("paper", undefined, "black");
    let theme = toggleTarget("paper", memory);
    expect(theme).toBe("black");
    memory = normalizeThemeMemory(theme, memory.lastLight, memory.lastDark);
    theme = toggleTarget(theme, memory);
    expect(theme).toBe("paper");
  });
});
