// quant-visual.ts — 量化到各格數後，在 24/48/64 點陣下的實際像素差異
//
// 方法：用真正的 kage-engine 渲染（含筆寬與裝飾），把多邊形依奇偶規則填成點陣，
// 對「原始 vs 量化」算逐像素差異與 IoU。
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
const quant = (v: number, grid: number) => grid > 0 ? Math.round((v / 200) * grid) * (200 / grid) : v;

/** 用指定格數量化一個字形（回傳新的字形物件，不改原庫） */
function quantGlyph(g: Glyph, grid: number, self: boolean): Glyph {
  if (!self || grid === 0) return g;
  const strokes = g.strokes.map((s) => {
    if (s.kind === 99) {
      const b = s.box!.map((v) => quant(v, grid));
      const st = s.stretch!;
      return { ...s, box: b, points: b, stretch: st };
    }
    return { ...s, points: s.points.map((v) => quant(v, grid)) };
  });
  return { tight: g.tight, strokes };
}

/** 渲染成點陣（奇偶規則填充），回傳 Uint8Array */
function raster(L: Library, gi: number, S: number): Uint8Array {
  const kage = new Kage();
  const seen = new Set<number>();
  const stack = [gi];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i]!;
    kage.kBuhin.push(L.names[i]!, toKageData(g, L));
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  const polys = new Polygons();
  kage.makeGlyph(polys, L.names[gi]!);

  // 掃描線 + 奇偶規則
  const img = new Uint8Array(S * S);
  const edges: { y1: number; y2: number; x1: number; x2: number }[] = [];
  for (const p of polys.array) {
    const a = p.array;
    for (let i = 0; i + 1 < a.length; i++) {
      edges.push({ x1: a[i]!.x, y1: a[i]!.y, x2: a[i + 1]!.x, y2: a[i + 1]!.y });
    }
    if (a.length > 2) edges.push({ x1: a[a.length - 1]!.x, y1: a[a.length - 1]!.y, x2: a[0]!.x, y2: a[0]!.y });
  }
  for (let py = 0; py < S; py++) {
    const yc = ((py + 0.5) / S) * 200;
    const xs: number[] = [];
    for (const e of edges) {
      const { x1, y1, x2, y2 } = e;
      if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
        xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
      }
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

/**
 * 建一個「量化某字形整個子樹」的庫。
 *
 * 注意：碼位字（如 u4e00）自己的筆畫數是 0——它只是指向 u4e00-j 的引用。
 * 所以只量化目標字本身等於沒量化，必須遞迴整個子樹。
 * @param keepTier1 若提供，這些索引即使出現在子樹中也不量化（模擬常用部件保持全精度）
 */
function libWith(gi: number, grid: number, keepTier1?: Set<number>): Library {
  const glyphs = lib.glyphs.slice();
  const seen = new Set<number>();
  const st = [gi];
  while (st.length) {
    const i = st.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const keep = keepTier1?.has(i) ?? false;
    if (!keep) glyphs[i] = quantGlyph(lib.glyphs[i]!, grid, true);
    for (const s of lib.glyphs[i]!.strokes) {
      if (s.kind === 99 && s.ref !== null) st.push(s.ref);
    }
  }
  return { names: lib.names, suffix: lib.suffix, glyphs };
}

const samples = [
  "u4e00", "u571f", "u58eb", "u5e72", "u65e5", "u6708", "u76df", "u660e",
  "u5bf6", "u6f22", "u67f1", "u9f8d", "u9f9c", "u9ce5",
  "u2a6d6", "u2b81d", "u3d64", "u420a",
];

console.log("=== 量化後在 24/48/64 點陣下的像素差異 ===");
console.log("（差異 = 相異像素數 / 總像素；並列 IoU）\n");

for (const S of [24, 48, 64]) {
  console.log(`--- 點陣 ${S}×${S}（共 ${S * S} 像素）---`);
  console.log("  字        64格差異   64格IoU   48格差異   48格IoU   32格差異   32格IoU");
  for (const n of samples) {
    const gi = lib.names.indexOf(n);
    if (gi < 0) continue;
    const ref = raster(lib, gi, S);
    const out: string[] = [];
    for (const grid of [64, 48, 32]) {
      const img = raster(libWith(gi, grid), gi, S);
      let diff = 0, inter = 0, uni = 0;
      for (let i = 0; i < ref.length; i++) {
        if (ref[i] !== img[i]) diff++;
        if (ref[i] && img[i]) inter++;
        if (ref[i] || img[i]) uni++;
      }
      out.push(`${String(diff).padStart(8)}  ${(uni ? inter / uni : 1).toFixed(3).padStart(7)}`);
    }
    console.log(`  ${n.padEnd(9)} ${out.join(" ")}`);
  }
  console.log("");
}
