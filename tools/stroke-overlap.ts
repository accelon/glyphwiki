// stroke-overlap.ts — 跨部件筆劃最短距離（0 表示相交）
//
// 這是「組字品質把關」的核心量測（施工單 §四 缺口三）。
// 以前本檔在頂層 eval 整份 kage-engine，所以無法內嵌進網頁；
// 現在改成呼叫 compose-fit 的 ensureEngine()（lazy，Node 端才真的載入），
// 這樣同一份原文也能被 `out/kage-viewer.html` 內嵌使用——不會有第二套實作。
import { readFileSync } from "node:fs";
import { decodeLibrary, toKageData, keyOfIdx, indexOfChar } from "./lib-format.ts";
import { composeFit, ensureEngine } from "./compose-fit.ts";
import type { Library } from "./lib-format.ts";

/**
 * 專案根目錄。
 *
 * 名字刻意與其他模組不同（`compose-fit.ts` 用的是 `PROJ_ROOT`）：
 * 內嵌進網頁時，各模組的 export 會被拿掉、全部接在同一個 script 作用域，
 * 同名 `const` 就是 SyntaxError，**整頁都不執行且沒有錯誤訊息**。
 */
const OVERLAP_ROOT = "D:/2023/glyphwiki";

/** 線段到線段最短距離 */
export function segDist(a: number[], b: number[]): number {
  const d2 = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };
  return Math.min(
    d2(a[0]!, a[1]!, b[0]!, b[1]!, b[2]!, b[3]!),
    d2(a[2]!, a[3]!, b[0]!, b[1]!, b[2]!, b[3]!),
    d2(b[0]!, b[1]!, a[0]!, a[1]!, a[2]!, a[3]!),
    d2(b[2]!, b[3]!, a[0]!, a[1]!, a[2]!, a[3]!),
  );
}

/** 取出父字中某個引用在父座標系下的線段集 */
export function refSegments(L: Library, parentIdx: number, strokeIx: number): number[][] {
  const one = L.glyphs[parentIdx]!.strokes[strokeIx]!;
  const kage = new Kage();
  kage.kBuhin.push(
    keyOfIdx(L, parentIdx),
    "99:0:0:" + one.box!.join(":") + ":" + keyOfIdx(L, one.ref!) + ":" + one.stretch!.join(":"),
  );
  const seen = new Set<number>();
  const stack = [one.ref!];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const g = L.glyphs[i]!;
    kage.kBuhin.push(keyOfIdx(L, i), toKageData(g, L));
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
  const polys = new Polygons();
  kage.makeGlyph(polys, keyOfIdx(L, parentIdx));
  const segs: number[][] = [];
  for (const p of polys.array) {
    const a = p.array;
    for (let i = 0; i + 1 < a.length; i++) segs.push([a[i].x, a[i].y, a[i + 1].x, a[i + 1].y]);
    if (a.length > 2) segs.push([a[a.length - 1].x, a[a.length - 1].y, a[0].x, a[0].y]);
  }
  return segs;
}

/** 一個字中，所有「直接子部件」之間的筆劃最短距離 */
export function minCrossDistOf(L: Library, parentIdx: number): number {
  const g = L.glyphs[parentIdx]!;
  const idxs: number[] = [];
  g.strokes.forEach((s, i) => { if (s.kind === 99 && s.ref !== null) idxs.push(i); });
  const sets = idxs.map((i) => refSegments(L, parentIdx, i));
  let best = Infinity;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      for (const a of sets[i]!) {
        for (const b of sets[j]!) {
          const d = segDist(a, b);
          if (d < best) best = d;
        }
      }
    }
  }
  return best;
}

if (import.meta.main) {
  ensureEngine();
  const lib: Library = decodeLibrary(new Uint8Array(Bun.gunzipSync(readFileSync(`${OVERLAP_ROOT}/out/lib-cjk.bin.gz`))));
  console.log("跨部件筆劃最短距離（0 表示相交）\n");
  const cases: [string, string, string][] = [["盟", "皿", "月"], ["寶", "缶", "支"], ["盟", "皿", "日"], ["漢", "氵", "木"]];
  const fmt = (v: number) => (v === Infinity ? "無" : v.toFixed(1));
  for (const [ch, from, to] of cases) {
    const idx = indexOfChar(lib, ch)!;
    const f = composeFit(lib, ch, [[from, to]]);
    console.log(`${ch}${from}${to}`);
    console.log(`  原字 ${ch}     : ${fmt(minCrossDistOf(lib, idx))}`);
    if (!("error" in f)) console.log(`  放入墨跡槽位 : ${fmt(minCrossDistOf(f.lib, f.targetIdx))}`);
    console.log("");
  }
}



