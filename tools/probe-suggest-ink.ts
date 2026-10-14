#!/usr/bin/env bun
/**
 * probe-suggest-ink.ts — 量「換完之後**能不能看**」（師父第 112 輪指出的問題 ✗）。
 *
 * 師父給的判例（這就是我的測試集 ✓）：
 *   · 「庚广廣」**不行**——墨都搞一塊 ✗
 *   · 「庚广厂」可行 ✓
 *   · 「庚广艹」**目前還組不好** ✗
 *   · 「初衤禾」是客人原本的輸入（勉強可看、但不好 ✗）；「利刂刀」是正確答案 ✓
 *
 * 我原本只驗「引擎換得動」（`canReplaceCp` ✓）——**沒驗換完好不好看** ✗。
 * 這一支量五個指標，找出能把「一團墨」與「可用」分開的判準 ✓：
 *   ① **墨量比**：新部件墨量 ÷ 被換掉部件的墨量（`廣` 又大又密 vs `广` 三筆的框 → 很大 ✗）
 *   ② 縮放：新部件在結果裡的墨寬 ÷ 它自己的墨寬（被壓得多小）
 *   ③ 重疊比：新部件墨框 與 其餘部件墨框 的重疊（`siblingInkOf` 只認子部件，手畫筆劃抓不到 ✗）
 *   ④ 最短距：直接子部件之間的筆劃最短距離（`minCrossDistOf`；0＝相交 ✗）
 *   ⑤ 密度：墨量 ÷ 墨框面積（密＝容易糊成一團）
 *
 * 用法: bun run tools/probe-suggest-ink.ts
 */
import { resolve } from "node:path";
import * as F from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine, inkIn, inkOfRefInParent, siblingInkOf } from "./compose-fit.ts";
import { minCrossDistOf } from "./stroke-overlap.ts";
import { evalSeq, drawingIdx } from "./free-compose.ts";
import { rasterize } from "./raster.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

type Box = { x1: number; y1: number; x2: number; y2: number };
const inter = (a: Box, b: Box): number => {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  return w > 0 && h > 0 ? w * h : 0;
};
const area = (a: Box): number => Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
const ch = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return "?" }; };

/** 單獨渲染某個碼位的代表字形（給墨量／密度用 ✓） */
const memo = new Map<number, any>();
function ownRaster(cp: number): any {
  if (memo.has(cp)) return memo.get(cp);
  let r: any = null;
  const gi = F.indexOfCodePoint(lib, cp);
  if (gi !== undefined) {
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
    try { r = rasterize(kage, F.keyOfIdx(lib, di), 64, 2); } catch { r = null; }
  }
  memo.set(cp, r);
  return r;
}
/** 墨量（有墨的格數）與墨框 ✓ */
function mass(cp: number): { px: number; box: Box | null } {
  const r = ownRaster(cp);
  if (!r) return { px: 0, box: null };
  let px = 0, x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
  const n = r.size;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (r.cov[y * n + x]! <= 0.35) continue;
      px++;
      if (x < x1) x1 = x; if (x > x2) x2 = x;
      if (y < y1) y1 = y; if (y > y2) y2 = y;
    }
  }
  return { px, box: x2 < x1 ? null : { x1, y1, x2, y2 } };
}

/** 找到「新放進去的那個部件」在結果字形裡的筆劃索引 ✓ */
function findNewPart(L: any, idx: number, newCp: number): number {
  const g = L.glyphs[idx]!;
  for (let i = 0; i < g.strokes.length; i++) {
    const s = g.strokes[i]!;
    if (s.kind !== 99 || s.ref === null) continue;
    if (F.codePointOf(L, s.ref) === newCp) return i;
  }
  return -1;
}

/* 師父的判例 ＋ 既有的測試例 ✓（「庚广匚」依師父指示略去 ✓） */
const cases: [string, string, string, string][] = [
  ["庚", "广", "廣", "師父判**不行**：墨都搞一塊 ✗"],
  ["庚", "广", "艹", "師父判**目前還組不好** ✗"],
  ["庚", "广", "厂", "師父判可行 ✓"],
  ["利", "刂", "刀", "目標答案 ✓"],
  ["初", "衤", "禾", "客人原本的輸入（勉強可看 ✗）"],
  ["唐", "广", "廣", "多推薦那組的輸入 ✗"],
  ["打", "丁", "白", "換成既有字（拍）✓"],
  ["盟", "皿", "月", "舊測試例"],
  ["漢", "氵", "木", "舊測試例"],
];

/** 只畫某個字形的**一部分筆劃**（其他筆劃不畫）——用來把「新部件」與「其餘」分開量 ✓
 *  做法：KAGE 的字形資料是「一筆一項、用 `$` 分隔」✓，所以過濾一下就好 ✓ */
