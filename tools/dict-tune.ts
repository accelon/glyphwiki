// dict-tune.ts — 調整框字典的聚類度量與門檻，找出「視覺可忽略」的設定
//
// 先前的度量：max(|Δx1|,|Δy1|,|Δx2|,|Δy2|) —— 允許 x1 與 x2 各自漂移，
// 所以寬度可能變化 2×tol（例如 x1 往左 2、x2 往右 2 → 寬了 4）。
//
// 改成「位置差」與「尺寸差」分別限制：
//   Δpos = max(|Δx1|, |Δy1|)      左上角位移
//   Δsize = max(|Δw|, |Δh|)       寬高變化
// 這樣寬度變化被直接綁住。
import { readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { decodeLibrary, toKageData } from "./lib-format.ts";
import type { Library, Glyph } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
let engine = "";
for (const f of ["2d.js", "buhin.js", "curve.js", "kage.js", "kagecd.js", "kagedf.js", "polygon.js", "polygons.js"]) {
  engine += readFileSync(`${D}/kage-engine/${f}`, "utf8") + "\n";
}
(0, eval)(engine);
const lib0 = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));

const db = new Database(`${D}/db/glyphwiki.db`, { readonly: true });
const getData = db.query("SELECT data FROM glyphs WHERE name = ?");
const cache = new Map<string, string | null>();
const rawOf = (n: string): string | null => {
  if (!cache.has(n)) {
    let r = getData.get(n) as any;
    if (!r) { const s = n.replace(/@[0-9]+$/, ""); if (s !== n) r = getData.get(s) as any; }
    cache.set(n, r ? (r.data as string) : null);
  }
  return cache.get(n)!;
};

function fill(polys: any, S: number): Uint8Array {
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

function rasterRaw(name: string, S: number): Uint8Array {
  const kage = new Kage();
  const seen = new Set<string>();
  const st = [name];
  while (st.length) {
    const n = st.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    const d = rawOf(n);
    if (d === null) continue;
    kage.kBuhin.push(n, d);
    for (const part of d.split("$")) { const c = part.split(":"); if (parseInt(c[0]!, 10) === 99 && c[7]) st.push(c[7]); }
  }
  const polys = new Polygons(); kage.makeGlyph(polys, name);
  return fill(polys, S);
}

function rasterLib(L: Library, gi: number, S: number): Uint8Array {
  const kage = new Kage();
  const seen = new Set<number>();
  const st = [gi];
  while (st.length) {
    const i = st.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i]!;
    kage.kBuhin.push(L.names[i]!, toKageData(g, L));
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) st.push(s.ref);
  }
  const polys = new Polygons(); kage.makeGlyph(polys, L.names[gi]!);
  return fill(polys, S);
}

/** 依 (Δpos, Δsize) 門檻重建字典並套用到庫 */
function applyDict(tolPos: number, tolSize: number): { lib: Library; reps: number; maxDrift: number } {
  const reps: number[][] = [];
  const assign: number[] = [];
  const grid = new Map<string, number[]>();
  const CELL = 6;
  for (const g of lib0.glyphs) {
    for (const s of g.strokes) {
      if (s.kind !== 99) continue;
      const b = s.box!;
      const w = b[2]! - b[0]!, h = b[3]! - b[1]!;
      let bestI = -1, bestP = Infinity, bestS = Infinity;
      const qx = Math.floor(b[0]! / CELL), qy = Math.floor(b[1]! / CELL);
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
        const list = grid.get(`${qx + dx},${qy + dy}`);
        if (!list) continue;
        for (const k of list) {
          const r = reps[k]!;
          const rw = r[2]! - r[0]!, rh = r[3]! - r[1]!;
          const dp = Math.max(Math.abs(b[0]! - r[0]!), Math.abs(b[1]! - r[1]!));
          const ds = Math.max(Math.abs(w - rw), Math.abs(h - rh));
          if (dp < bestP || (dp === bestP && ds < bestS)) { bestP = dp; bestS = ds; bestI = k; }
          if (bestP === 0 && bestS === 0) break;
        }
      }
      if (bestI >= 0 && bestP <= tolPos && bestS <= tolSize) assign.push(bestI);
      else {
        const k = reps.length;
        reps.push([b[0]!, b[1]!, b[2]!, b[3]!]);
        assign.push(k);
        const gk = `${Math.floor(b[0]! / CELL)},${Math.floor(b[1]! / CELL)}`;
        const l = grid.get(gk); if (l) l.push(k); else grid.set(gk, [k]);
      }
    }
  }
  // 套用
  const glyphs = lib0.glyphs.map((g) => ({ tight: g.tight, strokes: g.strokes.map((s) => ({ ...s })) }));
  let i = 0, maxDrift = 0;
  for (const g of glyphs) {
    for (const s of g.strokes) {
      if (s.kind !== 99) continue;
      const b = s.box!;
      const r = reps[assign[i]!]!;
      maxDrift = Math.max(maxDrift, Math.abs(b[0]! - r[0]!), Math.abs(b[1]! - r[1]!), Math.abs(b[2]! - r[2]!), Math.abs(b[3]! - r[3]!));
      s.box = r.slice(); s.points = r.slice();
      i++;
    }
  }
  return { lib: { names: lib0.names, suffix: lib0.suffix, glyphs }, reps: reps.length, maxDrift };
}

const samples = ["u76df", "u660e", "u6f22", "u67f1", "u571f", "u9f8d"];
console.log("=== 度量：(Δ位置, Δ尺寸) 分別限制 ===\n");
console.log("  門檻(位置,尺寸)  代表框數   24×24最差IoU   48×48最差IoU   maxDrift");
for (const [tp, ts] of [[1, 1], [2, 0], [1, 0], [0, 0], [2, 2]] as [number, number][]) {
  const { lib, reps, maxDrift } = applyDict(tp, ts);
  let worst24 = 1, worst48 = 1;
  for (const s of samples) {
    const gi = lib.names.indexOf(s);
    const name = lib.names[gi]!;
    const j = lib.names.indexOf(name + "-j");
    const use = j >= 0 ? j : gi;
    for (const [S, setter] of [[24, (v: number) => { worst24 = Math.min(worst24, v); }], [48, (v: number) => { worst48 = Math.min(worst48, v); }]] as [number, (v: number) => void][]) {
      const a = rasterRaw(lib.names[use]!, S);
      const b = rasterLib(lib, use, S);
      let inter = 0, uni = 0;
      for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) inter++; if (a[i] || b[i]) uni++; }
      setter(uni ? inter / uni : 1);
    }
  }
  console.log(`  (${tp}, ${ts})`.padEnd(20) + `${String(reps).padStart(8)}   ${worst24.toFixed(3).padStart(11)}   ${worst48.toFixed(3).padStart(11)}   ${maxDrift}`);
}
writeFileSync(`${D}/out/.dict-tune-done`, "1");
db.close();
