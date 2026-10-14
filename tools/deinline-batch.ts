#!/usr/bin/env bun
/**
 * deinline-batch.ts — 把「被畫成原始筆劃的部件」還原成部件引用（第一批）。
 *
 * 分層原則（師父指示）:
 *   * **IDS 是建置期的鷹架**，用來回答「這批筆劃屬於哪個部件」。
 *     它不進字庫、不出貨；使用者只接觸到字形繪製資料。
 *   * 前人為了省事沒做異體部件（木的豎要縮短）就直接拆散重畫。
 *     我們把那些異體**補做出來**：把那組筆劃原封不動變成一個新異體字形，
 *     再用**恆等框** `[0,0,200,200]` 引用它 —— 渲染逐像素相同。
 *   * 不接受「找一個形狀接近的現成異體」那條路：KAGE 的引用框是非等比映射，
 *     硬套會壓到筆寬（實測最佳只有 IoU 70.3%）。
 *
 * 分組（`group` 欄）:
 *   `+`  ⿰／⿲  → 按 x 切
 *   `/`  ⿱／⿳  → 按 y 切
 *   `@`  其餘（嵌套、包圍、⿻…）→ 只有剛好一個部件時才處理，多個就跳過
 *
 * **正確性門檻**：每個部件的**預期筆劃數**加總必須等於該字自己畫的筆劃數。
 * 對不上就整顆不改——寧可少做，也不要分錯組（分錯組渲染看不出來，但會污染檢字）。
 *
 * 用法: bun run tools/deinline-batch.ts [--out out/deinline-variants.tsv]
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  indexOfCodePoint, codePointOf, isPlainIdeograph, displayName, keyOfIdx, toKageData,
} from "./lib-format.ts";
import type { Library, Glyph, Stroke } from "./lib-format.ts";
import { loadLibrary } from "./lib-load.ts";
import { ensureEngine } from "./compose-fit.ts";
import { rasterize } from "./raster.ts";

const ROOT = resolve(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const oi = argv.indexOf("--out");
const OUT = resolve(ROOT, oi >= 0 && argv[oi + 1] ? argv[oi + 1]! : "out/deinline-variants.tsv");

const { lib: L } = loadLibrary(resolve(ROOT, "out/lib-cjk-all.bin.gz"), { withNames: true });
const db = new Database(resolve(ROOT, "db/glyphwiki.db"), { readonly: true });
ensureEngine();

/* ---- 渲染比對：還原前後必須相同（門檻見 MIN_IOU） ----
   為什麼一定要驗：分組分錯**渲染看不出來**，而且把筆劃搬進子字形之後，
   KAGE 的「相鄰筆劃調整」（adjustTate／adjustKakato…）會換一個上下文，
   少數字會真的畫得不一樣（實測 1,409 個裡有 30 個）。 */
const mi = argv.indexOf("--min-iou");
const MIN_IOU = mi >= 0 && argv[mi + 1] ? Number(argv[mi + 1]) : 0.99;
const PARENT_KEY = "p";
const FAKE0 = L.glyphs.length;

function entriesFor(parentGlyph: Glyph, extra: Map<string, Glyph>): [string, Glyph][] {
  const out = new Map<string, Glyph>(extra);
  out.set(PARENT_KEY, parentGlyph);
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
function covOf(entries: [string, Glyph][]): Float32Array {
  const kage = new (globalThis as any).Kage();
  for (const [k, g] of entries) kage.kBuhin.push(k, toKageData(g, L));
  return rasterize(kage, PARENT_KEY, 160, 2).cov;
}
function iou(a: Float32Array, b: Float32Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]! > 0.5, y = b[i]! > 0.5; if (x && y) inter++; if (x || y) uni++; }
  return uni ? inter / uni : 1;
}
const iouHist: number[] = [];

/* ---- 筆劃數（跟字庫同一套：非 99 的線段算 1、kind 0 不算） ---- */
const strokeMemo = new Map<number, number>();
function strokes(i: number): number {
  const hit = strokeMemo.get(i);
  if (hit !== undefined) return hit;
  let n = 0;
  for (const s of L.glyphs[i]!.strokes) {
    if (s.kind === 99 && s.ref !== null) n += strokes(s.ref);
    else if (s.kind !== 0) n += 1;
  }
  strokeMemo.set(i, n);
  return n;
}

