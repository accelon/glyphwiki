#!/usr/bin/env bun
/**
 * probe-image-parts.ts — **以圖拼形**的原型裡最關鍵的一步：**把圖切成部件、認出它們** ✓。
 *
 * 為什麼是這一步（第 113 輪的實測結論）：
 *   「以圖找字」用純墨跡比對**行不通** ✗——19 萬個字全掃完，正確答案不在前 20 名
 *   （前幾名 IoU 只有 0.32＝雜訊 ✗）。原因：字庫的 `u30ede-jv` 是**日本變體**、
 *   而圖是印刷體，**佈局根本不同** ✗。
 *   但這個專案有別人沒有的東西：**97,079 個字的 IDS 分解** ✓。
 *   所以正確的路是「**以圖拼形** → 用部件序列去查 IDS」✓✓，而不是硬比全字 ✗。
 *
 * 做法（不用機器學習 ✓）：
 *   ① 把點陣按**橫向投影**切成帶（band ✓）——上下堆疊的字就是這樣分的 ✓
 *   ② 每一帶各別正規化 → 與字庫所有碼位比對（IoU ＋ 可選 chamfer ✓）
 *   ③ 印出每一帶的前幾名，以及「期望的部件」排第幾 ✓
 *
 * 用法:
 *   bun run tools/probe-image-parts.ts --mask out/_mask-xue.txt [--expect 學,好,孔,孟] [--top 5] [--limit N]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine } from "./compose-fit.ts";
import { drawingIdx } from "./free-compose.ts";
import { rasterize } from "./raster.ts";
import { normalizedMask } from "./shape-similarity.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MASK = arg("--mask");
if (!MASK) { console.error("要給 --mask out/_mask-XXX.txt"); process.exit(1); }
const SIZE = 48;
const TOP = Number(arg("--top", "5"));
const LIMIT = arg("--limit") ? Number(arg("--limit")) : Infinity;
const EXPECT = (arg("--expect") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const MIN_BAND = Number(arg("--min-band", "4"));      /* 太薄的帶不當部件（筆畫橫條 ✗） */

const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

/* ① 讀點陣 */
const lines = readFileSync(resolve(ROOT, MASK), "utf8").trim().split(/\r?\n/);
const full: Uint8Array = new Uint8Array(SIZE * SIZE);
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) full[y * SIZE + x] = (lines[y] ?? "")[x] === "1" ? 1 : 0;

/* ② 橫向投影 → 切帶（連續有墨的行算一帶 ✓，空白行是分隔 ✓） */
const rowInk = (y: number) => { let n = 0; for (let x = 0; x < SIZE; x++) n += full[y * SIZE + x]!; return n; };
const bands: [number, number][] = [];
let start = -1;
for (let y = 0; y <= SIZE; y++) {
  const has = y < SIZE && rowInk(y) > 0;
  if (has && start < 0) start = y;
  if (!has && start >= 0) { if (y - start >= 1) bands.push([start, y - 1]); start = -1; }
}
/* 合併太薄的帶到鄰居（避免把一筆橫畫當成一個部件 ✗） */
const merged: [number, number][] = [];
for (const b of bands) {
  const h = b[1] - b[0] + 1;
  if (h < MIN_BAND && merged.length) merged[merged.length - 1] = [merged[merged.length - 1]![0], b[1]];
  else merged.push(b);
}
console.log(`${MASK}：切成 ${merged.length} 帶（厚度 ≥ ${MIN_BAND}）`);
console.log(merged.map((b, i) => `  ${i + 1}: 行 ${b[0]}–${b[1]}（${b[1] - b[0] + 1} 行）`).join("\n"));

