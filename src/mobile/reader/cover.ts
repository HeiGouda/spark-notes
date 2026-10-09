/** 书架封面：从书里取封面图，取不到时按书名给一个固定的颜色 */

/** 封面底色和字色，柔和一点，放在浅色和深色主题里都不刺眼 */
const PALETTE: [string, string][] = [
  ["#5B7DB1", "#F4F7FC"],
  ["#C0705A", "#FFF6F2"],
  ["#6E9C7A", "#F3FAF5"],
  ["#B58A4C", "#FFF9EF"],
  ["#8A6FB0", "#F8F4FD"],
  ["#4F8F98", "#F0F9FA"],
  ["#A85F7E", "#FDF3F7"],
  ["#6B7280", "#F5F6F8"],
];

/** 同一个书名总是同一种颜色 */
export function coverColor(name: string): { bg: string; fg: string } {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  const [bg, fg] = PALETTE[h % PALETTE.length];
  return { bg, fg };
}

/** 能从书里取封面的格式；TXT 没有封面 */
export function hasEmbeddedCover(name: string): boolean {
  return /\.(epub|mobi|azw3|pdf)$/i.test(name);
}

const COVER_WIDTH = 300;

async function shrink(blob: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, COVER_WIDTH / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!out) throw new Error("压缩封面失败");
  return new Uint8Array(await out.arrayBuffer());
}

/** 打开书取出封面，缩到 300px 宽的 JPEG；书里没有封面时返回 null */
export async function extractCover(url: string, name: string): Promise<Uint8Array | null> {
  if (!hasEmbeddedCover(name)) return null;
  // @ts-expect-error foliate-js 是没有类型声明的浏览器模块
  const mod = await import("../../../vendor/foliate-js/view.js");
  const book = (await mod.makeBook(url)) as { getCover?: () => Promise<Blob | null> | Blob | null; destroy?: () => void };
  try {
    const blob = await book.getCover?.();
    return blob && blob.size ? await shrink(blob) : null;
  } finally {
    book.destroy?.();
  }
}
