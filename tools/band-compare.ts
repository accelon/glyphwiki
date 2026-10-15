#!/usr/bin/env bun
/**
 * band-compare.ts — 「同層讓位」開了／關了的並排對照。
 *
 * 讓位規則（`refitBand`）會改變既有的組字結果：以前是「一律沿用原框」，
 * 新內容比舊部件大很多時就硬塞進去、壓到同層的兄弟。
 * 這是**版面色決定**，不能只看 IoU 或 log 文字，要畫出來看。
 *
 * 用法: bun run tools/band-compare.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { keyOfIdx, toKageData, indexOfChar } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { loadLibrary, DEFAULT_LIB } from "./lib-load.ts";
import { ensureEngine, composeFit } from "./compose-fit.ts";
import { evalSeq } from "./free-compose.ts";
import { rasterize } from "./raster.ts";

const ROOT = resolve(import.meta.dir, "..");
ensureEngine();
const { lib } = loadLibrary(resolve(ROOT, DEFAULT_LIB));

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
const covOf = (L: Library, i: number, S: number) =>
  rasterize(kageOf(L, i), keyOfIdx(L, i), S, 1).cov;

/** 成對讀法（檢視頁的規則），可切換讓位 */
function viaFit(seq: string, band: boolean) {
  const chars = Array.from(seq);
  if (chars.length === 1) {
    const i = indexOfChar(lib, chars[0]!)!;
    return { lib, idx: i };
  }
  const pairs: [string, string][] = [];
  for (let i = 1; i + 1 < chars.length; i += 2) pairs.push([chars[i]!, chars[i + 1]!]);
  const r = composeFit(lib, chars[0]!, pairs, { band });
  if ("error" in r) throw new Error(r.error);
  return { lib: r.lib, idx: r.targetIdx };
}
/** 遞歸讀法（拼形序列），可切換讓位 */
function viaSeq(seq: string, band: boolean) {
  const r = evalSeq(lib, seq, { band });
  if (!r.ok) throw new Error(r.error);
  return { lib: r.lib, idx: r.targetIdx };
}

const CASES: [string, string, (s: string, b: boolean) => { lib: Library; idx: number }][] = [
  ["邏羅寶貝𩀨從䞃致招", "招財進寶 holy grail", viaSeq],
  ["峰夆電雨水", "官方例（峰 的 夆 → 電 的 雨 → 水）", viaSeq],
  ["電雨水", "內層：電 的 雨 → 水", viaSeq],
  ["寶缶支", "已知良好", viaSeq],
  ["街圭舞", "街 的 圭 → 舞", viaSeq],
];

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

const S = 200, PW = S + 10, PH = S + 12;
const rows: { seq: string; note: string; off: Float32Array; on: Float32Array }[] = [];
for (const [seq, note, fn] of CASES) {
  try {
    const a = fn(seq, false), b = fn(seq, true);
    const off = covOf(a.lib, a.idx, S), on = covOf(b.lib, b.idx, S);
    rows.push({ seq, note, off, on });
    // 差異用「著墨像素的比例」表示，比逐格覆蓋率差好讀
    let diff = 0;
    for (let i = 0; i < S * S; i++) if ((off[i]! > 0.5) !== (on[i]! > 0.5)) diff++;
    console.log(`${seq.padEnd(12)} 讓位前後相異的著墨像素 ${(100 * diff / (S * S)).toFixed(2)}%`);
  } catch (e) {
    console.log(`${seq} 失敗：${(e as Error).message}`);
  }
}

const W = 2 * PW + 10, H = rows.length * PH + 10;
const gray = new Uint8Array(W * H).fill(255);
rows.forEach((r, ri) => {
  [r.off, r.on].forEach((cov, ci) => {
    const x0 = 10 + ci * PW, y0 = 10 + ri * PH;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      gray[(y0 + y) * W + x0 + x] = Math.round(255 * (1 - Math.min(1, cov[y * S + x]!)));
    }
    for (let y = 0; y < S; y++) { gray[(y0 + y) * W + x0] = 190; gray[(y0 + y) * W + x0 + S - 1] = 190; }
    for (let x = 0; x < S; x++) { gray[y0 * W + x0 + x] = 190; gray[(y0 + S - 1) * W + x0 + x] = 190; }
  });
});
writeFileSync(resolve(ROOT, "out/band-compare.png"), grayPng(W, H, gray));
console.log("\n已寫出 out/band-compare.png（每一列一例：左＝讓位關、右＝讓位開）");
for (const r of rows) console.log(`  ${r.seq}　${r.note}`);
