#!/usr/bin/env bun
/**
 * grail-fit-optimize.ts — 用參考圖反推三個替換框，看「同一個引擎能靠框走多近」。
 *
 * 為什麼要做：`邏羅寶貝𩀨從䞃致招` 的語意已經定案（由內而外四步），
 * 唯一還沒定的是**每一步用哪個框**。框是連續參數，就讓它自己找——
 * 座標下降，每一步只掃一個座標，用「容許位移的 IoU」當分數。
 *
 * 三個框（各自在**父字形的畫布座標**裡）：
 *   bei  ：寶 的 貝 → 𩀨
 *   cong ：𩀨 的 從 → (䞃 的 致 → 招)
 *   zhao ：䞃 的 致 → 招
 * （邏 的 羅 → 寶 那一步固定沿用人工框 [47,3,197,175]——參考圖的上半已經對得很準。）
 *
 * 用法: bun run tools/grail-fit-optimize.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { toKageData, isVariantOfCp, keyOfIdx, indexOfChar } from "./lib-format.ts";
import type { Library, Glyph } from "./lib-format.ts";
import { loadLibrary, DEFAULT_LIB } from "./lib-load.ts";
import { ensureEngine } from "./compose-fit.ts";
import { rasterize } from "./raster.ts";

const ROOT = resolve(import.meta.dir, "..");
ensureEngine();
const { lib } = loadLibrary(resolve(ROOT, DEFAULT_LIB));
const idxOf = (c: string) => indexOfChar(lib, c);

// ---------------------------------------------------------------- 參考圖 + 容許位移的 IoU

function readPgm(path: string): Float32Array {
  const buf = readFileSync(path);
  let p = 0;
  const tok = () => {
    while (p < buf.length) {
      if (buf[p] === 0x23) { while (p < buf.length && buf[p] !== 0x0a) p++; }
      else if (buf[p]! <= 0x20) p++; else break;
    }
    const s = p;
    while (p < buf.length && buf[p]! > 0x20) p++;
    return Buffer.from(buf.subarray(s, p)).toString("latin1");
  };
  if (tok() !== "P5") throw new Error("不是 P5");
  const w = Number(tok()), h = Number(tok());
  tok(); p++;
  const px = buf.subarray(p, p + w * h);
  const cov = new Float32Array(w * h);
  for (let i = 0; i < cov.length; i++) cov[i] = 1 - px[i]! / 255;
  return cov;
}
function dilate(cov: Float32Array, size: number, r: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let m = 0;
    for (let dy = -r; dy <= r && m < 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= size) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= size) continue;
        if (cov[yy * size + xx]! > m) m = cov[yy * size + xx]!;
      }
    }
    out[y * size + x] = m;
  }
  return out;
}
const iouOf = (a: Float32Array, b: Float32Array) => {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) { i += Math.min(a[k]!, b[k]!); u += Math.max(a[k]!, b[k]!); }
  return u > 0 ? i / u : 1;
};
const refCov = readPgm(resolve(ROOT, "out/ref/flat.pgm"));
const REF_D1 = dilate(refCov, 200, 1);
const REF_D2 = dilate(refCov, 200, 2);

// ---------------------------------------------------------------- 組字

function fork(L: Library) {
  const glyphs: Glyph[] = L.glyphs.map((g) => ({ tight: g.tight, strokes: g.strokes }));
  const lib: Library = { ...L, glyphs };
  if (L.names) lib.names = L.names.slice();
  return { lib, glyphs };
}
function findSlot(L: Library, base: number, oldCp: number) {
  const seen = new Set<number>();
  const stack = [base];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i]!;
    for (let si = 0; si < g.strokes.length; si++) {
      const s = g.strokes[si]!;
      if (s.kind === 99 && s.ref !== null && isVariantOfCp(L, s.ref, oldCp)) return { parent: i, strokeIx: si };
    }
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  return null;
}
function replace(L: Library, base: number, oldCh: string, newIdx: number, box: number[]) {
  const slot = findSlot(L, base, oldCh.codePointAt(0)!)!;
  const { lib: L2, glyphs } = fork(L);
  const p0 = glyphs[slot.parent]!;
  const st = p0.strokes[slot.strokeIx]!;
  const strokes = p0.strokes.slice();
  strokes[slot.strokeIx] = { ...st, ref: newIdx, box: box as number[], stretch: [0, 0, 0, 0] };
  glyphs[slot.parent] = { tight: p0.tight, strokes };
  return { lib: L2, base };
}

type Boxes = { bei: number[]; cong: number[]; zhao: number[] };
/** 資料庫裡的原始框（人工資產），當作最佳化的起點 */
const ORIG: Boxes = { bei: [0, 49, 200, 196], cong: [75, 0, 195, 200], zhao: [64, 0, 194, 200] };
/** 邏 的 羅 → 寶：固定不動（參考圖上半已經很準） */
const LUO_BOX = [47, 3, 197, 175];

