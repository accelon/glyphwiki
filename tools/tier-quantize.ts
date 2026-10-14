// tier-quantize.ts — 分層量化實驗（修正基準 + 頻率分層 + 視覺代價）
//
// 分層構想（使用者提出）：
//   Tier 1 = 常用字（約 1500）+ 構成它們所需的部件 → 座標保持全精度（人工手調）
//   Tier 2 = 其餘罕用字（占 70~80%）→ 座標量化，犧牲看不到的美觀度換壓縮
//
// 這支工具量：各量化格數下的 gzip 大小、以及 Tier 2 字形在 64×64 下的視覺差異。
import { readFileSync } from "node:fs";
import { decodeLibrary } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

// ---- 修正基準：用真正的後綴表索引（先前用 pushU(m[2]?1:0) 會低估） ----
const SUFFIXES = [...new Set(lib.names.map((n) => {
  const m = /^u[0-9a-f]{4,6}(-.*)?$/i.exec(n);
  return m && m[1] ? m[1] : null;
}).filter((x): x is string => x !== null))];
const suffixIx = new Map(SUFFIXES.map((s, i) => [s, i] as const));

const quant = (v: number, grid: number) => grid > 0 ? Math.round((v / 200) * grid) * (200 / grid) : v;

/**
 * 重新編碼整個庫。
 * @param qOf 依「字形索引」決定該字形的量化格數（0 = 不量化）
 */
function encode(lib: Library, qOf: (gi: number) => number) {
  const bin: number[] = [];
  const pushU = (n: number) => { let v = n >>> 0; while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; } bin.push(v); };
  const pushS = (n: number) => { let v = ((n << 1) ^ (n >> 31)) >>> 0; while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; } bin.push(v); };

  pushU(lib.names.length);
  pushU(SUFFIXES.length);
  for (const s of SUFFIXES) { pushU(s.length); for (const ch of s) pushU(ch.charCodeAt(0)); }
  for (const n of lib.names) {
    const m = /^u([0-9a-f]{4,6})(-.*)?$/i.exec(n);
    if (m) { pushU(parseInt(m[1]!, 16)); pushU(m[2] ? suffixIx.get(m[2])! + 1 : 0); }
    else { pushU(0); pushU(n.length); for (const ch of n) pushU(ch.charCodeAt(0)); }
  }
  for (let gi = 0; gi < lib.glyphs.length; gi++) {
    const g = lib.glyphs[gi]!;
    const q = qOf(gi);
    const mq = (v: number) => quant(v, q);
    pushU(g.strokes.length);
    for (const s of g.strokes) {
      pushU(s.kind);
      if (s.kind === 99) {
        const b = s.box!, st = s.stretch!;
        const isFull = b[0] === 0 && b[1] === 0 && b[2] === 200 && b[3] === 200;
        const noStretch = st[0] === 0 && st[1] === 0 && st[2] === 0 && st[3] === 0;
        pushU(s.ref!);   // ← 先前漏了這一段（ref 索引，117,120 筆共 272,017 bytes）
        pushU((isFull ? 1 : 0) | (noStretch ? 2 : 0));
        if (!isFull) for (const v of b) pushS(mq(v));
        if (!noStretch) for (const v of st) pushS(mq(v));   // 伸縮也漏了
      } else {
        pushS(s.width);
        pushS(s.style);
        for (let i = 0; i < 8; i++) pushS(mq(s.points[i]!));
      }
    }
  }
  const buf = Buffer.from(bin);
  return { raw: buf.length, gz: Bun.gzipSync(buf, { level: 9 }).length };
}

// ---- 基準驗證 ----
const base = encode(lib, () => 0);
const actual = readFileSync(`${D}/out/lib-cjk.bin`).length;
console.log(`=== 基準驗證 ===`);
console.log(`  重編碼 ${base.raw.toLocaleString()} bytes vs 實際檔案 ${actual.toLocaleString()} bytes` +
  `  ${base.raw === actual ? "✓ 完全一致" : "✗ 差 " + (base.raw - actual)}`);
console.log(`  gzip ${(base.gz / 1024).toFixed(0)} KB`);

// ---- 分層：Tier 1 = 常用碼位區 + 它們用到的部件 ----
// 由於取不到字頻表，先用「部件使用度」當代理：
//   被大量字形引用的字形 = 基本部件 → 必屬 Tier 1
const refCount = new Map<number, number>();
for (const g of lib.glyphs) for (const s of g.strokes) {
  if (s.kind === 99 && s.ref !== null) refCount.set(s.ref, (refCount.get(s.ref) ?? 0) + 1);
}

