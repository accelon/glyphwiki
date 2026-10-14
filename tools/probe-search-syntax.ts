#!/usr/bin/env bun
/**
 * probe-search-syntax.ts — 查「+ / 數字 多部件」這套語法要怎麼實作之前的偵察。
 *
 * 要回答：
 *   1. 獨體字（沒有任何部件引用）怎麼認？筆劃數怎麼數？
 *   2. 「器」「哭」的直接部件裡有沒有「口」？（決定多部件要比對 L1 還是深層）
 *   3. 「4木曰」真的找得到 U+2320C 嗎？它的部件是 日 還是 曰？剩餘筆劃是不是 4？
 *   4. 遞迴算全庫筆劃數要多久？
 *
 * 用法: bun run tools/probe-search-syntax.ts
 */
import { resolve } from "node:path";
import { indexOfCodePoint, codePointOf, displayName, isPlainIdeograph } from "./lib-format.ts";
import { refSlotsOf } from "./free-compose.ts";
import type { Library } from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";

const ROOT = resolve(import.meta.dir, "..");
const { lib } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"));
const L: Library = lib;

/* ---- 筆劃數：非 99 的筆畫算 1，99 是部件引用就遞迴 ---- */
const memo = new Map<number, number>();
function strokes(i: number, depth = 0): number {
  const hit = memo.get(i);
  if (hit !== undefined) return hit;
  if (depth > 30) return 0;
  let n = 0;
  for (const s of L.glyphs[i]!.strokes) {
    if (s.kind === 99 && s.ref !== null) n += strokes(s.ref, depth + 1);
    else if (s.kind !== 99) n += 1;
  }
  memo.set(i, n);
  return n;
}
function hasRef(i: number): boolean {
  for (const s of L.glyphs[i]!.strokes) if (s.kind === 99 && s.ref !== null) return true;
  return false;
}

function describe(cp: number) {
  const i = indexOfCodePoint(L, cp);
  if (i === undefined) { console.log(`  U+${cp.toString(16).toUpperCase()} 不在庫中`); return; }
  const refs = refSlotsOf(L, i);
  const parts = refs.map((r) => {
    const rcp = codePointOf(L, r.ref);
    return (rcp ? String.fromCodePoint(rcp) + "(U+" + rcp.toString(16).toUpperCase() + ")" : displayName(L, r.ref)) +
      "·" + r.zone + "·" + strokes(r.ref) + "畫";
  });
  console.log(`  U+${cp.toString(16).toUpperCase()} ${String.fromCodePoint(cp)}` +
    `　總 ${strokes(i)} 畫　直接部件 ${refs.length} 個　獨體=${!hasRef(i)}`);
  console.log(`      ${parts.join("  ") || "（純筆畫）"}`);
}

console.log("=== 1. 幾個關鍵字 ===");
for (const cp of [0x2320c, 0x5668, 0x54ed, 0x5446, 0x674f, 0x6728, 0x65e5, 0x66f0, 0x53e3]) describe(cp);

console.log("\n=== 2. 「器」「哭」的直接部件裡有沒有「口」？ ===");
const KOU = 0x53e3;
for (const [name, cp] of [["器", 0x5668], ["哭", 0x54ed], ["呆", 0x5446], ["杏", 0x674f]] as [string, number][]) {
  const i = indexOfCodePoint(L, cp)!;
  const direct = refSlotsOf(L, i).some((r) => codePointOf(L, r.ref) === KOU);
  // 深層：走完整棵引用樹看有沒有 口
  let deep = false;
  const seen = new Set<number>();
  const stack = [i];
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const s of L.glyphs[k]!.strokes) {
      if (s.kind !== 99 || s.ref === null) continue;
      if (codePointOf(L, s.ref) === KOU) deep = true;
      stack.push(s.ref);
    }
  }
  console.log(`  ${name} U+${cp.toString(16).toUpperCase()}：直接部件含口 = ${direct}　引用樹含口 = ${deep}`);
}

