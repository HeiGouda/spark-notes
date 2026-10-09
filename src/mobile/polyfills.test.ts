import { describe, expect, it } from "vitest";
import { at, findLast, findLastIndex, groupBy, hasOwn } from "./polyfills";

describe("旧 WebView 补的方法", () => {
  it("at 支持负数下标，越界给 undefined", () => {
    expect(at.call([1, 2, 3], -1)).toBe(3);
    expect(at.call([1, 2, 3], 0)).toBe(1);
    expect(at.call([1, 2, 3], 1.7)).toBe(2);
    expect(at.call([1, 2, 3], 3)).toBeUndefined();
    expect(at.call([1, 2, 3], -4)).toBeUndefined();
    expect(at.call("abc", -1)).toBe("c");
    expect(at.call(new Uint8Array([7, 8]), -1)).toBe(8);
  });

  it("findLast / findLastIndex 从后往前找", () => {
    const list = [{ n: 1, ok: true }, { n: 2, ok: false }, { n: 3, ok: true }, { n: 4, ok: false }];
    expect(findLastIndex.call(list, (x) => (x as { ok: boolean }).ok)).toBe(2);
    expect(findLast.call(list, (x) => (x as { ok: boolean }).ok)).toBe(list[2]);
    expect(findLastIndex.call(list, () => false)).toBe(-1);
    expect(findLast.call(list, () => false)).toBeUndefined();
  });

  it("groupBy 按键分组，保留原顺序，结果没有原型", () => {
    const groups = groupBy(["a1", "b1", "a2"], (s) => s[0]);
    expect({ ...groups }).toEqual({ a: ["a1", "a2"], b: ["b1"] });
    expect(Object.getPrototypeOf(groups)).toBeNull();
    expect(groupBy(new Set([1, 2, 3]), (n, i) => (i === 0 ? "first" : n % 2 ? "odd" : "even"))).toEqual(
      Object.assign(Object.create(null), { first: [1], even: [2], odd: [3] }),
    );
  });

  it("hasOwn 只认自己的属性", () => {
    expect(hasOwn({ a: 1 }, "a")).toBe(true);
    expect(hasOwn({ a: 1 }, "toString")).toBe(false);
    expect(hasOwn(Object.create(null), "a")).toBe(false);
  });
});
