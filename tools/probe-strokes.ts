#!/usr/bin/env bun
/**
 * probe-strokes.ts — 筆劃數到底怎麼算才對。
 *
 * 疑問：遞迴數 KAGE 的線段得到 口=4、日=5、器=19、哭=12，
 * 但傳統筆劃是 口=3、日=4、器=16、哭=10。差在哪？
 *
 * 用法: bun run tools/probe-strokes.ts
 */
import { resolve } from "node:path";
import { indexOfCodePoint, codePointOf, displayName, keyOfIdx, isPlainIdeograph } from "./lib-format.ts";
import { refSlotsOf } from "./free-compose.ts";
import type { Library } from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"));
const L: Library = lib;

for (const cp of [0x53e3, 0x65e5, 0x66f0, 0x6728, 0x4e00, 0x4e8c, 0x4e09, 0x5668, 0x54ed]) {
  const i = indexOfCodePoint(L, cp);
  if (i === undefined) continue;
  const g = L.glyphs[i]!;
  const kinds: string[] = [];
  for (const s of g.strokes) {
    if (s.kind === 99) kinds.push("部件(" + (codePointOf(L, s.ref!) !== undefined
      ? "U+" + codePointOf(L, s.ref!)!.toString(16).toUpperCase() : displayName(L, s.ref!)) + ")");
    else kinds.push("線" + s.kind);
  }
  console.log(`U+${cp.toString(16).toUpperCase()} ${String.fromCodePoint(cp)}  ${displayName(L, i)}`);
  console.log(`   ${g.strokes.length} 筆：${kinds.join(" ")}`);
}

console.log("\n=== 數字 x 的線段數（KAGE 的 kind 1..98）分佈 ===");
{
  const h = new Map<number, number>();
  for (let i = 0; i < L.glyphs.length; i++) {
    for (const s of L.glyphs[i]!.strokes) {
      if (s.kind === 99) continue;
      h.set(s.kind, (h.get(s.kind) ?? 0) + 1);
    }
  }
  console.log("   " + [...h.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => k + ":" + v).join("  "));
}

console.log("\n=== 一個字形裡「同一根線」會不會被拆成兩段？看 口 的座標 ===");
{
  const i = indexOfCodePoint(L, 0x53e3)!;
  const g = L.glyphs[i]!;
  for (const s of g.strokes) {
    if (s.kind === 99) { console.log("   部件", displayName(L, s.ref!)); continue; }
    const a = (g as any).points ? "?" : "";
    void a;
    console.log(`   線${s.kind}`, JSON.stringify(s).slice(0, 200));
  }
}

console.log("\n=== 深層部件索引：建起來要多久、多大 ===");
{
  const t = performance.now();
  const deep = new Map<number, number[]>();
  const seen = new Set<number>();
  let edges = 0;
  for (let i = 0; i < L.glyphs.length; i++) {
    if (!isPlainIdeograph(L, i)) continue;
    seen.clear();
    const stack: number[] = [];
    for (const s of L.glyphs[i]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
    while (stack.length) {
      const j = stack.pop()!;
      if (seen.has(j)) continue;
      seen.add(j);
      const cp = codePointOf(L, j);
      if (cp) {
        edges++;
        const a = deep.get(cp);
        if (a) a.push(i); else deep.set(cp, [i]);
      }
      for (const s of L.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
    }
  }
  const ms = performance.now() - t;
  console.log(`   ${deep.size.toLocaleString()} 個部件、${edges.toLocaleString()} 條邊、${ms.toFixed(0)} ms`);
  console.log(`   粗估記憶體 ${(edges * 4 / 1048576).toFixed(1)} MB`);
  for (const [n, cp] of [["口", 0x53e3], ["木", 0x6728], ["吅", 0x5405]] as [string, number][]) {
    console.log(`   深層含「${n}」的字：${(deep.get(cp) ?? []).length} 個`);
  }
  const kouDeep = new Set(deep.get(0x53e3) ?? []);
  for (const [n, cp] of [["器", 0x5668], ["哭", 0x54ed], ["呆", 0x5446], ["杏", 0x674f]] as [string, number][]) {
    const gi = indexOfCodePoint(L, cp)!;
    console.log(`   ${n} 深層含口？ ${kouDeep.has(gi)}`);
  }
}

console.log("\n=== 「口」出現次數（走完整棵樹數節點）===");
{
  function countCp(i: number, target: number, seen: Set<number>, depth = 0): number {
    if (depth > 40) return 0;
    let n = 0;
    for (const s of L.glyphs[i]!.strokes) {
      if (s.kind !== 99 || s.ref === null) continue;
      if (codePointOf(L, s.ref) === target) n++;
      n += countCp(s.ref, target, seen, depth + 1);
    }
    return n;
  }
  for (const [n, cp] of [["器", 0x5668], ["哭", 0x54ed], ["呆", 0x5446], ["杏", 0x674f], ["品", 0x54c1]] as [string, number][]) {
    const gi = indexOfCodePoint(L, cp)!;
    console.log(`   ${n} U+${cp.toString(16).toUpperCase()}：口 出現 ${countCp(gi, 0x53e3, new Set())} 次`);
  }
}
