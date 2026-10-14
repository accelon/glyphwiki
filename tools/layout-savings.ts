// layout-savings.ts — 量測「版面模板化」對精簡庫大小的實際影響
//
// 做法：把每個字形的「筆畫序列」正規化成一個 key：
//   * 有筆畫的終端節點 → 只記 (kind, width, style, 座標)   ← 這是要存的內容
//   * 引用節點        → 記 (框, 伸縮)                       ← 這是可模板化的部分
// 然後統計「有多少個引用節點」與「有多少種相異 (結構+框) 模板」。
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";
import type { Library, Glyph } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

const q = (v: number) => Math.round(v / 2) * 2; // 量化到 2 單位（容忍些許框差）

/** 一個字形的「結構模板 key」：遞迴的 (框, 伸縮, 子模板) */
function templateKey(g: Glyph, depth = 0, seen = new Set<number>()): string {
  const refs = g.strokes.filter((s) => s.kind === 99);
  if (refs.length === 0) return "T"; // 終端
  const parts: string[] = [];
  for (const s of refs) {
    const b = s.box!;
    const st = s.stretch!;
    const boxKey = `${q(b[0]!)},${q(b[1]!)},${q(b[2]!)},${q(b[3]!)}:${st[0]},${st[1]},${st[2]},${st[3]}`;
    let childKey = "";
    if (depth < 1 && s.ref !== null && !seen.has(s.ref)) {
      const s2 = new Set(seen);
      s2.add(s.ref!);
      const ck = templateKey(lib.glyphs[s.ref]!, depth + 1, s2);
      if (ck !== "T") childKey = "[" + ck + "]";
    }
    parts.push(boxKey + childKey);
  }
  return parts.join("|");
}

let totalRefs = 0;
let totalGlyphsWithRefs = 0;
const templates = new Map<string, number>();

for (let i = 0; i < lib.names.length; i++) {
  const g = lib.glyphs[i]!;
  const refs = g.strokes.filter((s) => s.kind === 99);
  if (refs.length === 0) continue;
  totalGlyphsWithRefs++;
  totalRefs += refs.length;
  const k = templateKey(g);
  if (k !== "T") templates.set(k, (templates.get(k) ?? 0) + 1);
}

console.log(`有引用節點的字形：${totalGlyphsWithRefs.toLocaleString()}`);
console.log(`引用節點總數：${totalRefs.toLocaleString()}`);
console.log(`相異結構模板（量化到 2 單位）：${templates.size.toLocaleString()}`);
console.log(`平均每個模板重用：${(totalGlyphsWithRefs / templates.size).toFixed(1)} 次\n`);

// 目前每個引用節點實際佔用的位元組（build-library.ts 的編碼）：
//   kind(1) + ref 索引(varint, 約2) + isFull(1) + [框 4×zigzag(varint, 約1~2)] + noStretch(1) + [伸縮 4×varint]
// 滿格框時框只佔 1 byte 的旗標；否則 4 個值。
const bytesPerRefNow = (s: any): number => {
  const isFull = s.box[0] === 0 && s.box[1] === 0 && s.box[2] === 200 && s.box[3] === 200;
  const noStretch = s.stretch[0] === 0 && s.stretch[1] === 0 && s.stretch[2] === 0 && s.stretch[3] === 0;
  let n = 1 + 2 + 1; // kind + ref 索引 + isFull
  if (!isFull) n += 4 * 1.5; // 框 4 個 varint（量化後多為 1~2 bytes）
  n += 1; // noStretch
  if (!noStretch) n += 4 * 1.5;
  return n;
};

let refBytesNow = 0;
for (let i = 0; i < lib.names.length; i++) {
  for (const s of lib.glyphs[i]!.strokes) {
    if (s.kind === 99) refBytesNow += bytesPerRefNow(s);
  }
}

// 模板化後：每個字形只存「模板索引（約 2 bytes）+ 各子部件替換的字形索引（2 bytes × 引用數）」
// 模板本身只存 templates.size 份。
const tmplBytes = templates.size * 20; // 每個模板估 20 bytes（結構 + 框 + 伸縮）
const perGlyphBytes = totalGlyphsWithRefs * 2; // 模板索引
const perRefBytes = totalRefs * 2;             // 每個引用的替換目標索引
const refBytesAfter = tmplBytes + perGlyphBytes + perRefBytes;

const mb = (n: number) => (n / 1048576).toFixed(2) + " MB";
console.log("=== 引用節點的位元組 ===");
console.log(`  目前（每筆自帶框與伸縮）：${mb(refBytesNow)}`);
console.log(`  模板化後：模板表 ${mb(tmplBytes)} + 每字模板索引 ${mb(perGlyphBytes)} + 每引用替換索引 ${mb(perRefBytes)}`);
console.log(`                        = ${mb(refBytesAfter)}`);
console.log(`  節省：${mb(refBytesNow - refBytesAfter)}（${(100 * (1 - refBytesAfter / refBytesNow)).toFixed(0)}%）`);

console.log(`\n=== 對整體庫的影響（目前未壓縮 2.38 MB、gzip 1.01 MB）===`);
console.log(`  引用節點佔目前庫的 ${(100 * refBytesNow / 2494265).toFixed(0)}%`);