/* ---- IDS 直接分量（含算子），建置期查 DB ---- */
type IdsInfo = { op: string | null; comps: number[] };
const idsCache = new Map<number, IdsInfo>();
function idsOf(cp: number): IdsInfo {
  const hit = idsCache.get(cp);
  if (hit) return hit;
  const rows = db.query(
    "SELECT ch, comp_cp, kind FROM ids_comp WHERE codepoint=? ORDER BY pos",
  ).all(cp) as { ch: string; comp_cp: number | null; kind: string }[];
  const op = rows.find((r) => r.kind === "op")?.ch ?? null;
  const comps = rows.filter((r) => r.kind === "char" && r.comp_cp != null && r.comp_cp !== cp)
    .map((r) => r.comp_cp!);
  const info = { op, comps };
  idsCache.set(cp, info);
  return info;
}

const GROUP_OF: Record<string, "+" | "/" | "@"> = {
  "⿰": "+", "⿲": "+", "⿱": "/", "⿳": "/",
};

/** 筆劃的中心（分組要按空間排序） */
function center(s: Stroke): [number, number] {
  let x = 0, y = 0, n = 0;
  for (let i = 0; i + 1 < s.points.length; i += 2) {
    if (!s.points[i] && !s.points[i + 1]) continue;
    x += s.points[i]!; y += s.points[i + 1]!; n++;
  }
  return n ? [x / n, y / n] : [100, 100];
}

type Variant = {
  name: string;          // inl-<來源碼位>-<序號>
  sourceCp: number;
  sourceName: string;
  compCp: number;
  compName: string;
  group: "+" | "/" | "@";
  k: number;
  /** 在**原始 strokes 陣列**裡的位置：引用要插在這裡。
      不能把引用全部排到前面——原始筆劃與引用可能交錯，
      順序一變 KAGE 的相鄰筆劃調整就會改變渲染（實測 10 個字從 100% 掉到 12%）。 */
  at: number;
  /** 這組筆劃在原始 strokes 陣列裡的**實際索引**。
      不能只記「起點 + 長度」——引用或 kind 0 佔位列可能夾在中間，
      用連續區間重建會搬到錯的筆劃（驗證工具就是這樣跟批次對不上的）。 */
  slots: number[];
  nStrokes: number;
  strokes: Stroke[];
};

const variants: Variant[] = [];
const skip = new Map<string, number>();
const bump = (k: string) => skip.set(k, (skip.get(k) ?? 0) + 1);