/** 取 Tier 1：URO 基本區 + Ext-A 的碼位字，以及它們的引用閉包（遞迴） */
function buildTier1(limitCp: number, maxRefs: number) {
  const tier1 = new Set<number>();
  const stack: number[] = [];
  lib.names.forEach((n, i) => {
    const m = /^u([0-9a-f]{4,6})$/.exec(n);
    if (!m) return;
    const cp = parseInt(m[1]!, 16);
    if (cp < limitCp) { tier1.add(i); stack.push(i); }
  });
  // 閉包：把 Tier 1 用到的部件也納入
  while (stack.length) {
    const i = stack.pop()!;
    for (const s of lib.glyphs[i]!.strokes) {
      if (s.kind === 99 && s.ref !== null && !tier1.has(s.ref)) {
        if ((refCount.get(s.ref) ?? 0) >= maxRefs) { tier1.add(s.ref); stack.push(s.ref); }
      }
    }
  }
  return tier1;
}

console.log("\n=== 分層設計（用碼位範圍近似常用字）===");
for (const [label, limitCp, maxRefs] of [
  ["URO 全區（U+4E00–9FFF）", 0x9fff, 0],
  ["URO 常用段（U+4E00–9FA5）+ 部件", 0x9fa5, 3],
] as [string, number, number][]) {
  const t1 = buildTier1(limitCp, maxRefs);
  const total = lib.glyphs.length;
  console.log(`  ${label}：Tier1 ${t1.size.toLocaleString()}（${(100 * t1.size / total).toFixed(0)}%）、` +
    `Tier2 ${(total - t1.size).toLocaleString()}（${(100 * (total - t1.size) / total).toFixed(0)}%）`);
}

// ---- 實驗：Tier2 量化、Tier1 不動 ----
const TIER1 = buildTier1(0x9fa5, 3);
console.log("\n=== 實驗：只量化 Tier 2（Tier 1 保持全精度）===");
console.log("  Tier2 格數   未壓縮        gzip      gzip vs 全不量化");
const rows: { q: number; raw: number; gz: number }[] = [];
for (const q of [0, 96, 64, 48, 32]) {
  const r = encode(lib, (gi) => (TIER1.has(gi) ? 0 : q));
  rows.push({ q, ...r });
  const d = ((r.gz - base.gz) / base.gz) * 100;
  console.log(`  ${String(q === 0 ? "不量化" : q + "×" + q).padStart(11)} ${String(r.raw).padStart(10)}  ${String(r.gz).padStart(10)}  ` +
    `${q === 0 ? "基準" : (d >= 0 ? "+" : "") + d.toFixed(1) + "%"}`);
}

// 對照：全部量化
console.log("\n=== 對照：全部字形量化 ===");
for (const q of [64, 32]) {
  const r = encode(lib, () => q);
  const d = ((r.gz - base.gz) / base.gz) * 100;
  console.log(`  全部 ${q}×${q}`.padEnd(15) + `${String(r.raw).padStart(10)}  ${String(r.gz).padStart(10)}  ${d.toFixed(1)}%`);
}

// ---- 視覺代價：Tier 2 在 64×64 下的差異 ----
console.log("\n=== 視覺代價（在 64×64 點陣下的差異）===");
const S = 64;
function rasterize(gi: number, q: number): Uint8Array {
  const img = new Uint8Array(S * S);
  const g = lib.glyphs[gi]!;
  const mq = (v: number) => quant(v, q);
  // 直接把筆畫點畫出來（僅作為量化差異的粗略指標，不含筆寬）
  for (const s of g.strokes) {
    if (s.kind !== 99) {
      const n = s.kind === 1 ? 2 : (s.kind % 100 === 2 || s.kind % 100 === 3 || s.kind % 100 === 4) ? 3 : 4;
      for (let i = 0; i < n; i++) {
        const x = Math.round((mq(s.points[i * 2]!) / 200) * (S - 1));
        const y = Math.round((mq(s.points[i * 2 + 1]!) / 200) * (S - 1));
        if (x >= 0 && y >= 0 && x < S && y < S) img[y * S + x] = 1;
      }
    }
  }
  return img;
}
const samples = ["u4e00", "u571f", "u76df", "u9f8d", "u9f9c", "u2a6d6", "u2b81d", "u3007"];
console.log("  字         量化 64 下有差異的像素數（共 4096）");
for (const n of samples) {
  const gi = lib.names.indexOf(n);
  if (gi < 0) continue;
  const a = rasterize(gi, 0), b = rasterize(gi, 64);
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  console.log(`  ${n.padEnd(10)} ${String(diff).padStart(6)}`);
}
