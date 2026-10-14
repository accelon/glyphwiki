#!/usr/bin/env bun
/**
 * grail-fit-compare.ts — 同一條構形序列，換不同的「放入策略」，用參考圖打分。
 *
 * 背景：加了 Ext B 之後 `邏羅寶貝𩀨從䞃致招` 已經組得出來（`evalSeq` 直接跑完），
 * 但成品的部件偏大、互相重疊，跟師父給的參考圖差一段。
 * 這個檔案把「替換時框怎麼算」抽成幾種策略，實際跑出來跟參考圖算 IoU，
 * 用數字挑，而不是用眼睛猜（`配合編輯器修組字引擎.md` §4.2 的驗收原則）。
 *
 * 策略（都在既有框／墨跡的基礎上，不自己發明版面）：
 *   keep        沿用舊框（＝目前 evalSeq 的行為，會非等比拉伸）
 *   uniform     把子字形的墨跡**等比**縮到放得進舊槽位的墨跡區，置中（不放大）
 *   uniform-grow 同上，但允許放大
 *   inkfit      把子字形的墨跡**非等比**貼合到舊槽位的墨跡區
 *
 * 用法: bun run tools/grail-fit-compare.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { toKageData, isVariantOfCp, keyOfIdx, indexOfChar, displayName } from "./lib-format.ts";
import type { Library, Glyph, Stroke } from "./lib-format.ts";
import { loadLibrary, DEFAULT_LIB } from "./lib-load.ts";
import { ensureEngine, inkIn, inkOfRefInParent } from "./compose-fit.ts";
import { rasterize } from "./raster.ts";

const ROOT = resolve(import.meta.dir, "..");
ensureEngine();
const { lib } = loadLibrary(resolve(ROOT, DEFAULT_LIB));
const idxOf = (c: string) => indexOfChar(lib, c);

// ---------------------------------------------------------------- 參考圖（PGM）

function readPgm(path: string): { w: number; h: number; cov: Float32Array } {
  const buf = readFileSync(path);
  let p = 0;
  const tok = () => {
    while (p < buf.length) {
      if (buf[p] === 0x23) { while (p < buf.length && buf[p] !== 0x0a) p++; }
      else if (buf[p]! <= 0x20) p++;
      else break;
    }
    const s = p;
    while (p < buf.length && buf[p]! > 0x20) p++;
    return Buffer.from(buf.subarray(s, p)).toString("latin1");
  };
  if (tok() !== "P5") throw new Error("不是 P5 PGM");
  const w = Number(tok()), h = Number(tok());
  tok();
  p++;
  const px = buf.subarray(p, p + w * h);
  const cov = new Float32Array(w * h);
  for (let i = 0; i < cov.length; i++) cov[i] = 1 - px[i]! / 255;
  return { w, h, cov };
}
const refRaster = (() => {
  const r = readPgm(resolve(ROOT, "out/ref/flat.pgm"));
  return { size: r.w, cov: r.cov };
})();
const iouOf = (a: Float32Array, b: Float32Array) => {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) { i += Math.min(a[k]!, b[k]!); u += Math.max(a[k]!, b[k]!); }
  return u > 0 ? i / u : 1;
};

// ---------------------------------------------------------------- 替代 free-compose 的替換器

type Box = [number, number, number, number];
type Policy = "keep" | "uniform" | "uniform-grow" | "inkfit" | "inkbox";

function fork(L: Library): { lib: Library; glyphs: Glyph[] } {
  const glyphs: Glyph[] = L.glyphs.map((g) => ({ tight: g.tight, strokes: g.strokes }));
  const lib: Library = { ...L, glyphs };
  if (L.names) lib.names = L.names.slice();
  return { lib, glyphs };
}

/** 在 base 的引用樹中找 cp 家族的最淺槽位 */
function findSlot(L: Library, base: number, oldCp: number) {
  const seen = new Set<number>();
  const stack = [base];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i];
    if (!g) continue;
    for (let si = 0; si < g.strokes.length; si++) {
      const s = g.strokes[si]!;
      if (s.kind === 99 && s.ref !== null && isVariantOfCp(L, s.ref, oldCp)) {
        return { parent: i, strokeIx: si };
      }
    }
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  return null;
}