console.log("\n=== 3. 「4木曰/日」能不能找到 U+2320C ===");
{
  const i = indexOfCodePoint(L, 0x2320c)!;
  const total = strokes(i);
  const refs = refSlotsOf(L, i);
  const sum = refs.reduce((a, r) => a + strokes(r.ref), 0);
  console.log(`  U+2320C 總筆劃 ${total}　三個部件合計 ${sum}`);
  for (const r of refs) {
    const rcp = codePointOf(L, r.ref);
    console.log(`     ${rcp ? "U+" + rcp.toString(16).toUpperCase() + " " + String.fromCodePoint(rcp) : displayName(L, r.ref)}　${strokes(r.ref)} 畫`);
  }
  const mu = strokes(indexOfCodePoint(L, 0x6728)!);
  const ri = strokes(indexOfCodePoint(L, 0x65e5)!);
  const yue = strokes(indexOfCodePoint(L, 0x66f0)!);
  console.log(`  木 ${mu} 畫、日 ${ri} 畫、曰 ${yue} 畫`);
  console.log(`  若扣掉 木＋日：剩 ${total - mu - ri} 畫`);
  console.log(`  若扣掉 木＋曰：剩 ${total - mu - yue} 畫`);
  const cdp = refs.map((r) => codePointOf(L, r.ref)).find((c) => c === undefined || (c >= 0xe000 && c <= 0xf8ff));
  void cdp;
  console.log(`  第一個部件 cdp-884b 的筆劃 = ${strokes(refs[0]!.ref)} 畫`);
}

console.log("\n=== 4. 全庫遞迴算筆劃數要多久 ===");
{
  const t = performance.now();
  let n = 0;
  for (let i = 0; i < L.glyphs.length; i++) { strokes(i); n++; }
  const ms = performance.now() - t;
  console.log(`  ${n.toLocaleString()} 個字形：${ms.toFixed(0)} ms`);
  const solo: number[] = [];
  for (let i = 0; i < L.glyphs.length; i++) {
    const cp = codePointOf(L, i);
    if (!cp || !isPlainIdeograph(L, i) || hasRef(i)) continue;
    solo.push(strokes(i));
  }
  const hist = new Map<number, number>();
  for (const s of solo) hist.set(s, (hist.get(s) ?? 0) + 1);
  console.log(`  獨體字（一般漢字、無部件引用）：${solo.length.toLocaleString()} 個`);
  console.log(`  筆劃分佈：` + [...hist.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, v]) => k + "畫:" + v).join("  "));
  console.log(`  4 畫的獨體字：${hist.get(4) ?? 0} 個`);
}

console.log("\n=== 5. 多部件交集：口 ∩ 木（L1）===");
{
  const comp = new Map<number, number[]>();
  for (let i = 0; i < L.glyphs.length; i++) {
    if (!isPlainIdeograph(L, i)) continue;
    for (const s of refSlotsOf(L, i)) {
      const cp = codePointOf(L, s.ref);
      if (!cp) continue;
      const a = comp.get(cp);
      if (a) a.push(i); else comp.set(cp, [i]);
    }
  }
  const kou = comp.get(KOU) ?? [], mu = comp.get(0x6728) ?? [];
  const sMu = new Set(mu);
  const both = kou.filter((i) => sMu.has(i)).map((i) => codePointOf(L, i)!);
  console.log(`  口 ${kou.length} 個、木 ${mu.length} 個、交集 ${both.length} 個`);
  console.log(`  交集前 20 個：${both.slice(0, 20).map((c) => String.fromCodePoint(c) + " U+" + c.toString(16).toUpperCase()).join("  ")}`);
  for (const [n, cp] of [["呆", 0x5446], ["杏", 0x674f]] as [string, number][]) {
    console.log(`  ${n} 在交集裡？ ${both.includes(cp)}`);
  }
  const kou2 = new Set(kou);
  const dup = kou.filter((i) => {
    let k = 0;
    for (const s of refSlotsOf(L, i)) if (codePointOf(L, s.ref) === KOU) k++;
    return k >= 2;
  });
  void kou2;
  console.log(`  直接引用「口」兩次以上的字：${dup.length} 個 → ${dup.slice(0, 12).map((i) => String.fromCodePoint(codePointOf(L, i)!)).join(" ")}`);
  for (const [n, cp] of [["器", 0x5668], ["哭", 0x54ed]] as [string, number][]) {
    console.log(`  ${n} 在「兩個口」裡？ ${dup.some((i) => codePointOf(L, i) === cp)}`);
  }
}
