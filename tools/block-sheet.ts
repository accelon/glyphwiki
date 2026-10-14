#!/usr/bin/env bun
/**
 * block-sheet.ts — 從每個 CJK 區塊挑幾個字畫出來，證明「真的收到了」。
 *
 * `check-lib-compat.ts` 已經用數字證明 12 個區塊都有字；這支是給眼睛看的版本——
 * 每個區塊挑頭／中／尾各幾個**實際有字形**的碼位，畫成一張對照表。
 *
 * 用法: bun run tools/block-sheet.ts [--lib out/lib-cjk-all.bin.gz]
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { keyOfIdx, toKageData, indexOfCodePoint, displayName } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { loadLibrary, DEFAULT_LIB } from "./lib-load.ts";
import { ensureEngine } from "./compose-fit.ts";
import { rasterize } from "./raster.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const li = argv.indexOf("--lib");
ensureEngine();
const { lib } = loadLibrary(resolve(ROOT, li >= 0 && argv[li + 1] ? argv[li + 1]! : DEFAULT_LIB));

const BLOCKS: [string, number, number][] = [
  ["Ext A", 0x3400, 0x4dbf], ["URO", 0x4e00, 0x9fff],
  ["相容區", 0xf900, 0xfaff],
  ["Ext B", 0x20000, 0x2a6df], ["Ext C", 0x2a700, 0x2b73f],
  ["Ext D", 0x2b740, 0x2b81f], ["Ext E", 0x2b820, 0x2ceaf],
  ["Ext F", 0x2ceb0, 0x2ebef], ["Ext I", 0x2ebf0, 0x2ee5f],
  ["相容補充", 0x2f800, 0x2fa1f],
  ["Ext G", 0x30000, 0x3134f], ["Ext H", 0x31350, 0x323af],
];

function kageOf(L: Library, idx: number): any {
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
  return kage;
}

const PER_BLOCK = 6;
const S = 96, LBL = 22, GAP = 6;
const rows: { name: string; cps: number[] }[] = [];
for (const [name, a, b] of BLOCKS) {
  // 頭、中、尾各抓幾個「真的有字形」的碼位
  const present: number[] = [];
  for (let cp = a; cp <= b && present.length < 200; cp++) if (indexOfCodePoint(lib, cp) !== undefined) present.push(cp);
  if (!present.length) { rows.push({ name, cps: [] }); continue; }
  const picks: number[] = [];
  for (let k = 0; k < PER_BLOCK; k++) {
    const at = Math.min(present.length - 1, Math.round((k / (PER_BLOCK - 1)) * (present.length - 1)));
    const cp = present[at]!;
    if (!picks.includes(cp)) picks.push(cp);
  }
  rows.push({ name, cps: picks });
}

const W = 8 + PER_BLOCK * (S + GAP), H = 8 + rows.length * (S + LBL + GAP);
const gray = new Uint8Array(W * H).fill(255);
// 邊框 + 字形（標籤不畫字，交給文字說明；這裡只出圖）
rows.forEach((r, ri) => {
  const y0 = 8 + ri * (S + LBL + GAP);
  r.cps.forEach((cp, ci) => {
    const x0 = 8 + ci * (S + GAP);
    const idx = indexOfCodePoint(lib, cp)!;
    const cov = rasterize(kageOf(lib, idx), keyOfIdx(lib, idx), S, 1).cov;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      gray[(y0 + y) * W + x0 + x] = Math.round(255 * (1 - Math.min(1, cov[y * S + x]!)));
    }
    for (let y = 0; y < S; y++) { gray[(y0 + y) * W + x0] = 200; gray[(y0 + y) * W + x0 + S - 1] = 200; }
    for (let x = 0; x < S; x++) { gray[y0 * W + x0 + x] = 200; gray[(y0 + S - 1) * W + x0 + x] = 200; }
  });
});

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Uint8Array) => {
  const o = new Uint8Array(12 + data.length);
  const v = new DataView(o.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i);
  o.set(data, 8);
  v.setUint32(8 + data.length, crc32(o.subarray(4, 8 + data.length)));
  return o;
};
function grayPng(w: number, h: number, g: Uint8Array): Uint8Array {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; raw.set(g.subarray(y * w, (y + 1) * w), y * (w + 1) + 1); }
  const ih = new Uint8Array(13);
  { const v = new DataView(ih.buffer); v.setUint32(0, w); v.setUint32(4, h); ih[8] = 8; }
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ih), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const q of parts) { out.set(q, p); p += q.length; }
  return out;
}
writeFileSync(resolve(ROOT, "out/cjk-blocks.png"), grayPng(W, H, gray));
console.log(`已寫出 out/cjk-blocks.png（每列一個區塊，各挑 ${PER_BLOCK} 個實際有字形的碼位）\n`);
for (const r of rows) {
  console.log(`  ${r.name.padEnd(9)} ${r.cps.length
    ? r.cps.map((cp) => "U+" + cp.toString(16).toUpperCase() + "(" + displayName(lib, indexOfCodePoint(lib, cp)!) + ")").join("  ")
    : "（這個區塊沒有字）"}`);
}
