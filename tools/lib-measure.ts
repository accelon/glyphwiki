/**
 * lib-measure.ts — 量測工具：墨跡範圍、槽位推導、等比放入。
 *
 * 需要 kage-engine（畫出真實外框才能量到正確墨跡，因為筆寬與裝飾會增胖）。
 * 這個檔案由 build-kage-viewer.ts 內嵌進網頁，也在 Node 端使用。
 */

/** 多邊形（kage-engine 的 Polygons 只提供座標，這裡用最小介面） */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface InkResult {
  box: Box;
  polys: number;
}

/** 由 kage Polygons 取墨跡範圍 */
export function inkBoxOfPolygons(polygons: {
  array: { array: { x: number; y: number }[] }[];
}): InkResult {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, n = 0;
  for (const p of polygons.array) {
    for (const pt of p.array) {
      n++;
      if (pt.x < x1) x1 = pt.x;
      if (pt.x > x2) x2 = pt.x;
      if (pt.y < y1) y1 = pt.y;
      if (pt.y > y2) y2 = pt.y;
    }
  }
  if (!Number.isFinite(x1)) return { box: { x1: 0, y1: 0, x2: 0, y2: 0 }, polys: 0 };
  return { box: { x1, y1, x2, y2 }, polys: polygons.array.length };
}

/** 矩形相減：回傳「大矩形扣掉小矩形後」的主要剩餘矩形（用於推導槽位） */
export function subtractBox(big: Box, small: Box): Box | null {
  const ix1 = Math.max(big.x1, small.x1);
  const iy1 = Math.max(big.y1, small.y1);
  const ix2 = Math.min(big.x2, small.x2);
  const iy2 = Math.min(big.y2, small.y2);
  // 沒有交集 → 原樣回傳
  if (ix1 >= ix2 || iy1 >= iy2) return big;

  // 四個方向的剩餘面積，取最大者
  const cands: Box[] = [
    { x1: big.x1, y1: big.y1, x2: big.x2, y2: iy1 }, // 上方
    { x1: big.x1, y1: iy2, x2: big.x2, y2: big.y2 }, // 下方
    { x1: big.x1, y1: iy1, x2: ix1, y2: iy2 },       // 左方
    { x1: ix2, y1: iy1, x2: big.x2, y2: iy2 },       // 右方
  ];
  let best: Box | null = null;
  let bestArea = 0;
  for (const c of cands) {
    const a = (c.x2 - c.x1) * (c.y2 - c.y1);
    if (a > bestArea) { bestArea = a; best = c; }
  }
  return bestArea > 0 ? best : null;
}

/** 等比縮放並置中：把 size 的內容放進 slot（不留白、不變形） */
export function fitUniform(size: Box, slot: Box): { ox: number; oy: number; s: number } {
  const w = Math.max(1e-6, size.x2 - size.x1);
  const h = Math.max(1e-6, size.y2 - size.y1);
  const sw = Math.max(1e-6, slot.x2 - slot.x1);
  const sh = Math.max(1e-6, slot.y2 - slot.y1);
  const s = Math.min(sw / w, sh / h);
  const cx = (slot.x1 + slot.x2) / 2;
  const cy = (slot.y1 + slot.y2) / 2;
  return { ox: cx - (w * s) / 2, oy: cy - (h * s) / 2, s };
}

/** 套用「從 size 放進 slot」的變換到一個座標 */
export function applyFit(
  x: number, y: number, size: Box, slot: Box,
): { x: number; y: number } {
  const f = fitUniform(size, slot);
  return { x: f.ox + (x - size.x1) * f.s, y: f.oy + (y - size.y1) * f.s };
}

/** 矩形轉成 kage 的框字串數值（整數） */
export function boxToKage(b: Box): number[] {
  return [
    Math.round(b.x1), Math.round(b.y1), Math.round(b.x2), Math.round(b.y2),
  ];
}
