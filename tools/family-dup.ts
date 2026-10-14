#!/usr/bin/env bun
/**
 * family-dup.ts — 家族裡有多少異體是「重複」的。
 *
 * 兩種重複要分開講：
 *   資料完全相同（筆劃座標一字不差）→ 可以直接合併，沒有任何風險
 *   資料不同但**畫出來一樣**（例如 u4e23 vs u4e23-j）→ 要看渲染才知道
 *
 * 用法: bun run tools/family-dup.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { keyOfIdx, toKageData, familyMembers, displayName } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine } from "./compose-fit.ts";
import { rasterize } from "./raster.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib: L } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

function sig(i: number): string {
  const g = L.glyphs[i]!;
  return g.strokes.map((s) => s.kind === 99
    ? "99:" + s.ref + ":" + (s.box ?? []).join(",")
    : s.kind + ":" + s.width + ":" + s.style + ":" + s.points.join(",")).join("|");
}
const covCache = new Map<number, Uint8Array>();
function bitmap(i: number): Uint8Array {
  const hit = covCache.get(i);
  if (hit) return hit;
  const kage = new (globalThis as any).Kage();
  const seen = new Set<number>();
  const stack = [i];
  while (stack.length) {
    const j = stack.pop()!;
    if (seen.has(j)) continue;
    seen.add(j);
    const g = L.glyphs[j]!;
    kage.kBuhin.push(keyOfIdx(L, j), toKageData(g, L));
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  const S = 32;
  const c = rasterize(kage, keyOfIdx(L, i), S, 1).cov;
  const b = new Uint8Array(S * S);
  for (let k = 0; k < b.length; k++) b[k] = c[k]! > 0.5 ? 1 : 0;
  covCache.set(i, b);
  return b;
}
function same(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let fams = 0, members = 0;
let dataDupFams = 0, dataDupMembers = 0;
let visDupFams = 0, visDupMembers = 0;
const visExamples: string[] = [];
const t = performance.now();
for (const f of L.families) {
  const fam = familyMembers(L, f.cp);
  if (fam.length < 2) continue;
  fams++; members += fam.length;
  const sigs = new Map<string, number[]>();
  fam.forEach((i, k) => { const s = sig(i); const a = sigs.get(s); if (a) a.push(k); else sigs.set(s, [k]); });
  const dmiss = fam.length - sigs.size;
  if (dmiss) { dataDupFams++; dataDupMembers += dmiss; }
  /* 視覺重複：只在「資料不同」的成員之間比，且同一張點陣只算一次 */
  const reps: number[] = [];
  for (const [, ks] of sigs) reps.push(fam[ks[0]!]!);
  const bits = reps.map(bitmap);
  let vmiss = 0;
  const keep: number[] = [];
  for (let i = 0; i < reps.length; i++) {
    let dupOf = -1;
    for (const k of keep) if (same(bits[i]!, bits[k]!)) { dupOf = k; break; }
    if (dupOf >= 0) {
      vmiss++;
      if (visExamples.length < 10) {
        visExamples.push(`  ${displayName(L, reps[i]!)} = ${displayName(L, reps[dupOf]!)}` +
          `（U+${f.cp.toString(16).toUpperCase()}）`);
      }
    } else keep.push(i);
  }
  if (vmiss) { visDupFams++; visDupMembers += vmiss; }
}
console.log(`掃 ${fams.toLocaleString()} 個多成員家族、${members.toLocaleString()} 個成員　${((performance.now() - t) / 1000).toFixed(1)} 秒\n`);
console.log("=== 資料完全相同（可直接合併）===");
console.log(`  ${dataDupFams.toLocaleString()} 個家族（${(100 * dataDupFams / fams).toFixed(1)}%）、` +
  `${dataDupMembers.toLocaleString()} 個多餘成員`);
console.log("\n=== 資料不同但畫出來一樣（32×32 點陣逐格相同）===");
console.log(`  ${visDupFams.toLocaleString()} 個家族有這種成員、共 ${visDupMembers.toLocaleString()} 個可去`);
for (const e of visExamples) console.log(e);
console.log("\n=== U+4E23 丣 ===");
{
  const fam = familyMembers(L, 0x4E23);
  for (const i of fam) {
    console.log(`  ${displayName(L, i)}　資料簽章長度 ${sig(i).length}　` +
      `筆數 ${L.glyphs[i]!.strokes.length}`);
  }
  const bits = fam.map(bitmap);
  console.log(`  32×32 點陣相同？ ${same(bits[0]!, bits[1]!)}`);
}