function fitBox(policy: Policy, L: Library, parent: number, strokeIx: number,
                newIdx: number, oldBox: Box): Box {
  if (policy === "keep") return oldBox;
  const oldInk = inkOfRefInParent(L, parent, strokeIx);      // 舊槽位的墨跡區（父座標）
  const c = inkIn(L, newIdx);                                 // 新部件自身墨跡（子座標）
  const cw = Math.max(1, c.x2 - c.x1), chh = Math.max(1, c.y2 - c.y1);
  const sw = Math.max(1, oldInk.x2 - oldInk.x1), sh = Math.max(1, oldInk.y2 - oldInk.y1);
  if (policy === "inkfit") {
    // 讓子墨跡剛好貼到槽位墨跡區（解 x' = B.x1 + x*B.w/200）
    const bw = 200 * sw / cw, bh = 200 * sh / chh;
    return [
      Math.round(oldInk.x1 - c.x1 * bw / 200), Math.round(oldInk.y1 - c.y1 * bh / 200),
      Math.round(oldInk.x1 - c.x1 * bw / 200 + bw), Math.round(oldInk.y1 - c.y1 * bh / 200 + bh),
    ];
  }
  if (policy === "inkbox") {
    // 把「舊部件實際佔的墨跡區」直接當成新部件的框。
    // 也就是新部件的**整張 200×200 畫布**仿射映射到舊部件的墨跡區。
    return [
      Math.round(oldInk.x1), Math.round(oldInk.y1),
      Math.round(oldInk.x2), Math.round(oldInk.y2),
    ];
  }
  const k = policy === "uniform-grow" ? Math.min(sw / cw, sh / chh) : Math.min(sw / cw, sh / chh, 1);
  const side = 200 * k;
  const cx = (oldInk.x1 + oldInk.x2) / 2, cy = (oldInk.y1 + oldInk.y2) / 2;
  return [
    Math.round(cx - side / 2), Math.round(cy - side / 2),
    Math.round(cx + side / 2), Math.round(cy + side / 2),
  ];
}

/** 一次替換：base 的 oldCh → newIdx（自訂框策略） */
function applyReplace(
  L: Library, baseIdx: number, oldCh: string, newIdx: number, policy: Policy,
): { lib: Library; log: string } {
  const slot = findSlot(L, baseIdx, oldCh.codePointAt(0)!);
  if (!slot) throw new Error(`找不到 ${oldCh}`);
  const { lib, glyphs } = fork(L);
  const p0 = glyphs[slot.parent]!;
  const st = p0.strokes[slot.strokeIx]!;
  const box = fitBox(policy, L, slot.parent, slot.strokeIx, newIdx, st.box as Box);
  const strokes = p0.strokes.slice();
  strokes[slot.strokeIx] = { ...st, ref: newIdx, box, stretch: [0, 0, 0, 0] };
  glyphs[slot.parent] = { tight: p0.tight, strokes };
  return {
    lib,
    log: `${displayName(L, slot.parent)} 的 ${oldCh} → ${displayName(L, newIdx)} 框[${box.join(",")}]`,
  };
}

/** 整條序列（由內而外）：(䞃 的 致→招) → 𩀨 的 從 → 寶 的 貝 → 邏 的 羅 */
function compose(policy: Policy): { lib: Library; idx: number; log: string[] } {
  const log: string[] = [];
  const step = (L: Library, base: string, old: string, child: { lib: Library; idx: number }) => {
    const b = indexOfChar(L, base)!;
    const r = applyReplace(child.lib, b, old, child.idx, policy);
    log.push(r.log);
    return { lib: r.lib, idx: b };
  };
  const zhao = { lib, idx: idxOf("招")! };
  const c1 = step(lib, "䞃", "致", zhao);
  const c2 = step(lib, "𩀨", "從", c1);
  const c3 = step(lib, "寶", "貝", c2);
  const c4 = step(lib, "邏", "羅", c3);
  return { lib: c4.lib, idx: c4.idx, log };
}

