/** 选区矩形和当前这一页的可见范围。坐标同一套即可（都在书页 iframe 里，或都在屏幕上） */
export interface SelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface SelRect extends SelBox {
  width: number;
  height: number;
}

/**
 * 选区是否整段落在这一页里。
 * 左右翻页时下一页在旁边；上下滚动时下一页在屏幕下面。
 * 一行的中心必须落在这一页里。只从页缝里探进一两个像素的下一页，不算在本页。
 * 量不到矩形时不当成越界，避免选区还没排出来就被清掉。
 */
export function selectionFits(rects: SelRect[], box: SelBox): boolean {
  for (const r of rects) {
    if (r.width < 0.5 || r.height < 0.5) continue;
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) return false;
  }
  return true;
}
