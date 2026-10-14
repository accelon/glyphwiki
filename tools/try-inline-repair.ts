#!/usr/bin/env bun
/**
 * try-inline-repair.ts — 把「被拆散成原始筆劃的部件」換回部件引用，看渲染對不對。
 *
 * 做法（不寫回資料庫，只在記憶體裡試）：
 *   1. 拿父字裡那組原始筆劃，算出它們的墨跡框 = 目標框
 *   2. 選一個候選異體 v（候選自己的墨跡框是 vb）
 *   3. 解出「把 v 的畫布映射到目標框」的 KAGE 引用框：
 *        bw = 200 * (目標寬) / vb寬      bx1 = 目標x1 - vb.x1 * bw / 200
 *      高度同理。因為 KAGE 的框是**非等比**映射整張 200×200 畫布。
 *   4. 把原始筆劃換成一個 99 引用，重新描繪，跟原版比 IoU
 *
 * 用法: bun run tools/try-inline-repair.ts u674f-j u6728-03 u6728-09
 */
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { keyOfIdx, toKageData } from "./lib-format.ts";
import type { Library, Glyph, Stroke } from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine } from "./compose-fit.ts";
import { rasterize } from "./raster.ts";

const ROOT = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2);
const parentName = args[0] ?? "u674f-j";
const candNames = args.slice(1).length ? args.slice(1) : ["u6728-03", "u6728-09", "u6728-j"];

const { lib: L } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
ensureEngine();

/** 用名字找字形索引（loadWikiNames 把字串放進 L.gwiki） */
function byName(n: string): number {
  const ns = L.gwiki;
  if (!ns) { console.error("沒有載入名字對照表，無法用名字查"); process.exit(1); }
  for (let i = 0; i < ns.length; i++) if (ns[i] === n) return i;
  return -1;
}

function bboxOfStrokes(g: Glyph): [number, number, number, number] {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const add = (x: number, y: number) => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); };
  for (const s of g.strokes) {
    if (s.kind === 99 || s.kind === 0) continue;
    const p = s.points;
    for (let i = 0; i + 1 < p.length; i += 2) if (p[i] || p[i + 1]) add(p[i]!, p[i + 1]!);
  }
  if (!isFinite(x1)) return [0, 0, 200, 200];
  return [x1, y1, x2, y2];
}