const subMemo = new Map<string, any>();
function rasterSubset(L: any, idx: number, keep: (i: number) => boolean): any {
  const g = L.glyphs[idx]!;
  const parts = F.toKageData(g, L).split("$");
  const kept = parts.filter((_, i) => keep(i));
  if (!kept.length) return null;
  /* ⚠ 快取鍵要用**完整資料**：一開始我用「idx ＋ 筆數 ＋ 字串長度」→ 庚广廣 與 庚广厂
     撞鍵 ✗，兩者的數字一模一樣（實測踩到 ✓）。 */
  const key = "probe" + idx + "|" + kept.join("$");
  if (subMemo.has(key)) return subMemo.get(key);
  const kage = new Kage();
  const refs: number[] = [];
  g.strokes.forEach((s: any, i: number) => {
    if (keep(i) && s.kind === 99 && s.ref !== null) refs.push(s.ref);
  });
  const seen = new Set<number>(), stack = [...refs];
  while (stack.length) {
    const j = stack.pop()!;
    if (seen.has(j)) continue;
    seen.add(j);
    kage.kBuhin.push(F.keyOfIdx(L, j), F.toKageData(L.glyphs[j]!, L));
    for (const s of L.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  kage.kBuhin.push(key, kept.join("$"));
  let r: any = null;
  try { r = rasterize(kage, key, 64, 2); } catch { r = null; }
  subMemo.set(key, r);
  return r;
}
/** 兩張點陣的墨重疊：面積單位用「有墨的格數」✓ */
function overlapPixels(a: any, b: any): { inter: number; pa: number; pb: number } {
  if (!a || !b) return { inter: 0, pa: 0, pb: 0 };
  let inter = 0, pa = 0, pb = 0;
  for (let i = 0; i < a.cov.length; i++) {
    const x = a.cov[i]! > 0.35, y = b.cov[i]! > 0.35;
    if (x) pa++;
    if (y) pb++;
    if (x && y) inter++;
  }
  return { inter, pa, pb };
}

const head = ["案例", "墨量比", "遮蓋率", "最短距", "新密度", "判"];
console.log(head[0]!.padEnd(10) + head.slice(1, 5).map((h) => h.padEnd(9)).join(""));

for (const [base, oldCh, newCh, why] of cases) {
  const seq = base + oldCh + newCh;
  const oldCp = oldCh.codePointAt(0)!, newCp = newCh.codePointAt(0)!;
  const mOld = mass(oldCp), mNew = mass(newCp);
  const massRatio = mOld.px > 0 ? mNew.px / mOld.px : NaN;
  const densNew = mNew.box ? mNew.px / Math.max(1, area(mNew.box)) : NaN;
  let r: any = null, err = "";
  try { r = evalSeq(lib, seq, {}); } catch (e) { err = (e as Error).message; }
  if (!r || !r.ok) {
    console.log(`${seq.padEnd(10)}${(Number.isNaN(massRatio) ? "—" : massRatio.toFixed(2) + "×").padEnd(9)}` +
      `${"—".padEnd(9)}${"—".padEnd(9)}` +
      `${(Number.isNaN(densNew) ? "—" : (densNew * 100).toFixed(0) + "%").padEnd(9)}組不出來${err ? "：" + err : ""}　${why}`);
    continue;
  }
  const L = r.lib, idx = r.targetIdx;
  const si = findNewPart(L, idx, newCp);
  const dist = minCrossDistOf(L, idx);
  /* ★ **遮蓋率**：新部件的墨 蓋掉 其餘墨 的比率 ✓
     （「庚广廣」的廣直接壓在庚的內筆劃上 → 高 ✗；「庚广厂」的厂只是個框 → 低 ✓） */
  let cover = NaN, detail = "";
  if (si >= 0) {
    const partR = rasterSubset(L, idx, (i) => i === si);
    const restR = rasterSubset(L, idx, (i) => i !== si);
    const ov = overlapPixels(partR, restR);
    cover = ov.pb > 0 ? ov.inter / ov.pb : NaN;
    detail = `新墨 ${ov.pa} 格、其餘墨 ${ov.pb} 格、重疊 ${ov.inter} 格`;
  }
  console.log(
    `${seq.padEnd(10)}` +
    `${(Number.isNaN(massRatio) ? "—" : massRatio.toFixed(2) + "×").padEnd(9)}` +
    `${(Number.isNaN(cover) ? "—" : (cover * 100).toFixed(1) + "%").padEnd(9)}` +
    `${(dist === Infinity ? "無" : dist.toFixed(1)).padEnd(9)}` +
    `${(Number.isNaN(densNew) ? "—" : (densNew * 100).toFixed(0) + "%").padEnd(9)}${why}`);
  if (detail) console.log(`   ${detail}`);
}
