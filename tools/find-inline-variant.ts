#!/usr/bin/env bun
/**
 * find-inline-variant.ts — 幫「被拆散成原始筆劃的部件」找回它原本該引用的異體。
 *
 * 問題：GlyphWiki 有些字把部件直接畫成原始筆劃（杏的「木」、林的兩個「木」），
 * 所以以部件為基礎的搜尋找不到它們。推測是作者嫌標準異體的豎太長、
 * 要微調，乾脆拆散重畫——但其實家族裡可能已經有人做了對應的異體。
 *
 * 做法：把「原始筆劃那一組」與每個候選異體各自**用自己的墨跡框正規化**，
 * 再比對對應筆畫的端點（橫對橫、豎對豎、撇對撇、捺對捺），算 RMS 距離。
 * 正規化是必要的：KAGE 的引用框可以縮放，所以形狀要**去尺度**比較。
 *
 * 用法: bun run tools/find-inline-variant.ts <部件名> <父字名> [--top 8] [--out out/xxx.png]
 *   bun run tools/find-inline-variant.ts u6728 u674f-j
 *   bun run tools/find-inline-variant.ts u6728 u6797-j
 */
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const ROOT = resolve(import.meta.dir, "..");
const db = new Database(resolve(ROOT, "db/glyphwiki.db"), { readonly: true });

const args = Bun.argv.slice(2);
const compName = args[0] ?? "u6728";
const parentName = args[1] ?? "u674f-j";
const ti = args.indexOf("--top");
const TOP = ti >= 0 ? Number(args[ti + 1]) : 8;

/** DB 的 data 用 $ 分隔每一筆。欄位是 kind:width:style:x1:y1:x2:y2[:x3:y3[:x4:y4]]
    直線只有 7 欄、曲線 9 欄——**不要用固定長度判斷**，從索引 3 開始兩兩取點。 */
function strokesOf(name: string): number[][] {
  const r = db.query("SELECT data FROM glyphs WHERE name=?").get(name) as { data: string } | null;
  if (!r) return [];
  const out: number[][] = [];
  for (const line of r.data.split("$")) {
    const f = line.split(":").map(Number);
    if (f.length < 7) continue;
    if (f[0] === 99) continue;            // 引用不算原始筆劃
    if (f[0] === 0) continue;             // 全零佔位列
    out.push(f);
  }
  return out;
}

/** 一筆的所有端點（從索引 3 開始兩兩一組） */
function pts(f: number[]): [number, number][] {
  const a: [number, number][] = [];
  for (let i = 3; i + 1 < f.length; i += 2) a.push([f[i]!, f[i + 1]!]);
  return a;
}

function bbox(ss: number[][]) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const f of ss) for (const [x, y] of pts(f)) {
    x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y);
  }
  return { x1, y1, x2, y2, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
}

type Norm = { kind: number; p: [number, number][] };
function normalize(ss: number[][]): Norm[] {
  const b = bbox(ss);
  return ss.map((f) => ({
    kind: f[0],
    p: pts(f).map(([x, y]) => [(x - b.x1) / b.w, (y - b.y1) / b.h] as [number, number]),
  }));
}

/** 把筆畫配對：先按 kind 分組，再用「端點距離」貪婪配對 */
function matchCost(a: Norm[], b: Norm[]): number | null {
  if (a.length !== b.length) return null;
  const used = new Array(b.length).fill(false);
  let sum = 0, n = 0;
  for (const x of a) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < b.length; i++) {
      if (used[i] || b[i]!.kind !== x.kind) continue;
      if (b[i]!.p.length !== x.p.length) continue;
      let d = 0;
      for (let k = 0; k < x.p.length; k++) {
        d += Math.hypot(x.p[k]![0] - b[i]!.p[k]![0], x.p[k]![1] - b[i]!.p[k]![1]);
      }
      d /= x.p.length;
      // 允許反向（同一條線從另一端畫起）
      let dr = 0;
      for (let k = 0; k < x.p.length; k++) {
        const j = x.p.length - 1 - k;
        dr += Math.hypot(x.p[k]![0] - b[i]!.p[j]![0], x.p[k]![1] - b[i]!.p[j]![1]);
      }
      dr /= x.p.length;
      d = Math.min(d, dr);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return null;
    used[best] = true;
    sum += bestD; n++;
  }
  return n ? sum / n : null;
}

const parent = strokesOf(parentName);
console.log(`父字 ${parentName} 的原始筆劃：${parent.length} 筆`);
const target = normalize(parent);

/* 候選：同一個 base_name 家族（含 -g / -t / -var / -itaiji）裡所有「純筆劃」的字形 */
const cands = db.query(
  "SELECT name, data FROM glyphs WHERE base_name=? AND n_refs=0 AND n_strokes>0 ORDER BY name",
).all(compName) as { name: string; data: string }[];
console.log(`候選（${compName} 家族、純筆劃）：${cands.length} 個\n`);

