#!/usr/bin/env bun
/**
 * probe-zone-threshold.ts — inkZoneOf 的 1/3、2/3 門檻是不是太緊。
 *
 * 症狀：休／沐／析 的右半 cx ≈ 0.63～0.65，差一點點過不了 2/3，
 * 被歸成「中」而不是「右」，於是 `+木` 只找到 44 個字。
 *
 * 這支把全庫「有 2 個以上引用」的 (parent, ref) 的 cx 分佈畫出來，
 * 看看有沒有天然的斷點可以放門檻。
 *
 * 用法: bun run tools/probe-zone-threshold.ts
 */
import { resolve } from "node:path";
import { indexOfCodePoint, codePointOf, isPlainIdeograph } from "./lib-format.ts";
import { refSlotsOf } from "./free-compose.ts";
import { inkOfRefInParent } from "./compose-fit.ts";
import type { Library } from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"));
const L: Library = lib;

const cxs: number[] = [], cys: number[] = [];
const t = performance.now();
for (let i = 0; i < L.glyphs.length; i++) {
  if (!isPlainIdeograph(L, i)) continue;
  const slots = refSlotsOf(L, i);
  if (slots.length < 2) continue;
  const inks = slots.map((s) => inkOfRefInParent(L, i, s.strokeIx));
  const x1 = Math.min(...inks.map((b) => b.x1)), x2 = Math.max(...inks.map((b) => b.x2));
  const y1 = Math.min(...inks.map((b) => b.y1)), y2 = Math.max(...inks.map((b) => b.y2));
  const uw = Math.max(1, x2 - x1), uh = Math.max(1, y2 - y1);
  for (const b of inks) {
    cxs.push(((b.x1 + b.x2) / 2 - x1) / uw);
    cys.push(((b.y1 + b.y2) / 2 - y1) / uh);
  }
}
console.log(`${cxs.length.toLocaleString()} 個引用，量了 ${((performance.now() - t) / 1000).toFixed(1)} 秒\n`);

function hist(name: string, a: number[]) {
  const bins = new Array(20).fill(0);
  for (const v of a) bins[Math.max(0, Math.min(19, Math.floor(v * 20)))]++;
  const max = Math.max(...bins);
  console.log(`${name} 分佈（每格 0.05）：`);
  for (let i = 0; i < 20; i++) {
    const lo = (i / 20).toFixed(2);
    console.log(`  ${lo} ${"█".repeat(Math.round(60 * bins[i]! / max)).padEnd(60)} ${bins[i]!.toLocaleString()}`);
  }
  console.log();
}
hist("cx", cxs);
hist("cy", cys);

console.log("=== 不同門檻下的分類數 ===");
for (const [lo, hi] of [[1 / 3, 2 / 3], [0.4, 0.6], [0.42, 0.58], [0.45, 0.55], [0.5, 0.5]]) {
  let l = 0, r = 0, u = 0, d = 0, mid = 0;
  for (let k = 0; k < cxs.length; k++) {
    const cx = cxs[k]!, cy = cys[k]!;
    const vert = cy < lo ? "上" : cy > hi ? "下" : "";
    const horz = cx < lo ? "左" : cx > hi ? "右" : "";
    if (!vert && !horz) { mid++; continue; }
    if (horz === "左") l++; else if (horz === "右") r++;
    if (vert === "上") u++; else if (vert === "下") d++;
  }
  console.log(`  門檻 ${lo.toFixed(2)}/${hi.toFixed(2)}：左 ${l.toLocaleString()}　右 ${r.toLocaleString()}　上 ${u.toLocaleString()}　下 ${d.toLocaleString()}　中/滿 ${mid.toLocaleString()}`);
}

console.log("\n=== 幾個關鍵字在 0.40/0.60 底下會變成什麼 ===");
const lo = 0.4, hi = 0.6;
for (const cp of [0x4f11, 0x6c90, 0x6790, 0x76f8, 0x597d, 0x5446, 0x908f, 0x2320c, 0x674f]) {
  const i = indexOfCodePoint(L, cp);
  if (i === undefined) continue;
  const slots = refSlotsOf(L, i);
  if (slots.length < 2) { console.log(`  ${String.fromCodePoint(cp)} refs=${slots.length}`); continue; }
  const inks = slots.map((s) => inkOfRefInParent(L, i, s.strokeIx));
  const x1 = Math.min(...inks.map((b) => b.x1)), x2 = Math.max(...inks.map((b) => b.x2));
  const y1 = Math.min(...inks.map((b) => b.y1)), y2 = Math.max(...inks.map((b) => b.y2));
  const uw = Math.max(1, x2 - x1), uh = Math.max(1, y2 - y1);
  const parts = slots.map((s, n) => {
    const b = inks[n]!, cx = ((b.x1 + b.x2) / 2 - x1) / uw, cy = ((b.y1 + b.y2) / 2 - y1) / uh;
    const vert = cy < lo ? "上" : cy > hi ? "下" : "";
    const horz = cx < lo ? "左" : cx > hi ? "右" : "";
    const mw = (b.x2 - b.x1) / uw, mh = (b.y2 - b.y1) / uh;
    const z = vert || horz ? (vert + horz) : (mw > 0.8 && mh > 0.8 ? "滿" : "中");
    const rc = codePointOf(L, s.ref);
    return (rc ? String.fromCodePoint(rc) : "?") + "=" + z;
  });
  console.log(`  ${String.fromCodePoint(cp)}　${parts.join("  ")}`);
}