/** 把某一帶的墨裁到自己的墨框、拉伸成 SIZE×SIZE（與字庫同一種正規化 ✓） */
function bandMask(b: [number, number]): Uint8Array | null {
  let x1 = SIZE, x2 = -1, y1 = SIZE, y2 = -1;
  for (let y = b[0]; y <= b[1]; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!full[y * SIZE + x]) continue;
      if (x < x1) x1 = x; if (x > x2) x2 = x;
      if (y < y1) y1 = y; if (y > y2) y2 = y;
    }
  }
  if (x2 < x1) return null;
  const w = x2 - x1 + 1, h = y2 - y1 + 1;
  const out = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const sy = y1 + Math.min(h - 1, Math.round(((y + 0.5) / SIZE) * h - 0.5));
    for (let x = 0; x < SIZE; x++) {
      const sx = x1 + Math.min(w - 1, Math.round(((x + 0.5) / SIZE) * w - 0.5));
      out[y * SIZE + x] = full[sy * SIZE + sx]!;
    }
  }
  return out;
}
const ascii = (m: Uint8Array) => {
  const rows: string[] = [];
  for (let y = 0; y < SIZE; y += 2) {
    let s = "";
    for (let x = 0; x < SIZE; x++) s += (m[y * SIZE + x] || m[(y + 1) * SIZE + x]) ? "█" : "·";
    rows.push(s);
  }
  return rows;
};

/** 小位移容忍的 IoU（印出來的字與 KAGE 畫法常差一兩格 ✓） */
function iouShift(a: Uint8Array, b: Uint8Array, shift = 1): number {
  let best = 0;
  for (let dy = -shift; dy <= shift; dy++) {
    for (let dx = -shift; dx <= shift; dx++) {
      let inter = 0, uni = 0;
      for (let y = 0; y < SIZE; y++) {
        const sy = y + dy;
        if (sy < 0 || sy >= SIZE) continue;
        for (let x = 0; x < SIZE; x++) {
          const sx = x + dx;
          if (sx < 0 || sx >= SIZE) continue;
          const A = a[sy * SIZE + sx]!, B = b[y * SIZE + x]!;
          if (A && B) inter++;
          if (A || B) uni++;
        }
      }
      const v = uni ? inter / uni : 0;
      if (v > best) best = v;
    }
  }
  return best;
}

/* ③ 每一帶比對字庫 */
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };
const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase();
for (let bi = 0; bi < merged.length; bi++) {
  const m = bandMask(merged[bi]!);
  if (!m) continue;
  const art = ascii(m);
  console.log(`\n─── 第 ${bi + 1} 帶 ───`);
  console.log(art.map((r) => "  " + r).join("\n"));
  const t0 = Date.now();
  const top: { cp: number; ix: number; v: number }[] = [];
  let scanned = 0;
  for (let gi = 0; gi < lib.glyphs.length; gi++) {
    const cp = F.codePointOf(lib, gi);
    if (!cp) continue;
    if (scanned++ >= LIMIT) break;
    let r = null;
    try {
      const di = drawingIdx(lib, gi);
      const kage = new Kage();
      const seen = new Set<number>(), stack = [di];
      while (stack.length) {
        const j = stack.pop()!;
        if (seen.has(j)) continue;
        seen.add(j);
        kage.kBuhin.push(F.keyOfIdx(lib, j), F.toKageData(lib.glyphs[j]!, lib));
        for (const s of lib.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
      }
      r = rasterize(kage, F.keyOfIdx(lib, di), SIZE, 1);
    } catch { r = null; }
    if (!r) continue;
    const mm = normalizedMask(r, SIZE);
    if (!mm) continue;
    const v = iouShift(m, mm);
    if (top.length < TOP || v > top[top.length - 1]!.v) {
      top.push({ cp, ix: gi, v });
      top.sort((a, b) => b.v - a.v);
      if (top.length > TOP) top.length = TOP;
    }
  }
  console.log(`  掃 ${scanned.toLocaleString()} 個碼位、${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  for (const t of top) console.log(`    ${t.v.toFixed(3)}　${hex(t.cp)} ${ch(t.cp)}　${F.displayName(lib, t.ix)}`);
  for (const e of EXPECT) {
    const rank = top.findIndex((t) => t.cp === e.codePointAt(0)!);
    console.log(`    期望「${e}」：` + (rank >= 0 ? `第 ${rank + 1} 名 ✓` : `不在前 ${TOP} 名 ✗`));
  }
}
