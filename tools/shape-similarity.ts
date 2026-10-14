/**
 * shape-similarity.ts — **形狀相似度**（把位置與大小去掉之後再比）。
 *
 * 為什麼不能用原始 IoU（第 110 輪實測踩到）：
 *   部件的形式**本來就畫在不同的位置與大小**——`刀`（置中）與 `刂`（窄、靠右）的原始 IoU 只有 **0.06** ✗；
 *   `手/扌` 0.30、`水/氵` 0.14、`金/釒` 0.07。
 *   拿原始 IoU 當「是不是同一個形式」的判準，會**同時**擋掉真的（刀/刂）與放過假的 ✗。
 *
 * 做法：兩個點陣各自**裁到墨跡框**（`cov > thr`），再重採樣到固定 `size×size`，然後比 IoU ✓。
 *   於是「同一個形、放在不同位置」會很像，「不同的形」還是不像 ✓。
 */
import type { Raster } from "./raster.ts";

interface Box { x1: number; y1: number; x2: number; y2: number }

/** 墨跡框（含界）；`thr` 是判定「有墨」的覆蓋率門檻 */
export function inkBox(r: Raster, thr = 0.35): Box | null {
  const n = r.size;
  let x1 = n, y1 = n, x2 = -1, y2 = -1;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (r.cov[y * n + x]! > thr) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  return x2 < x1 ? null : { x1, y1, x2, y2 };
}

/** 把墨跡裁出來、重採樣成 `size×size` 的 0/1 覆蓋率 */
export function normalizedMask(r: Raster, size = 48, thr = 0.35): Uint8Array | null {
  const b = inkBox(r, thr);
  if (!b) return null;
  const n = r.size;
  const w = b.x2 - b.x1 + 1, h = b.y2 - b.y1 + 1;
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      /* 取樣格中心對應回原點陣（最近鄰；面積小的時候夠用） */
      const sx = b.x1 + Math.min(w - 1, Math.round(((x + 0.5) / size) * w - 0.5));
      const sy = b.y1 + Math.min(h - 1, Math.round(((y + 0.5) / size) * h - 0.5));
      out[y * size + x] = r.cov[sy * n + sx]! > thr ? 1 : 0;
    }
  }
  return out;
}

/**
 * **正規化 IoU**：兩個字形各自裁到墨跡框、縮到同一個方格後的重疊度。
 * 1.00＝同一個形（只是位置／大小不同）；0.00＝完全不像。
 */
export function normalizedIou(a: Raster, b: Raster, size = 48, thr = 0.35): number | null {
  const ma = normalizedMask(a, size, thr), mb = normalizedMask(b, size, thr);
  if (!ma || !mb) return null;
  let inter = 0, uni = 0;
  for (let i = 0; i < ma.length; i++) {
    const x = ma[i]!, y = mb[i]!;
    if (x && y) inter++;
    if (x || y) uni++;
  }
  return uni ? inter / uni : null;
}

/** 寬高比（裁到墨跡框之後）——同一個形在不同位置時，比例通常接近 ✓ */
export function inkAspect(r: Raster, thr = 0.35): number | null {
  const b = inkBox(r, thr);
  if (!b) return null;
  return (b.x2 - b.x1 + 1) / (b.y2 - b.y1 + 1);
}
