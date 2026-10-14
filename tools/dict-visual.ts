// dict-visual.ts — 框字典化後的真實視覺代價（對照「原始資料庫的 KAGE 字串」）
//
// 這是關鍵驗收：不是跟自己的庫比，而是跟資料庫裡人手工調的原始框比。
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { decodeLibrary, toKageData } from "./lib-format.ts";
import type { Library, Glyph } from "./lib-format.ts";

const D = "D:/2023/glyphwiki";
let engine = "";
for (const f of ["2d.js", "buhin.js", "curve.js", "kage.js", "kagecd.js", "kagedf.js", "polygon.js", "polygons.js"]) {
  engine += readFileSync(`${D}/kage-engine/${f}`, "utf8") + "\n";
}
(0, eval)(engine);

// 原始資料庫的 KAGE 字串（人手工調）→ 引擎直接吃
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

/** 用「原始 KAGE 字串」渲染（人手工調的框） */
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
    for (const part of d.split("$")) {
      const c = part.split(":");
      if (parseInt(c[0]!, 10) === 99 && c[7]) st.push(c[7]);
    }
  }
  const polys = new Polygons();
  kage.makeGlyph(polys, name);
  return fill(polys, S);
}

/** 用「精簡庫」渲染 */
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
  const polys = new Polygons();
  kage.makeGlyph(polys, L.names[gi]!);
  return fill(polys, S);
}

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

const lib = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk.bin.gz`))));
const samples = ["u4e00", "u571f", "u58eb", "u5e72", "u65e5", "u6708", "u76df", "u660e", "u5bf6", "u6f22", "u67f1", "u9f8d", "u9f9c"];
console.log("=== 框字典化 vs 資料庫原始框：渲染差異 ===");
console.log("（差異 = 相異像素數；IoU 越接近 1 越好）\n");
for (const S of [24, 48, 64]) {
  console.log(`--- ${S}×${S}（共 ${S * S} 像素）---`);
  let sumDiff = 0, sumIou = 0, n = 0;
  const worst: [string, number, number][] = [];
  for (const s of samples) {
    const gi = lib.names.indexOf(s);
    if (gi < 0) continue;
    const name = lib.names[gi]!;
    // 優先用 -j（有內容的）
    const jIdx = lib.names.indexOf(name + "-j");
    const useIdx = jIdx >= 0 ? jIdx : gi;
    const useName = lib.names[useIdx]!;
    const a = rasterRaw(useName, S);
    const b = rasterLib(lib, useIdx, S);
    let diff = 0, inter = 0, uni = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) diff++;
      if (a[i] && b[i]) inter++;
      if (a[i] || b[i]) uni++;
    }
    const iou = uni ? inter / uni : 1;
    sumDiff += diff; sumIou += iou; n++;
    worst.push([useName, diff, iou]);
  }
  worst.sort((x, y) => y[1] - x[1]);
  console.log(`  平均差異 ${(sumDiff / n).toFixed(1)} 像素、平均 IoU ${(sumIou / n).toFixed(4)}`);
  console.log(`  最差：${worst.slice(0, 3).map(([nm, d, i]) => `${nm}(差${d},IoU${i.toFixed(3)})`).join("  ")}`);
}
db.close();
