#!/usr/bin/env bun
/**
 * grail-box-sweep.ts — 用參考圖反推「貝 → 𩀨」那一步該用多大的框。
 *
 * 動機：Ext B 進庫之後，`邏羅寶貝𩀨從䞃致招` 已經組得出來，但成品的下半
 * （隹／貝／招）比參考圖**高**了一大截。既然只有一個自由參數在主導，
 * 就把它掃過一遍，用「容許位移的 IoU」挑，而不是憑眼睛調。
 *
 * 其他的框都沿用人工資產（keep），只動 `寶 的 貝 → 𩀨` 的框。
 *
 * 用法: bun run tools/grail-box-sweep.ts
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

// ---------------------------------------------------------------- 參考圖

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
const refCov = readPgm(resolve(ROOT, "out/ref/flat.pgm"));

/** 容許位移的 IoU：先各自膨脹 r 格再比，避免 1~2 格錯位就把細筆畫判死 */
function dilate(cov: Float32Array, size: number, r: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
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
  }
  return out;
}
const iouOf = (a: Float32Array, b: Float32Array) => {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) { i += Math.min(a[k]!, b[k]!); u += Math.max(a[k]!, b[k]!); }
  return u > 0 ? i / u : 1;
};
const REF1 = dilate(refCov, 200, 1);
const REF2 = dilate(refCov, 200, 2);

// ---------------------------------------------------------------- 組字（可指定框）

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
function replace(L: Library, base: number, oldCh: string, newIdx: number, box?: number[]) {
  const slot = findSlot(L, base, oldCh.codePointAt(0)!)!;
  const { lib: L2, glyphs } = fork(L);
  const p0 = glyphs[slot.parent]!;
  const st = p0.strokes[slot.strokeIx]!;
  const strokes = p0.strokes.slice();
  strokes[slot.strokeIx] = { ...st, ref: newIdx, box: (box ?? st.box) as number[], stretch: [0, 0, 0, 0] };
  glyphs[slot.parent] = { tight: p0.tight, strokes };
  return { lib: L2, base };
}

function build(box: number[] | undefined) {
  // 由內而外：䞃 的 致→招、𩀨 的 從→(䞃)、寶 的 貝→(𩀨,指定框)、邏 的 羅→(寶)
  const s1 = replace(lib, idxOf("䞃")!, "致", idxOf("招")!);
  let cur = s1.lib, child = idxOf("䞃")!;
  {
    const b = indexOfChar(cur, "𩀨")!;
    const r = replace(cur, b, "從", child);
    cur = r.lib; child = b;
  }
  {
    const b = indexOfChar(cur, "寶")!;
    const r = replace(cur, b, "貝", child, box);
    cur = r.lib; child = b;
  }
  const b = indexOfChar(cur, "邏")!;
  const r = replace(cur, b, "羅", child);
  return { lib: r.lib, idx: b };
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

const cache = new Map<string, { d1: number; d2: number }>();
function score(box: number[] | undefined): { d1: number; d2: number } {
  const key = box ? box.join(",") : "keep";
  const c = cache.get(key);
  if (c) return c;
  const r = build(box);
  const cov = rasterize(kageOf(r.lib, r.idx), keyOfIdx(r.lib, r.idx), 200, 1).cov;
  const v = { d1: iouOf(dilate(cov, 200, 1), REF1), d2: iouOf(dilate(cov, 200, 2), REF2) };
  cache.set(key, v);
  return v;
}

// ---------------------------------------------------------------- 掃描

const base = score(undefined);
console.log(`沿用原框 [0,49,200,196]：dil1=${base.d1.toFixed(4)}  dil2=${base.d2.toFixed(4)}\n`);

console.log("第一階段：x 固定滿寬 [0..200]，掃 y1 × y2（候選框的上下界）");
let best = { box: [0, 49, 200, 196], ...base };
const grid: { box: number[]; d1: number; d2: number }[] = [];
for (const y1 of [40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140]) {
  for (const y2 of [150, 160, 170, 180, 190, 200, 210]) {
    if (y2 - y1 < 40) continue;
    const box = [0, y1, 200, y2];
    const s = score(box);
    grid.push({ box, ...s });
    if (s.d2 > best.d2) best = { box, ...s };
  }
}
grid.sort((a, b) => b.d2 - a.d2);
for (const g of grid.slice(0, 8)) {
  console.log(`  框[${g.box.join(",")}]  dil1=${g.d1.toFixed(4)}  dil2=${g.d2.toFixed(4)}`);
}
console.log(`\n第一階段最佳 框[${best.box.join(",")}]  dil1=${best.d1.toFixed(4)}  dil2=${best.d2.toFixed(4)}`);

console.log("\n第二階段：在最佳框附近掃 x1 × x2（以及小幅 y 微調）");
const b0 = best.box;
let best2 = { ...best };
for (const x1 of [-30, -20, -10, 0, 10, 20, 30]) {
  for (const x2 of [160, 175, 190, 200, 210, 220]) {
    for (const dy1 of [-15, -10, -5, 0, 5, 10, 15]) {
      for (const dy2 of [-15, -10, -5, 0, 5, 10, 15]) {
        const box = [x1, b0[1]! + dy1, x2, b0[3]! + dy2];
        if (box[3]! - box[1]! < 40) continue;
        const s = score(box);
        if (s.d2 > best2.d2) best2 = { box, ...s };
      }
    }
  }
}
console.log(`最佳 框[${best2.box.join(",")}]  dil1=${best2.d1.toFixed(4)}  dil2=${best2.d2.toFixed(4)}`);

// 輸出最好的一張，並跟原框版本並排
const mk = (box: number[] | undefined) => {
  const r = build(box);
  return rasterize(kageOf(r.lib, r.idx), keyOfIdx(r.lib, r.idx), 200, 1).cov;
};
const a = mk(undefined), b = mk(best2.box);
const W = 200 * 4 + 50, H = 210;
const panel = new Uint8Array(W * H).fill(255);
const put = (x0: number, cov: Float32Array) => {
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
    panel[(y + 5) * W + x0 + x] = Math.round(255 * (1 - Math.min(1, cov[y * 200 + x]!)));
  }
  for (let y = 0; y < 200; y++) { panel[(y + 5) * W + x0] = 160; panel[(y + 5) * W + x0 + 199] = 160; }
  for (let x = 0; x < 200; x++) { panel[5 * W + x0 + x] = 160; panel[204 * W + x0 + x] = 160; }
};
put(5, refCov); put(210, a); put(415, b);
const parts = [
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
];
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
const raw = new Uint8Array((W + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; raw.set(panel.subarray(y * W, (y + 1) * W), y * (W + 1) + 1); }
const ihdr = new Uint8Array(13);
{ const dv = new DataView(ihdr.buffer); dv.setUint32(0, W); dv.setUint32(4, H); ihdr[8] = 8; }
parts.push(chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array(0)));
const pngOut = new Uint8Array(parts.reduce((s, q) => s + q.length, 0));
{ let p = 0; for (const q of parts) { pngOut.set(q, p); p += q.length; } }
writeFileSync(resolve(ROOT, "out/grail-sweep.png"), pngOut);
console.log(`\n已寫出 out/grail-sweep.png（左：參考圖　中：沿用原框　右：最佳框）`);
