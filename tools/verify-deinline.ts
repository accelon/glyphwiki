#!/usr/bin/env bun
/**
 * verify-deinline.ts — 驗證第一批異體部件：還原後渲染是否與原版相同。
 *
 * 為什麼一定要驗：分組分錯**渲染看不出來**（筆劃只是搬了位置），
 * 所以「看起來沒事」不能當證據。這裡逐字重建、逐像素比對，
 * 任何一個字不是 100% 就列出來。
 *
 * 用法: bun run tools/verify-deinline.ts [--tsv out/deinline-variants.tsv]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { keyOfIdx, toKageData, indexOfCodePoint, displayName } from "./lib-format.ts";
import type { Library, Glyph, Stroke } from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine } from "./compose-fit.ts";
import { rasterize } from "./raster.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const ti = argv.indexOf("--tsv");
const TSV = resolve(ROOT, ti >= 0 && argv[ti + 1] ? argv[ti + 1]! : "out/deinline-variants.tsv");

const { lib: L } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();
const PARENT = "p";

type V = { name: string; sourceCp: number; compCp: number; at: number; slots: number[]; n: number; strokes: Stroke[] };
function parseData(s: string): Stroke[] {
  return s.split("$").filter(Boolean).map((line) => {
    const f = line.split(":").map(Number);
    return {
      kind: f[0]!, width: f[1]!, style: f[2]!,
      points: f.slice(3, 11),
      ref: null, box: null, stretch: null,
    } as Stroke;
  });
}

const bySource = new Map<number, V[]>();
{
  const lines = readFileSync(TSV, "utf8").split("\n").slice(1).filter(Boolean);
  /* 欄位順序：0 name, 1 source_cp, 2 source_name, 3 comp_cp, 4 comp_name,
                5 group, 6 k, 7 at, 8 slots, 9 n_strokes, 10 data */
  for (const line of lines) {
    const c = line.split("\t");
    const cp = parseInt(c[1]!.slice(2), 16);
    const a = bySource.get(cp);
    const v: V = {
      name: c[0]!, sourceCp: cp, compCp: parseInt(c[3]!.slice(2), 16),
      at: Number(c[7]), slots: c[8]!.split(",").filter(Boolean).map(Number),
      n: Number(c[9]), strokes: parseData(c[10]!),
    };
    if (a) a.push(v); else bySource.set(cp, [v]);
  }
}

function entriesFor(parentGlyph: Glyph, extra: Map<string, Glyph>): [string, Glyph][] {
  const out = new Map<string, Glyph>(extra);
  out.set(PARENT, parentGlyph);
  const stack: number[] = [];
  for (const s of parentGlyph.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  const seen = new Set<number>();
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const k = keyOfIdx(L, i);
    if (out.has(k)) continue;
    const g = L.glyphs[i];
    if (!g) continue;
    out.set(k, g);
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  return [...out.entries()];
}
function covOf(entries: [string, Glyph][], size: number): Float32Array {
  const kage = new (globalThis as any).Kage();
  for (const [k, g] of entries) kage.kBuhin.push(k, toKageData(g, L));
  return rasterize(kage, PARENT, size, 2).cov;
}
function iou(a: Float32Array, b: Float32Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]! > 0.5, y = b[i]! > 0.5; if (x && y) inter++; if (x || y) uni++; }
  return uni ? inter / uni : 1;
}

const FAKE0 = L.glyphs.length;   // 借來的索引池
let nBad = 0, nOk = 0, worst = 1, worstCh = "";
const badList: string[] = [];
const samples: { ch: string; cp: number; before: Float32Array; after: Float32Array }[] = [];