type Row = { name: string; cost: number; n: number; ratio: number };
const rows: Row[] = [];
for (const c of cands) {
  const ss = strokesOf(c.name);
  if (!ss.length) continue;
  const cost = matchCost(target, normalize(ss));
  if (cost === null) continue;
  const b = bbox(ss);
  // 豎長 ÷ 橫長：這個比例就是「豎有沒有被縮短」
  const horiz = ss.find((f) => f[0] === 1 && Math.abs(f[5] - f[3]) > Math.abs(f[6] - f[4]));
  const vert = ss.find((f) => f[0] === 1 && Math.abs(f[6] - f[4]) >= Math.abs(f[5] - f[3]));
  const ratio = horiz && vert
    ? Math.abs(vert[6] - vert[4]) / Math.max(1, Math.abs(horiz[5] - horiz[3])) : NaN;
  rows.push({ name: c.name, cost, n: ss.length, ratio });
}
rows.sort((a, b) => a.cost - b.cost);

const tb = bbox(parent);
const ph = parent.find((f) => f[0] === 1 && Math.abs(f[5] - f[3]) > Math.abs(f[6] - f[4]));
const pv = parent.find((f) => f[0] === 1 && Math.abs(f[6] - f[4]) >= Math.abs(f[5] - f[3]));
const targetRatio = ph && pv ? Math.abs(pv[6] - pv[4]) / Math.max(1, Math.abs(ph[5] - ph[3])) : NaN;
console.log(`目標（${parentName} 拆散的那一組）豎÷橫 = ${targetRatio.toFixed(3)}　筆數 ${parent.length}\n`);

console.log("排名  名稱                形狀距離   豎÷橫    筆數");
for (const r of rows.slice(0, TOP)) {
  console.log(`  ${String(rows.indexOf(r) + 1).padStart(2)}  ${r.name.padEnd(20)} ${r.cost.toFixed(4)}   ${r.ratio.toFixed(3)}   ${r.n}` +
    (Math.abs(r.ratio - targetRatio) < 0.08 ? "   ← 豎長比例接近" : ""));
}

/* ---- 把前幾名與目標疊圖，肉眼確認 ---- */
const oi = args.indexOf("--out");
if (oi >= 0) {
  const outPath = resolve(ROOT, args[oi + 1]!);
  const show = rows.slice(0, 6);
  const S = 120, GAP = 8, LBL = 16;
  const W = GAP + show.length * (S + GAP), H = GAP + S + LBL + GAP + S + GAP;
  const buf = new Uint8Array(W * H * 4).fill(0);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = 11; buf[i + 1] = 12; buf[i + 2] = 14; buf[i + 3] = 255; }
  const plot = (ss: number[][], ox: number, oy: number, col: number[], bb: ReturnType<typeof bbox>) => {
    for (const f of ss) {
      const P = pts(f);
      for (let k = 0; k + 1 < P.length; k++) {
        const [ax, ay] = P[k]!, [bx, by] = P[k + 1]!;
        const n = Math.ceil(Math.hypot(bx - ax, by - ay));
        for (let t = 0; t <= n; t++) {
          const x = ox + Math.round((ax + (bx - ax) * t / n - bb.x1) / bb.w * S);
          const y = oy + Math.round((ay + (by - ay) * t / n - bb.y1) / bb.h * S);
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            const px = x + dx, py = y + dy;
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            const o = (py * W + px) * 4;
            buf[o] = col[0]!; buf[o + 1] = col[1]!; buf[o + 2] = col[2]!; buf[o + 3] = 255;
          }
        }
      }
    }
  };
  for (let i = 0; i < show.length; i++) {
    const x = GAP + i * (S + GAP);
    const bb2 = bbox(strokesOf(show[i]!.name));
    plot(strokesOf(show[i]!.name), x, GAP, [255, 255, 255], bb2);
    plot(parent, x, GAP, [255, 90, 90], tb);              // 目標疊在同一個正規化框上
  }
  /* 第二列：目標自己放大 */
  plot(parent, GAP, GAP + S + LBL, [120, 220, 255], tb);
  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (ty: string, d: Uint8Array) => {
    const o = new Uint8Array(12 + d.length), v = new DataView(o.buffer);
    v.setUint32(0, d.length);
    for (let i = 0; i < 4; i++) o[4 + i] = ty.charCodeAt(i);
    o.set(d, 8); v.setUint32(8 + d.length, crc32(o.subarray(4, 8 + d.length)));
    return o;
  };
  const raw = new Uint8Array((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; raw.set(buf.subarray(y * W * 4, (y + 1) * W * 4), y * (W * 4 + 1) + 1); }
  const ih = new Uint8Array(13);
  { const v = new DataView(ih.buffer); v.setUint32(0, W); v.setUint32(4, H); ih[8] = 8; ih[9] = 6; }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const q of parts) { out.set(q, p); p += q.length; }
  writeFileSync(outPath, out);
  console.log(`\n已寫出 ${outPath}（第一列：白＝候選、紅＝目標；第二列：目標單獨）`);
}