function build(b: Boxes): { lib: Library; idx: number } {
  const s1 = replace(lib, idxOf("䞃")!, "致", idxOf("招")!, b.zhao);
  let cur = s1.lib, child = idxOf("䞃")!;
  const r2 = replace(cur, indexOfChar(cur, "𩀨")!, "從", child, b.cong);
  cur = r2.lib; child = r2.base;
  const r3 = replace(cur, indexOfChar(cur, "寶")!, "貝", child, b.bei);
  cur = r3.lib; child = r3.base;
  const b4 = indexOfChar(cur, "邏")!;
  const r4 = replace(cur, b4, "羅", child, LUO_BOX);
  return { lib: r4.lib, idx: b4 };
}

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

let evalCount = 0;
function score(b: Boxes): { d1: number; d2: number } {
  evalCount++;
  const r = build(b);
  const cov = rasterize(kageOf(r.lib, r.idx), keyOfIdx(r.lib, r.idx), 200, 1).cov;
  return { d1: iouOf(dilate(cov, 200, 1), REF_D1), d2: iouOf(dilate(cov, 200, 2), REF_D2) };
}

// ---------------------------------------------------------------- 座標下降

let cur: Boxes = { bei: [...ORIG.bei], cong: [...ORIG.cong], zhao: [...ORIG.zhao] };
let curScore = score(cur);
console.log(`起點（資料庫原框）：dil1=${curScore.d1.toFixed(4)}  dil2=${curScore.d2.toFixed(4)}`);
console.log(`  寶的貝→𩀨 框[${cur.bei.join(",")}]　𩀨的從→䞃 框[${cur.cong.join(",")}]　䞃的致→招 框[${cur.zhao.join(",")}]`);

const KEYS: (keyof Boxes)[] = ["bei", "cong", "zhao"];
for (let round = 0; round < 6; round++) {
  const step = [40, 20, 10, 6, 3, 1][round]!;
  let improved = false;
  for (const k of KEYS) {
    for (let ci = 0; ci < 4; ci++) {
      for (const delta of [step, -step, step / 2, -step / 2]) {
        const trial: Boxes = { bei: [...cur.bei], cong: [...cur.cong], zhao: [...cur.zhao] };
        trial[k][ci] = Math.round(trial[k][ci]! + delta);
        // 框必須有正的面積
        if (trial[k][2]! - trial[k][0]! < 20 || trial[k][3]! - trial[k][1]! < 20) continue;
        const s = score(trial);
        if (s.d2 > curScore.d2 + 1e-6) { cur = trial; curScore = s; improved = true; }
      }
    }
  }
  console.log(`  第 ${round + 1} 輪（步長 ${step}）：dil1=${curScore.d1.toFixed(4)}  dil2=${curScore.d2.toFixed(4)}${improved ? "" : "（無改善，停）"}`);
  if (!improved) break;
}

console.log(`\n最佳（${evalCount} 次評估）：`);
console.log(`  寶的貝→𩀨   框[${cur.bei.join(",")}]`);
console.log(`  𩀨的從→䩃  框[${cur.cong.join(",")}]`.replace("䩃", "䞃"));
console.log(`  䞃的致→招   框[${cur.zhao.join(",")}]`);
console.log(`  dil1=${curScore.d1.toFixed(4)}  dil2=${curScore.d2.toFixed(4)}`);

// ---------------------------------------------------------------- 輸出對照圖

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};
function grayPng(w: number, h: number, gray: Uint8Array): Uint8Array {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; raw.set(gray.subarray(y * w, (y + 1) * w), y * (w + 1) + 1); }
  const ihdr = new Uint8Array(13);
  { const dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const q of parts) { out.set(q, p); p += q.length; }
  return out;
}

function covOf(b: Boxes): Float32Array {
  const r = build(b);
  return rasterize(kageOf(r.lib, r.idx), keyOfIdx(r.lib, r.idx), 200, 1).cov;
}
const panels = [
  { cov: refCov },
  { cov: covOf(ORIG) },
  { cov: covOf(cur) },
];
const W = panels.length * 210 + 10, H = 210;
const gray = new Uint8Array(W * H).fill(255);
panels.forEach((p, i) => {
  const x0 = 10 + i * 210;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
    gray[(y + 5) * W + x0 + x] = Math.round(255 * (1 - Math.min(1, p.cov[y * 200 + x]!)));
  }
  for (let y = 0; y < 200; y++) { gray[(y + 5) * W + x0] = 150; gray[(y + 5) * W + x0 + 199] = 150; }
  for (let x = 0; x < 200; x++) { gray[5 * W + x0 + x] = 150; gray[204 * W + x0 + x] = 150; }
});
writeFileSync(resolve(ROOT, "out/grail-optimized.png"), grayPng(W, H, gray));
console.log(`\n已寫出 out/grail-optimized.png（左：參考圖　中：原框　右：最佳化框）`);