for (const [cp, vs] of bySource) {
  const gi = indexOfCodePoint(L, cp);
  if (gi === undefined) continue;
  const g = L.glyphs[gi]!;

  /* 重建：**照原始 strokes 的順序走**，遇到某個群組的第一筆就插入它的引用、
     其餘屬於該群組的筆劃跳過。不能把所有引用排到前面——
     原始筆劃與引用可能交錯，順序一變 KAGE 的相鄰筆劃調整就會改變渲染。 */
  const extra = new Map<string, Glyph>();
  const atMap = new Map<number, { fake: number; n: number }>();
  const consumed = new Set<number>();
  vs.forEach((v, k) => {
    const fake = FAKE0 + k;
    extra.set(keyOfIdx(L, fake), { tight: null, strokes: v.strokes });
    atMap.set(v.at, { fake, n: v.n });
    for (const i of v.slots) consumed.add(i);
  });
  const rebuiltStrokes: Stroke[] = [];
  let cur = 0;
  for (let i = 0; i < g.strokes.length; i++) {
    const hit = atMap.get(i);
    if (hit) {
      rebuiltStrokes.push({
        kind: 99, width: 0, style: 0, points: [0, 0, 0, 0, 0, 0, 0, 0],
        ref: hit.fake, box: [0, 0, 200, 200], stretch: 0,
      });
      cur++;
      continue;
    }
    if (consumed.has(i)) continue;
    rebuiltStrokes.push(g.strokes[i]!);
  }
  const rebuilt: Glyph = { ...g, tight: null, strokes: rebuiltStrokes };
  const a = covOf(entriesFor(g, new Map()), 160);
  const b = covOf(entriesFor(rebuilt, extra), 160);
  const v = iou(a, b);
  if (v < 0.9999) {
    nBad++;
    if (badList.length < 20) badList.push(`  ${String.fromCodePoint(cp)} U+${cp.toString(16).toUpperCase()}  IoU=${(v * 100).toFixed(1)}%`);
  } else nOk++;
  if (v < worst) { worst = v; worstCh = String.fromCodePoint(cp); }
  if (samples.length < 14 && (cp % 7 < 2)) samples.push({ ch: String.fromCodePoint(cp), cp, before: a, after: b });
}

console.log("=== 還原驗證（逐字重建、逐像素比對）===");
console.log(`  驗證 ${(nOk + nBad).toLocaleString()} 個字：完全相同 ${nOk.toLocaleString()}、不同 ${nBad.toLocaleString()}`);
console.log(`  最低 IoU ${(worst * 100).toFixed(2)}%（${worstCh}）`);
for (const l of badList) console.log(l);

/* ---- 出圖：原版 / 還原 交錯 ---- */
{
  const S = 110, GAP = 8;
  const cells: Float32Array[] = [];
  for (const s of samples) { cells.push(s.before); cells.push(s.after); }
  const W = GAP + cells.length * (S + GAP), H = GAP + S + GAP;
  const buf = new Uint8Array(W * H).fill(255);
  cells.forEach((cv, i) => {
    const x0 = GAP + i * (S + GAP);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const v = cv[Math.floor(y * 160 / S) * 160 + Math.floor(x * 160 / S)]!;
      buf[(y + GAP) * W + x0 + x] = Math.round(255 * (1 - Math.min(1, v)));
    }
    const edge = i % 2 === 0 ? 200 : 140;
    for (let y = 0; y < S; y++) { buf[(y + GAP) * W + x0] = edge; buf[(y + GAP) * W + x0 + S - 1] = edge; }
    for (let x = 0; x < S; x++) { buf[GAP * W + x0 + x] = edge; buf[(GAP + S - 1) * W + x0 + x] = edge; }
  });
  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (ty: string, d: Uint8Array) => {
    const o = new Uint8Array(12 + d.length), dv = new DataView(o.buffer);
    dv.setUint32(0, d.length);
    for (let i = 0; i < 4; i++) o[4 + i] = ty.charCodeAt(i);
    o.set(d, 8); dv.setUint32(8 + d.length, crc32(o.subarray(4, 8 + d.length)));
    return o;
  };
  const raw = new Uint8Array((W + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; raw.set(buf.subarray(y * W, (y + 1) * W), y * (W + 1) + 1); }
  const ih = new Uint8Array(13);
  { const dv = new DataView(ih.buffer); dv.setUint32(0, W); dv.setUint32(4, H); ih[8] = 8; }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array(0))];
  const outb = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const q of parts) { outb.set(q, p); p += q.length; }
  writeFileSync(resolve(ROOT, "out/deinline-verify.png"), outb);
  console.log(`\n出圖 out/deinline-verify.png（每兩格一組：左＝原版、右＝還原）`);
  console.log("  樣本：" + samples.map((s) => s.ch).join(" "));
}
void displayName;