// ---------------------------------------------------------------- 跑所有策略

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

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function grayPng(w: number, h: number, gray: Uint8Array): Uint8Array {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; raw.set(gray.subarray(y * w, (y + 1) * w), y * (w + 1) + 1); }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const q of parts) { out.set(q, p); p += q.length; }
  return out;
}

const S = 200;
const results: { policy: Policy; iou: number; cov: Float32Array; inkW: number; inkH: number }[] = [];
for (const policy of ["keep", "uniform", "uniform-grow", "inkfit", "inkbox"] as Policy[]) {
  const t = Date.now();
  const r = compose(policy);
  const cov = rasterize(kageOf(r.lib, r.idx), keyOfIdx(r.lib, r.idx), S, 1).cov;
  const iou = iouOf(cov, refRaster.cov);
  const ink = inkIn(r.lib, r.idx);
  results.push({ policy, iou, cov, inkW: ink.x2 - ink.x1, inkH: ink.y2 - ink.y1 });
  console.log(`\n=== ${policy}  (${Date.now() - t} ms)  IoU = ${iou.toFixed(4)}  墨跡 ${(ink.x2 - ink.x1).toFixed(0)}×${(ink.y2 - ink.y1).toFixed(0)}`);
  for (const l of r.log) console.log(`    ${l}`);
  const gray = new Uint8Array(S * S);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(255 * (1 - Math.min(1, cov[i]!)));
  writeFileSync(resolve(ROOT, `out/grail-fit-${policy}.png`), grayPng(S, S, gray));
}

console.log("\n=== 排名 ===");
for (const r of [...results].sort((a, b) => b.iou - a.iou)) {
  console.log(`  ${r.policy.padEnd(13)} IoU ${r.iou.toFixed(4)}　墨跡 ${r.inkW.toFixed(0)}×${r.inkH.toFixed(0)}`);
}

// 對照表：參考 ／ 各策略 ／ 最好的一個（放大 2 倍）
const cells: { label: string; cov: Float32Array }[] = [{ label: "參考圖", cov: refRaster.cov }];
for (const r of results) cells.push({ label: r.policy, cov: r.cov });
const CS = 240, pad = 10;
const sheetW = cells.length * (CS + pad) + pad, sheetH = CS + 46;
const gray = new Uint8Array(sheetW * sheetH).fill(255);
const put = (x0: number, y0: number, cov: Float32Array) => {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const v = Math.round(255 * (1 - Math.min(1, cov[y * S + x]!)));
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const px = x0 + x * 2 + dx, py = y0 + y * 2 + dy;
      if (px < sheetW && py < sheetH) gray[py * sheetW + px] = v;
    }
  }
};
// 邊界線
for (let i = 0; i < cells.length; i++) {
  const x0 = pad + i * (CS + pad);
  put(x0, 26, cells[i]!.cov);
  for (let y = 0; y < CS; y++) { gray[(26 + y) * sheetW + x0] = 200; gray[(26 + y) * sheetW + x0 + CS - 1] = 200; }
  for (let x = 0; x < CS; x++) { gray[26 * sheetW + x0 + x] = 200; gray[(26 + CS - 1) * sheetW + x0 + x] = 200; }
}
writeFileSync(resolve(ROOT, "out/grail-fit-compare.png"), grayPng(sheetW, sheetH, gray));
console.log(`\n已寫出 out/grail-fit-compare.png（左起：參考圖、${results.map((r) => r.policy).join("、")}）`);
