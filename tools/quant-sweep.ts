// quant-sweep.ts — 掃描更細的量化格數，找出「像素差異可忽略」的門檻
import { readFileSync } from "node:fs";
import { decodeLibrary, toKageData } from "./lib-format.ts";
import type { Library, Glyph } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
let engine = "";
for (const f of ["2d.js", "buhin.js", "curve.js", "kage.js", "kagecd.js", "kagedf.js", "polygon.js", "polygons.js"]) {
  engine += readFileSync(`${D}/kage-engine/${f}`, "utf8") + "\n";
}
(0, eval)(engine);
const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));
// 量化兩種模式：
//   snap  = 吸附到粗格但仍存 0..200 的大數值 → varint 變長，gzip 反而變大（錯誤做法）
//   index = 存量化後的索引 0..grid 的小數 → varint 短，才是正確做法
const snap = (v: number, grid: number) => Math.round((v / 200) * grid) * (200 / grid);
const qIndex = (v: number, grid: number) => Math.round((v / 200) * grid);
let QUANT_MODE: "snap" | "index" = "index";
const quant = (v: number, grid: number) => (QUANT_MODE === "snap" ? snap(v, grid) : qIndex(v, grid));

function quantGlyph(g: Glyph, grid: number): Glyph {
  // 光柵化需要 200 空間的值：用 index 量化後再乘回 200/grid
  const back = (v: number) => (qIndex(v, grid) * 200) / grid;
  return {
    tight: g.tight,
    strokes: g.strokes.map((s) =>
      s.kind === 99
        ? { ...s, box: s.box!.map(back), points: s.box!.map(back) }
        : { ...s, points: s.points.map(back) }),
  };
}

function libWith(gi: number, grid: number): Library {
  const glyphs = lib.glyphs.slice();
  const seen = new Set<number>();
  const st = [gi];
  while (st.length) {
    const i = st.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    glyphs[i] = quantGlyph(lib.glyphs[i]!, grid);
    for (const s of lib.glyphs[i]!.strokes) if (s.kind === 99 && s.ref !== null) st.push(s.ref);
  }
  return { names: lib.names, suffix: lib.suffix, glyphs };
}

function raster(L: Library, gi: number, S: number): Uint8Array {
  const kage = new Kage();
  const seen = new Set<number>();
  const st = [gi];
  while (st.length) {
    const i = st.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    kage.kBuhin.push(L.names[i]!, toKageData(L.glyphs[i]!, L));
    for (const s of L.glyphs[i]!.strokes) if (s.kind === 99 && s.ref !== null) st.push(s.ref);
  }
  const polys = new Polygons();
  kage.makeGlyph(polys, L.names[gi]!);
  const edges: number[][] = [];
  for (const p of polys.array) {
    const a = p.array;
    for (let i = 0; i + 1 < a.length; i++) edges.push([a[i]!.x, a[i]!.y, a[i + 1]!.x, a[i + 1]!.y]);
    if (a.length > 2) edges.push([a[a.length - 1]!.x, a[a.length - 1]!.y, a[0]!.x, a[0]!.y]);
  }
  const img = new Uint8Array(S * S);
  for (let py = 0; py < S; py++) {
    const yc = ((py + 0.5) / S) * 200;
    const xs: number[] = [];
    for (const e of edges) {
      const [x1, y1, x2, y2] = e as [number, number, number, number];
      if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil((xs[k]! / 200) * S - 0.5));
      const xb = Math.min(S - 1, Math.floor((xs[k + 1]! / 200) * S - 0.5));
      for (let px = xa; px <= xb; px++) img[py * S + px] = 1;
    }
  }
  return img;
}

/** gzip 大小（量化全部字形） */
const SUFFIXES = [...new Set(lib.names.map((n) => {
  const m = /^u[0-9a-f]{4,6}(-.*)?$/i.exec(n);
  return m && m[1] ? m[1] : null;
}).filter((x): x is string => x !== null))];
const suffixIx = new Map(SUFFIXES.map((s, i) => [s, i] as const));

function gzipOf(grid: number): number {
  const bin: number[] = [];
  const pushU = (n: number) => { let v = n >>> 0; while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; } bin.push(v); };
  const pushS = (n: number) => { let v = ((n << 1) ^ (n >> 31)) >>> 0; while (v >= 0x80) { bin.push((v & 0x7f) | 0x80); v >>>= 7; } bin.push(v); };
  // ← 名字表與後綴表必須計入，否則基準失真（先前漏了，基準只有 271 KB）
  pushU(lib.names.length);
  pushU(SUFFIXES.length);
  for (const s of SUFFIXES) { pushU(s.length); for (const ch of s) pushU(ch.charCodeAt(0)); }
  for (const n of lib.names) {
    const m = /^u([0-9a-f]{4,6})(-.*)?$/i.exec(n);
    if (m) { pushU(parseInt(m[1]!, 16)); pushU(m[2] ? suffixIx.get(m[2])! + 1 : 0); }
    else { pushU(0); pushU(n.length); for (const ch of n) pushU(ch.charCodeAt(0)); }
  }
  for (const g of lib.glyphs) {
    pushU(g.strokes.length);   // ← 先前漏了筆數
    for (const s of g.strokes) {
      pushU(s.kind);           // ← 以及 kind
      if (s.kind === 99) {
        const b = s.box!.map((v) => quant(v, grid));
        const isFull = b[0] === 0 && b[1] === 0 && b[2] === 200 && b[3] === 200;
        pushU(s.ref!);
        pushU(isFull ? 3 : 1);
        if (!isFull) for (const v of b) pushS(v);
        const nst = s.stretch!;
        if (!(nst[0] === 0 && nst[1] === 0 && nst[2] === 0 && nst[3] === 0)) for (const v of nst) pushS(v);
      } else {
        pushS(s.width); pushS(s.style);
        for (let i = 0; i < 8; i++) pushS(quant(s.points[i]!, grid));
      }
    }
  }
  return Bun.gzipSync(Buffer.from(bin), { level: 9 }).length;
}

const samples = ["u571f", "u58eb", "u5e72", "u65e5", "u6708", "u76df", "u9f8d", "u3d64", "u420a"];
console.log("=== 量化格數掃描：像素差異 vs gzip 節省 ===");
console.log("（差異取樣本字的平均相異像素數；括號內為最差者）\n");

const gzBase = gzipOf(0);
console.log(`  gzip 基準（不量化）= ${(gzBase / 1024).toFixed(0)} KB\n`);
console.log("  格數     gzip節省   24×24平均差異(最差)   48×48平均差異(最差)   64×64平均差異(最差)");
for (const grid of [200, 192, 160, 128, 96, 64, 48, 32]) {
  const gz = gzipOf(grid);
  const save = ((gzBase - gz) / gzBase) * 100;
  const cells: string[] = [];
  for (const S of [24, 48, 64]) {
    const diffs: number[] = [];
    for (const n of samples) {
      const gi = lib.names.indexOf(n);
      if (gi < 0) continue;
      const a = raster(lib, gi, S), b = raster(libWith(gi, grid), gi, S);
      let d = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
      diffs.push(d);
    }
    const avg = diffs.reduce((s, v) => s + v, 0) / diffs.length;
    const mx = Math.max(...diffs);
    cells.push(`${avg.toFixed(1).padStart(6)} (${String(mx).padStart(3)})`);
  }
  console.log(`  ${String(grid === 200 ? "不量化" : grid + "×" + grid).padEnd(8)} ${save.toFixed(1).padStart(6)}%   ${cells.join("      ")}`);
}