const PARENT_KEY = "parent";
function kageFor(g: Glyph): any {
  const kage = new (globalThis as any).Kage();
  kage.kBuhin.push(PARENT_KEY, toKageData(g, L));
  const seen = new Set<number>();
  const stack: number[] = [];
  for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  while (stack.length) {
    const j = stack.pop()!;
    if (seen.has(j)) continue;
    seen.add(j);
    kage.kBuhin.push(keyOfIdx(L, j), toKageData(L.glyphs[j]!, L));
    for (const s of L.glyphs[j]!.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  return kage;
}
/** 描繪成 size×size 的覆蓋率 */
function covOf(g: Glyph, size: number): Float32Array {
  return rasterize(kageFor(g), PARENT_KEY, size, 2).cov;
}

const pi = byName(parentName);
if (pi < 0) { console.error(`找不到 ${parentName}`); process.exit(1); }
const parent = L.glyphs[pi]!;
const raw = parent.strokes.filter((s) => s.kind !== 99 && s.kind !== 0);
const tb = bboxOfStrokes(parent);
console.log(`父字 ${parentName}：${parent.strokes.length} 筆（原始筆劃 ${raw.length} 筆）`);
console.log(`  原始筆劃的墨跡框 = [${tb.map((v) => Math.round(v)).join(", ")}]`);

const results: { name: string; glyph: Glyph; iou: number; box: number[] }[] = [];
for (const cn of candNames) {
  const ci = byName(cn);
  if (ci < 0) { console.log(`  ${cn}：不在庫中，跳過`); continue; }
  const v = L.glyphs[ci]!;
  const vb = bboxOfStrokes(v);
  const tbw = Math.max(1, tb[2] - tb[0]), tbh = Math.max(1, tb[3] - tb[1]);
  const vbw = Math.max(1, vb[2] - vb[0]), vbh = Math.max(1, vb[3] - vb[1]);
  const bw = 200 * tbw / vbw, bh = 200 * tbh / vbh;
  const bx1 = tb[0] - vb[0] * bw / 200, by1 = tb[1] - vb[1] * bh / 200;
  const box = [bx1, by1, bx1 + bw, by1 + bh];
  /* 換掉：保留 99 之外的東西？這裡直接把原始筆劃整組換成一個引用 */
  const kept = parent.strokes.filter((s) => s.kind === 99);
  const g2: Glyph = {
    ...parent,
    strokes: [...kept, {
      kind: 99, width: 0, style: 0, points: [0, 0, 0, 0, 0, 0, 0, 0],
      ref: ci, box: box.map((v) => Math.round(v)) as [number, number, number, number],
      stretch: 0,
    }] as Stroke[],
  };
  const a = covOf(parent, 200);
  const b = covOf(g2, 200);
  let inter = 0, uni = 0;
  for (let k = 0; k < a.length; k++) { const x = a[k]! > 0.5, y = b[k]! > 0.5; if (x && y) inter++; if (x || y) uni++; }
  const iou = uni ? inter / uni : 1;
  console.log(`  ${cn}：框 [${box.map((v) => Math.round(v)).join(", ")}]　與原版 IoU = ${(iou * 100).toFixed(1)}%`);
  results.push({ name: cn, glyph: g2, iou, box: box.map((v) => Math.round(v)) });
}

/* ---- 出圖：原版在最左，其餘是候選修補版 ---- */
{
  const S = 180, GAP = 10;
  const cells = [{ name: parentName, glyph: parent }, ...results];
  const W = GAP + cells.length * (S + GAP), H = GAP + S + GAP;
  const buf = new Uint8Array(W * H).fill(255);
  cells.forEach((c, i) => {
    const cov = covOf(c.glyph, S);
    const x0 = GAP + i * (S + GAP);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      buf[(y + GAP) * W + x0 + x] = Math.round(255 * (1 - Math.min(1, cov[y * S + x]!)));
    }
    for (let y = 0; y < S; y++) { buf[(y + GAP) * W + x0] = 200; buf[(y + GAP) * W + x0 + S - 1] = 200; }
    for (let x = 0; x < S; x++) { buf[GAP * W + x0 + x] = 200; buf[(GAP + S - 1) * W + x0 + x] = 200; }
  });
  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (ty: string, d: Uint8Array) => {
    const o = new Uint8Array(12 + d.length), v = new DataView(o.buffer);
    v.setUint32(0, d.length);
    for (let i = 0; i < 4; i++) o[4 + i] = ty.charCodeAt(i);
    o.set(d, 8); v.setUint32(8 + d.length, crc32(o.subarray(4, 8 + d.length)));
    return o;
  };
  const rawPng = new Uint8Array((W + 1) * H);
  for (let y = 0; y < H; y++) { rawPng[y * (W + 1)] = 0; rawPng.set(buf.subarray(y * W, (y + 1) * W), y * (W + 1) + 1); }
  const ih = new Uint8Array(13);
  { const v = new DataView(ih.buffer); v.setUint32(0, W); v.setUint32(4, H); ih[8] = 8; }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih),
    chunk("IDAT", new Uint8Array(deflateSync(rawPng, { level: 9 }))), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const q of parts) { out.set(q, p); p += q.length; }
  const outPath = resolve(ROOT, "out/inline-repair.png");
  writeFileSync(outPath, out);
  console.log(`\n已寫出 ${outPath}（左起：原版 ${cells.map((c) => c.name).slice(1).join(" / ")}）`);
}

