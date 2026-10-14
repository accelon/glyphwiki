#!/usr/bin/env bun
/**
 * browser-perf.ts — 字集瀏覽介面的成本量測。
 *
 * 介面的每個設計決定都取決於這幾個數字，所以先量再設計：
 *   1. 解碼整份字庫要多久（瀏覽器開頁的第一筆成本）
 *   2. 建「部件 → 含該部件的字」索引要多久、佔多少記憶體
 *   3. 畫一個 KAGE 字形要多久（決定能不能「全部顯示」）
 *   4. 一次部件搜尋要多久
 *
 * 用法: bun run tools/browser-perf.ts [--lib out/lib-cjk-all.bin.gz] [--n 300]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeLibrary, indexOfCodePoint, indexOfChar, displayName, keyOfIdx, toKageData,
  codePointOf, familyMembers, isPlainIdeograph,
} from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { ensureEngine, normalizeSvg, inkOfRefInParent } from "./compose-fit.ts";
import { refSlotsOf, searchByComponent } from "./free-compose.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const li = argv.indexOf("--lib");
const ni = argv.indexOf("--n");
const N = ni >= 0 ? Number(argv[ni + 1]) : 300;
const libPath = resolve(ROOT, li >= 0 && argv[li + 1] ? argv[li + 1]! : "out/lib-cjk-all.bin.gz");

const mb = (n: number) => (n / 1048576).toFixed(2);
const gzBytes = readFileSync(libPath);
console.log(`字庫 ${libPath}`);
console.log(`  gzip ${mb(gzBytes.length)} MB、base64 ${mb(Math.ceil(gzBytes.length / 3) * 4)} MB`);

// ---- 1. 解碼 ----
let t = performance.now();
const raw = new Uint8Array(Bun.gunzipSync(gzBytes));
const tGunzip = performance.now() - t;
t = performance.now();
const lib: Library = decodeLibrary(raw);
const tDecode = performance.now() - t;
console.log(`\n1. 開頁成本`);
console.log(`   gunzip          ${tGunzip.toFixed(0)} ms`);
console.log(`   decodeLibrary   ${tDecode.toFixed(0)} ms（含逐字形算緊框）`);
console.log(`   合計            ${(tGunzip + tDecode).toFixed(0)} ms　字形 ${lib.glyphs.length.toLocaleString()}`);

ensureEngine();

// ---- 2. 部件索引 ----
t = performance.now();
const compIndex = new Map<number, number[]>();   // 部件碼位 → 含它的父字索引（L1）
let edges = 0;
for (let i = 0; i < lib.glyphs.length; i++) {
  if (!isPlainIdeograph(lib, i)) continue;
  for (const s of refSlotsOf(lib, i)) {
    const cp = codePointOf(lib, s.ref);
    if (!cp) continue;
    edges++;
    const arr = compIndex.get(cp);
    if (arr) arr.push(i); else compIndex.set(cp, [i]);
  }
}
const tIndex = performance.now() - t;
let idxEntries = 0;
for (const a of compIndex.values()) idxEntries += a.length;
const idxBytes = idxEntries * 4 + compIndex.size * 48;
console.log(`\n2. 部件索引（L1，只看一般漢字）`);
console.log(`   建立            ${tIndex.toFixed(0)} ms`);
console.log(`   ${compIndex.size.toLocaleString()} 個部件、${idxEntries.toLocaleString()} 條邊`);
console.log(`   粗估記憶體      ${mb(idxBytes)} MB（Int32 陣列 + Map 開銷）`);
// 最常見的幾個部件
const top = [...compIndex.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
console.log(`   最常見部件      ${top.map(([cp, a]) => String.fromCodePoint(cp) + "×" + a.length).join("　")}`);

// ---- 3. KAGE 描繪速率 ----
function svgOf(L: Library, idx: number): string {
  const kage = new (globalThis as any).Kage();
  const seen = new Set<number>();
  const stack = [idx];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i]!;
    kage.kBuhin.push(keyOfIdx(L, i), toKageData(g, L));
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  const polys = new (globalThis as any).Polygons();
  kage.makeGlyph(polys, keyOfIdx(L, idx));
  return normalizeSvg(polys.generateSVG(true));
}
// 取樣：從 URO 均勻挑 N 個有字形的碼位
const sample: number[] = [];
for (let cp = 0x4e00; cp <= 0x9fff && sample.length < N; cp += 7) if (indexOfCodePoint(lib, cp) !== undefined) sample.push(cp);
t = performance.now();
let svgBytes = 0;
for (const cp of sample) {
  const i = indexOfCodePoint(lib, cp)!;
  svgBytes += svgOf(lib, i).length;
}
const tRender = performance.now() - t;
const per = tRender / sample.length;
console.log(`\n3. KAGE 描繪（${sample.length} 個字取樣）`);
console.log(`   每個字          ${per.toFixed(2)} ms　→ 每秒 ${(1000 / per).toFixed(0)} 個`);
console.log(`   平均 SVG        ${(svgBytes / sample.length / 1024).toFixed(1)} KB`);
console.log(`   畫滿整個畫面    （假設一次 300 格）${(per * 300).toFixed(0)} ms`);
console.log(`   全部 191,727 個 一次畫完要 ${(per * lib.glyphs.length / 1000).toFixed(0)} 秒（＝不可行，必須虛擬化）`);

// ---- 4. 部件搜尋 ----
console.log(`\n4. 部件搜尋`);
for (const ch of ["隹", "水", "口"]) {
  const cp = ch.codePointAt(0)!;
  t = performance.now();
  const hits = searchByComponent(lib, { ch, level: 1, limit: 5000, inkOfRef: inkOfRefInParent });
  const ms = performance.now() - t;
  const fromIndex = compIndex.get(cp)?.length ?? 0;
  console.log(`   「${ch}」精確搜尋（量墨跡） ${ms.toFixed(0)} ms、${hits.length} 筆` +
    `　索引查表 ${fromIndex} 筆（0 ms）`);
}

// ---- 5. 帶部件的字有多少 ----
console.log(`\n5. 一個部件通常能構成幾個字（L1）`);
const dist = [1, 2, 5, 10, 50, 100];
let cum = 0; const arr = [...compIndex.values()].map((a) => a.length).sort((a, b) => a - b);
for (const d of dist) {
  cum = arr.filter((n) => n <= d).length;
  console.log(`   ≤ ${String(d).padStart(3)} 個字的部件：${cum.toLocaleString()}（${(100 * cum / arr.length).toFixed(0)}%）`);
}
