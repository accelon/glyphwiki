#!/usr/bin/env bun
/**
 * probe-search-sizes.ts — 決定「單部件用 L1、多部件用深層」還是全部用深層。
 *
 * 用法: bun run tools/probe-search-sizes.ts
 */
import { resolve } from "node:path";
import { indexOfCodePoint, codePointOf, isPlainIdeograph } from "./lib-format.ts";
import { refSlotsOf } from "./free-compose.ts";
import type { Library } from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"));
const L: Library = lib;

const t0 = performance.now();
const d1 = new Map<number, number[]>();   // L1：cp → 直接父字
const deep = new Map<number, number[]>(); // 深層：cp → 任何層的父字
const seen = new Set<number>();
for (let i = 0; i < L.glyphs.length; i++) {
  if (!isPlainIdeograph(L, i)) continue;
  const st = L.glyphs[i]!.strokes;
  for (const s of st) {
    if (s.kind !== 99 || s.ref === null) continue;
    const cp = codePointOf(L, s.ref);
    if (cp) { const a = d1.get(cp); if (a) a.push(i); else d1.set(cp, [i]); }
  }
  seen.clear();
  const stack: number[] = [];
  for (const s of st) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  while (stack.length) {
    const j = stack.pop()!;
    if (seen.has(j)) continue;
    seen.add(j);
    const cp = codePointOf(L, j);
    if (cp) { const a = deep.get(cp); if (a) a.push(i); else deep.set(cp, [i]); }
    for (const s of L.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
}
console.log(`建兩份索引 ${(performance.now() - t0).toFixed(0)} ms　L1 ${d1.size} 部件、深層 ${deep.size} 部件\n`);

const CH = { 口: 0x53e3, 木: 0x6728, 隹: 0x96b9, 日: 0x65e5 };

function nOf(m: Map<number, number[]>, cp: number) { return (m.get(cp) ?? []).length; }

/** 走完整棵引用樹數 target 出現幾次 */
function countIn(i: number, target: number, depth = 0): number {
  if (depth > 40) return 0;
  let n = 0;
  for (const s of L.glyphs[i]!.strokes) {
    if (s.kind !== 99 || s.ref === null) continue;
    if (codePointOf(L, s.ref) === target) n++;
    n += countIn(s.ref, target, depth + 1);
  }
  return n;
}

function inter(m: Map<number, number[]>, cps: number[]): number[] {
  let cur: number[] | null = null;
  for (const cp of cps) {
    const a = m.get(cp) ?? [];
    if (cur === null) { cur = a.slice(); continue; }
    const s = new Set(a);
    cur = cur.filter((i) => s.has(i));
  }
  return cur ?? [];
}

console.log("=== 單部件：L1 vs 深層 ===");
for (const [n, cp] of Object.entries(CH)) {
  console.log(`  ${n}：L1 ${nOf(d1, cp).toLocaleString()}　深層 ${nOf(deep, cp).toLocaleString()}`);
}

console.log("\n=== 多部件交集 ===");
for (const [label, cps] of [["口木", [CH.口, CH.木]], ["口口", [CH.口, CH.口]], ["木隹", [CH.木, CH.隹]]] as [string, number[]][]) {
  const l1 = inter(d1, cps).length;
  const dp = inter(deep, cps).length;
  console.log(`  ${label}：L1 ${l1.toLocaleString()}　深層 ${dp.toLocaleString()}`);
}

console.log("\n=== 重複部件：口 出現 >= k 次 ===");
{
  const cand = deep.get(CH.口) ?? [];
  const t = performance.now();
  const hist = new Map<number, number>();
  const keep: number[][] = [];
  for (const i of cand) {
    const c = countIn(i, CH.口);
    hist.set(c, (hist.get(c) ?? 0) + 1);
    if (!keep[c]) keep[c] = [];
    if (keep[c]!.length < 8) keep[c]!.push(codePointOf(L, i)!);
  }
  console.log(`  掃 ${cand.length.toLocaleString()} 個候選 ${(performance.now() - t).toFixed(0)} ms`);
  for (const k of [1, 2, 3, 4]) {
    console.log(`   >= ${k}：${[...hist.entries()].filter(([c]) => c >= k).reduce((a, [, v]) => a + v, 0)} 個` +
      (keep[k] ? `　例：${keep[k]!.map((c) => String.fromCodePoint(c)).join(" ")}` : ""));
  }
}

console.log("\n=== 「呆」「杏」只有 1 個口，「器」「哭」有 2 個 ===");
{
  for (const [n, cp] of [["呆", 0x5446], ["杏", 0x674f], ["器", 0x5668], ["哭", 0x54ed]] as [string, number][]) {
    const i = indexOfCodePoint(L, cp)!;
    console.log(`  ${n}：口×${countIn(i, CH.口)}　木×${countIn(i, CH.木)}`);
  }
}
