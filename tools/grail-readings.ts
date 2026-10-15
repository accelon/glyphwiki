#!/usr/bin/env bun
/**
 * grail-readings.ts — 同一條序列的兩種讀法，實際畫出來比一比。
 *
 * `邏羅寶貝𩀨從䞃致招` 有兩種讀法，兩者「理論上」應該同一個結果：
 *
 *   A. 遞歸（`free-compose.ts` 的 `evalSeq`，`︵…︶` 內的拼形序列語意）
 *        邏 [羅→(寶 [貝→(𩀨 [從→(䞃 [致→招])])])]
 *
 *   B. 成對（`composeFit`，`kage-viewer.html` 目前用的規則）
 *        邏，然後依序（羅→寶）（貝→𩀨）（從→䞃）（致→招）
 *
 * 結果的**構形**一樣，但**版面**不一定：`composeFit` 有「放不進就等比縮小」
 * 的邏輯（步驟 1 判斷形狀與溢出、步驟 2 才算縮放），而 `evalSeq` 一律沿用原框。
 * 所以必須畫出來量，不能只用推理。
 *
 * 用法: bun run tools/grail-readings.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { toKageData, keyOfIdx, indexOfChar, displayName } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { loadLibrary, DEFAULT_LIB } from "./lib-load.ts";
import { ensureEngine, inkIn, composeFit } from "./compose-fit.ts";
import { evalSeq } from "./free-compose.ts";
import { minCrossDistOf } from "./stroke-overlap.ts";
import { rasterize } from "./raster.ts";

const ROOT = resolve(import.meta.dir, "..");
ensureEngine();
const { lib } = loadLibrary(resolve(ROOT, DEFAULT_LIB));
const SEQ = "邏羅寶貝𩀨從䞃致招";

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
function dilate(cov: Float32Array, r: number, size = 200): Float32Array {
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
const REF_D = [0, 1, 2, 3].map((r) => (r === 0 ? refCov : dilate(refCov, r)));

// ---------------------------------------------------------------- 兩種讀法

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

interface Reading { name: string; lib: Library; idx: number; log: string[]; cov: Float32Array }

function score(cov: Float32Array) {
  return [0, 1, 2, 3].map((r) => iouOf(r === 0 ? cov : dilate(cov, r), REF_D[r]!));
}

// A. 遞歸讀法
const a = evalSeq(lib, SEQ);
if (!a.ok) { console.error("A 失敗：" + a.error); process.exit(1); }
const covA = rasterize(kageOf(a.lib, a.targetIdx), keyOfIdx(a.lib, a.targetIdx), 200, 1).cov;

// B. 成對讀法（kage-viewer 目前的規則：第 1 字為主字，其餘每兩字一組）
const chars = Array.from(SEQ);
const pairs: [string, string][] = [];
for (let i = 1; i + 1 < chars.length; i += 2) pairs.push([chars[i]!, chars[i + 1]!]);
const b = composeFit(lib, chars[0]!, pairs);
if ("error" in b) { console.error("B 失敗：" + b.error); process.exit(1); }
const covB = rasterize(kageOf(b.lib, b.targetIdx), keyOfIdx(b.lib, b.targetIdx), 200, 1).cov;

// C. 成對讀法但**關掉同層讓位**（＝改版前的行為，用來對照「疊在一起」是什麼樣子）
const c = composeFit(lib, chars[0]!, pairs, { band: false });
if ("error" in c) { console.error("C 失敗：" + c.error); process.exit(1); }
const covC = rasterize(kageOf(c.lib, c.targetIdx), keyOfIdx(c.lib, c.targetIdx), 200, 1).cov;

const readings: Reading[] = [
  { name: "A 遞歸（evalSeq，拼形序列語意）", lib: a.lib, idx: a.targetIdx, log: a.log, cov: covA },
  { name: "B 成對（composeFit，檢視頁目前規則）", lib: b.lib, idx: b.targetIdx, log: b.log, cov: covB },
  { name: "C 成對、但關掉同層讓位（改版前）", lib: c.lib, idx: c.targetIdx, log: c.log, cov: covC },
];

console.log(`序列 ${SEQ}\n`);
for (const r of readings) {
  const [i0, i1, i2, i3] = score(r.cov);
  const ink = inkIn(r.lib, r.idx);
  let dist: number;
  try { dist = minCrossDistOf(r.lib, r.idx); } catch { dist = NaN; }
  console.log(`=== ${r.name} ===`);
  for (const [k, line] of r.log.entries()) console.log(`  ${k + 1}. ${line}`);
  console.log(`  墨跡 [${[ink.x1, ink.y1, ink.x2, ink.y2].map((v) => v.toFixed(0)).join(",")}]　` +
    `跨部件距離 ${Number.isFinite(dist) ? dist.toFixed(1) : "無"}`);
  console.log(`  與參考圖：IoU ${i0!.toFixed(4)}　±1 ${i1!.toFixed(4)}　±2 ${i2!.toFixed(4)}　±3 ${i3!.toFixed(4)}`);
  // 「招」在成品裡多大（沿整條引用鏈疊起來）
  const zc = indexOfChar(r.lib, "招")!;
  const own = inkIn(r.lib, zc);
  let best: { w: number; h: number } | null = null;
  const walk = (i: number, ax: number, ay: number, seen: Set<number>) => {
    if (seen.has(i)) return;
    const next = new Set(seen); next.add(i);
    for (const s of r.lib.glyphs[i]!.strokes) {
      if (s.kind !== 99 || s.ref === null || !s.box) continue;
      const b2 = s.box;
      const nx = ax * (b2[2]! - b2[0]!) / 200, ny = ay * (b2[3]! - b2[1]!) / 200;
      if (indexOfChar(r.lib, "招") === s.ref || s.ref === zc) {
        const ci = inkIn(r.lib, s.ref);
        const w = Math.abs((ci.x2 - ci.x1) * nx), h = Math.abs((ci.y2 - ci.y1) * ny);
        if (!best || w * h > best.w * best.h) best = { w, h };
      }
      walk(s.ref, nx, ny, next);
    }
  };
  walk(r.idx, 1, 1, new Set());
  console.log(`  招 自身 ${(own.x2 - own.x1).toFixed(0)}×${(own.y2 - own.y1).toFixed(0)}` +
    (best ? ` → 成品中 ${best.w.toFixed(0)}×${best.h.toFixed(0)}` +
      `（寬 ${(100 * best.w / (own.x2 - own.x1)).toFixed(0)}%、高 ${(100 * best.h / (own.y2 - own.y1)).toFixed(0)}%）` : ""));
  console.log("");
}

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
  const out = new Uint8Array(parts.reduce((a2, b2) => a2 + b2.length, 0));
  let p = 0;
  for (const q of parts) { out.set(q, p); p += q.length; }
  return out;
}

const panels = [refCov, covC, covA];
const PW = 210, pad = 10;
const W = panels.length * PW + pad * 2, H = 230;
const gray = new Uint8Array(W * H).fill(255);
panels.forEach((cov, i) => {
  const x0 = pad + i * PW;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
    gray[(y + 20) * W + x0 + x] = Math.round(255 * (1 - Math.min(1, cov[y * 200 + x]!)));
  }
  for (let y = 0; y < 200; y++) { gray[(y + 20) * W + x0] = 150; gray[(y + 20) * W + x0 + 199] = 150; }
  for (let x = 0; x < 200; x++) { gray[20 * W + x0 + x] = 150; gray[219 * W + x0 + x] = 150; }
});
writeFileSync(resolve(ROOT, "out/grail-readings.png"), grayPng(W, H, gray));

// 也把「招財進寶」四個字單獨出一張，確認基本檢視沒問題
const four = Array.from("招財進寶");
const FW = 120, fp = 8;
const W2 = four.length * (FW + fp) + fp, H2 = FW + 2 * fp;
const gray2 = new Uint8Array(W2 * H2).fill(255);
four.forEach((ch, i) => {
  const idx = indexOfChar(lib, ch)!;
  const cov = rasterize(kageOf(lib, idx), keyOfIdx(lib, idx), FW, 2).cov;
  const x0 = fp + i * (FW + fp);
  for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) {
    gray2[(y + fp) * W2 + x0 + x] = Math.round(255 * (1 - Math.min(1, cov[y * FW + x]!)));
  }
});
writeFileSync(resolve(ROOT, "out/zhaocaijinbao-4chars.png"), grayPng(W2, H2, gray2));

console.log(`已寫出 out/grail-readings.png（左：參考圖　中：關掉讓位（改版前）　右：讓位後）`);
console.log(`已寫出 out/zhaocaijinbao-4chars.png（招財進寶 四個字，各 ${FW}px）`);