let done = 0;
for (let gi = 0; gi < L.glyphs.length; gi++) {
  if (!isPlainIdeograph(L, gi)) continue;
  const cp = codePointOf(L, gi);
  if (cp == null) continue;
  /* **只修「代表字形」**：同一個碼位在庫裡可能有好幾個字形（本字＋異體），
     它們的筆劃不見得一樣。修到某個異體上、卻只用碼位記錄來源，
     之後套回代表字形就會搬錯筆劃（驗證工具就是這樣跟批次對不上的：
     㪅 U+3A85 被修的是異體，筆劃跟代表字形完全不同）。 */
  if (indexOfCodePoint(L, cp) !== gi) continue;
  const g = L.glyphs[gi]!;

  const raw: { s: Stroke; i: number }[] = [], refs: Stroke[] = [];
  for (let i = 0; i < g.strokes.length; i++) {
    const s = g.strokes[i]!;
    if (s.kind === 99 && s.ref !== null) refs.push(s);
    else if (s.kind !== 0) raw.push({ s, i });
  }
  if (!raw.length) continue;

  const { op, comps } = idsOf(cp);
  if (!comps.length) continue;

  /* 已經被引用涵蓋的部件先扣掉，剩下的才是被畫成筆劃的。
     **要用「引用可達」而不是「直接引用」**：像 邏 = ⿺辶羅，IDS 的分量是
     辶罒糸隹，但 KAGE 只直接引用「辶」和「羅」——罒糸隹是**間接**可達的，
     不是被畫成筆劃。只比直接引用會把它們全判成內嵌，然後因為筆劃數對不上而整顆跳過
     （實測這是絕大多數「筆劃數對不上」的來源）。 */
  const covered = new Map<number, number>();
  {
    const seen = new Set<number>();
    const stack: number[] = [];
    for (const r of refs) stack.push(r.ref!);
    while (stack.length) {
      const j = stack.pop()!;
      if (seen.has(j)) continue;
      seen.add(j);
      const c = codePointOf(L, j);
      if (c != null) covered.set(c, (covered.get(c) ?? 0) + 1);
      for (const s2 of L.glyphs[j]!.strokes) if (s2.kind === 99 && s2.ref !== null) stack.push(s2.ref);
    }
  }
  const inlined: number[] = [];
  for (const c of comps) {
    const n = covered.get(c) ?? 0;
    if (n > 0) covered.set(c, n - 1);
    else inlined.push(c);
  }
  if (!inlined.length) continue;

  const group: "+" | "/" | "@" = op && GROUP_OF[op] ? GROUP_OF[op]! : "@";
  if (group === "@" && inlined.length > 1) { bump("@ 多部件無法切"); continue; }

  /* 預期筆劃數：加總必須等於自己畫的筆劃數 */
  const need = inlined.map((c) => {
    const ci = indexOfCodePoint(L, c);
    return ci !== undefined ? strokes(ci) : -1;
  });
  if (need.some((n) => n < 0)) { bump("部件不在庫中"); continue; }
  const sum = need.reduce((a, b) => a + b, 0);
  if (sum !== raw.length) { bump("筆劃數對不上（" + raw.length + " vs " + sum + "）"); continue; }

  /* 分組：**照原始筆劃順序切段**，不是按座標重新排序。
     為什麼：KAGE 會看「相鄰筆劃」去調整筆端與折角（adjustTate／adjustKakoto…），
     把筆劃重新排序會改變渲染結果——實測有 10 個字因此從 100% 掉到 12%～89%。
     切段後再用「各段的軸向中心要遞增」當語意檢查（切錯段渲染一樣，
     但部件歸屬會錯，那會污染檢字）。 */
  const axis = group === "/" ? 1 : 0;
  const groups: Stroke[][] = [];
  {
    let p = 0;
    for (const n of need) { groups.push(raw.slice(p, p + n)); p += n; }
  }
  if (group !== "@") {
    const means = groups.map((gs) => gs.reduce((a, x) => a + center(x.s)[axis], 0) / Math.max(1, gs.length));
    let mono = true;
    for (let i = 1; i < means.length; i++) if (means[i]! < means[i - 1]!) mono = false;
    if (!mono) { bump("切段後軸向不遞增（順序與 IDS 對不上）"); continue; }
  }

  /* 渲染比對：把這些群組換成引用之後，跟原版逐像素比 */
  {
    const extra = new Map<string, Glyph>();
    const atMap = new Map<number, { fake: number; n: number }>();
    const consumed = new Set<number>();
    groups.forEach((gs, k) => {
      const fake = FAKE0 + k;
      extra.set(keyOfIdx(L, fake), { tight: null, strokes: gs.map((x) => x.s) });
      atMap.set(gs[0]!.i, { fake, n: gs.length });
      for (const x of gs) consumed.add(x.i);
    });
    const rebuiltStrokes: Stroke[] = [];
    for (let i = 0; i < g.strokes.length; i++) {
      const hit = atMap.get(i);
      if (hit) {
        rebuiltStrokes.push({
          kind: 99, width: 0, style: 0, points: [0, 0, 0, 0, 0, 0, 0, 0],
          ref: hit.fake, box: [0, 0, 200, 200], stretch: 0,
        });
        continue;
      }
      if (consumed.has(i)) continue;
      rebuiltStrokes.push(g.strokes[i]!);
    }
    const before = covOf(entriesFor(g, new Map()));
    const after = covOf(entriesFor({ ...g, tight: null, strokes: rebuiltStrokes }, extra));
    const v = iou(before, after);
    iouHist.push(v);
    if (v < MIN_IOU) { bump("還原後渲染不同（IoU " + (v * 100).toFixed(1) + "% < " + (MIN_IOU * 100) + "%）"); continue; }
  }

  const srcName = displayName(L, gi);
  inlined.forEach((c, k) => {
    const ci = indexOfCodePoint(L, c)!;
    variants.push({
      name: "inl-" + cp.toString(16).toLowerCase() + "-" + k,
      sourceCp: cp, sourceName: srcName,
      compCp: c, compName: displayName(L, ci),
      group, k, at: groups[k]![0]!.i, slots: groups[k]!.map((x) => x.i),
      nStrokes: groups[k]!.length,
      strokes: groups[k]!.map((x) => x.s),
    });
  });
  done++;
}

