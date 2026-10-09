/**
 * 旧版安卓 WebView 缺少的几个方法。构建只转语法、不补 API，没有这些方法时 EPUB 打不开：
 * foliate-js 解析 EPUB 用到 Object.groupBy（Chrome 117）、Array#at（92）、Array#findLastIndex（97），
 * Pinia 和代码高亮 refractor 用到 Object.hasOwn（93）。WebView 自带的方法不会被覆盖。
 * 必须在其他模块之前执行，所以 main.ts 第一个导入它。
 */

type Indexed = { readonly length: number; readonly [index: number]: unknown };
type Predicate = (value: unknown, index: number, array: unknown[]) => unknown;

export function at(this: Indexed, index: number): unknown {
  const len = this.length;
  let i = Math.trunc(Number(index)) || 0;
  if (i < 0) i += len;
  return i < 0 || i >= len ? undefined : this[i];
}

export function findLastIndex(this: unknown[], predicate: Predicate, thisArg?: unknown): number {
  for (let i = this.length - 1; i >= 0; i--) {
    if (predicate.call(thisArg, this[i], i, this)) return i;
  }
  return -1;
}

export function findLast(this: unknown[], predicate: Predicate, thisArg?: unknown): unknown {
  const i = findLastIndex.call(this, predicate, thisArg);
  return i < 0 ? undefined : this[i];
}

export function groupBy<T>(items: Iterable<T>, key: (item: T, index: number) => PropertyKey): Record<PropertyKey, T[]> {
  const out: Record<PropertyKey, T[]> = Object.create(null);
  let i = 0;
  for (const item of items) {
    const k = key(item, i++);
    (out[k] || (out[k] = [])).push(item);
  }
  return out;
}

export function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function define(target: object, name: string, value: unknown) {
  if (!(name in target)) Object.defineProperty(target, name, { value, writable: true, configurable: true });
}

define(Array.prototype, "at", at);
define(String.prototype, "at", at);
define(Object.getPrototypeOf(Int8Array.prototype), "at", at);
define(Array.prototype, "findLast", findLast);
define(Array.prototype, "findLastIndex", findLastIndex);
define(Object, "groupBy", groupBy);
define(Object, "hasOwn", hasOwn);