/* ---- 輸出 ---- */
const head = [
  "name", "source_cp", "source_name", "comp_cp", "comp_name",
  "group", "k", "at", "slots", "n_strokes", "data",
].join("\t");
const lines = [head];
for (const v of variants) {
  const data = v.strokes.map((s) => {
    const pts: number[] = [];
    for (let i = 0; i < 8; i++) pts.push(s.points[i] ?? 0);
    return [s.kind, s.width, s.style, ...pts].join(":");
  }).join("$");
  lines.push([
    v.name,
    "U+" + v.sourceCp.toString(16).toUpperCase(),
    v.sourceName,
    "U+" + v.compCp.toString(16).toUpperCase(),
    v.compName,
    v.group, v.k, v.at, v.slots.join(","), v.nStrokes, data,
  ].join("\t"));
}
writeFileSync(OUT, lines.join("\n"), "utf8");

console.log("=== 第一批異體部件 ===");
console.log(`  還原成功的字：${done.toLocaleString()}`);
console.log(`  產生的異體部件：${variants.length.toLocaleString()}`);
const byGroup = new Map<string, number>();
for (const v of variants) byGroup.set(v.group, (byGroup.get(v.group) ?? 0) + 1);
console.log(`  分組方式：` + [...byGroup.entries()].sort().map(([k, n]) => `${k} ${n.toLocaleString()}`).join("　"));
console.log(`\n  跳過的原因（依類別彙總）：`);
const cat = new Map<string, number>();
for (const [k, n] of skip) {
  const c = k.startsWith("筆劃數對不上") ? "筆劃數對不上（部件不是被畫成筆劃，或分組不適用）" : k;
  cat.set(c, (cat.get(c) ?? 0) + n);
}
for (const [k, n] of [...cat.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(6)}  ${k}`);
}
{
  const sorted = iouHist.slice().sort((a, b) => a - b);
  const q = (p: number) => sorted.length ? sorted[Math.floor(p * (sorted.length - 1))]! : 1;
  console.log(`\n  渲染比對（${sorted.length.toLocaleString()} 個字）：` +
    `最低 ${(q(0) * 100).toFixed(1)}%、中位 ${(q(0.5) * 100).toFixed(1)}%`);
  for (const t of [1, 0.999, 0.99, 0.95, 0.9]) {
    const n = sorted.filter((v) => v >= t).length;
    console.log(`    ≥ ${(t * 100).toFixed(1)}%：${n.toLocaleString()} 個字`);
  }
}
console.log(`\n已寫出 ${OUT}`);

/* 抽樣：每個部件取幾個例子 */
const byComp = new Map<number, Variant[]>();
for (const v of variants) {
  const a = byComp.get(v.compCp);
  if (a) a.push(v); else byComp.set(v.compCp, [v]);
}
const top = [...byComp.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12);
console.log(`\n=== 產出最多的部件（前 12）===`);
console.log("  部件  筆畫  個數   來源字（前 8）");
for (const [cp, list] of top) {
  const ci = indexOfCodePoint(L, cp);
  console.log(`  ${String.fromCodePoint(cp).padEnd(4)} ${String(ci !== undefined ? strokes(ci) : 0).padStart(4)} ` +
    `${String(list.length).padStart(6)}   ${list.slice(0, 8).map((v) => String.fromCodePoint(v.sourceCp)).join(" ")}`);
}
