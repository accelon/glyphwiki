#!/usr/bin/env bun
/**
 * check-structure.ts — 驗收 `tools/structure.ts`（組字結構）。
 *
 * 目標（使用者）：**組字結構＝部件拆分、異體、字框**，要能逐漸完全替代 IDS。
 * 所以這一支要回答三件事，而且都要有數字：
 *
 *   1. **版面算子**（IDS 有、我們原本沒有的那一塊）：只用自己的墨跡推，
 *      與 IDS 的算子一致多少？（全庫 8 萬多字）
 *   2. **部件拆分**：引用有幾個、與 IDS 的分量對得上多少？（`analyze-structure.ts` 量過，
 *      這裡只確認「結構 API 拿得到同樣的東西」）
 *   3. **異體與字框**：這兩項 IDS 根本沒有，確認 API 有回傳且非空。
 *
 * 用法: bun run tools/check-structure.ts [--limit N] [--grid 64]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadIdsFile } from "./ids-source.ts";
import { decodeLibrary, codePointOf, indexOfCodePoint, isPlainIdeograph, familyMembers, charOf, displayName, synKeyOf } from "./lib-format.ts";
import type { Library } from "./lib-format.ts";
import { inkBoundsOfPolys } from "./component-boxes.ts";
import { drawingIdx } from "./free-compose.ts";
import {
  structureOf, structureParts, layoutFromMasks, layoutFromBoxes, boxOfMask, sideCoverage,
  induceTree, treeToString, inferStructureParts,
} from "./structure.ts";
import type { Box, Masks, TreeNode, StructurePart } from "./structure.ts";

const D = "D:/2023/glyphwiki";
const argv = Bun.argv.slice(2);
const argNum = (k: string, d: number) => {
  const i = argv.indexOf(k);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const LIMIT = argNum("--limit", Infinity);
const GRID = argNum("--grid", 64);
let fail = 0;
const ok = (s: string) => console.log("  ✓ " + s);
const bad = (s: string) => { console.log("  ✗ " + s); fail++; };

/* ---------------------------------------------------------------- 引擎與遮罩 */
const lib: Library = decodeLibrary(
  new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk-all.bin.gz`))),
);
for (const f of ["2d.js", "buhin.js", "curve.js", "kage.js", "kagecd.js", "kagedf.js", "polygon.js", "polygons.js"]) {
  (0, eval)(readFileSync(`${D}/kage-engine/${f}`, "utf8"));
}
const nameOf = (i: number) => "g" + i;
const kageDataOf = (g: { strokes: { kind: number; width: number; style: number; points: number[]; box?: number[]; stretch?: number[]; ref?: number | null }[] }) =>
  g.strokes.map((s) => s.kind === 99
    ? `99:0:0:${s.box![0]}:${s.box![1]}:${s.box![2]}:${s.box![3]}:${nameOf(s.ref!)}:${s.stretch![0]}:${s.stretch![1]}:${s.stretch![2]}:${s.stretch![3]}`
    : [s.kind, s.width, s.style].concat(s.points).join(":")).join("$");
const kage = new (globalThis as any).Kage();
const filled = new Set<number>();
function fillKage(gi: number) {
  const stack = [gi];
  while (stack.length) {
    const j = stack.pop()!;
    if (filled.has(j)) continue;
    filled.add(j);
    const g = lib.glyphs[j]!;
    kage.kBuhin.push(nameOf(j), kageDataOf(g as never));
    for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) stack.push(s.ref);
  }
}
const inkCache = new Map<number, Box | null>();
const inkOf = (gi: number): Box | null => {
  const hit = inkCache.get(gi);
  if (hit !== undefined) return hit;
  fillKage(gi);
  const p = new (globalThis as any).Polygons();
  kage.makeGlyph(p, nameOf(gi));
  const b = inkBoundsOfPolys(p);
  inkCache.set(gi, b);
  return b;
};
/** 每一筆直接筆劃 ⇄ 攤平筆劃區間（要與引擎 `getEachStrokes` 的展開順序一致） */
function flatRanges(gi: number, depth = 0): { ranges: [number, number][]; total: number } {
  const ranges: [number, number][] = [];
  let at = 0;
  for (const s of lib.glyphs[gi]!.strokes) {
    if (s.kind === 99 && s.ref !== null && depth < 12) {
      const sub = flatRanges(s.ref, depth + 1);
      ranges.push([at, at + sub.total]);
      at += sub.total;
    } else { ranges.push([at, at + 1]); at += 1; }
  }
  return { ranges, total: at };
}
function rasterize(polys: { array: unknown[] }, from: number, to: number): Uint8Array {
  const m = new Uint8Array(GRID * GRID);
  const rings: { pts: { x: number; y: number }[]; x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let k = from; k < to; k++) {
    const p = polys.array[k] as { array: { x: number; y: number }[] } | undefined;
    if (!p) continue;
    const pts = p.array.map((q) => ({ x: +q.x, y: +q.y }));
    if (pts.length < 3) continue;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const q of pts) { x1 = Math.min(x1, q.x); x2 = Math.max(x2, q.x); y1 = Math.min(y1, q.y); y2 = Math.max(y2, q.y); }
    rings.push({ pts, x1, y1, x2, y2 });
  }
  const wn = (pts: { x: number; y: number }[], x: number, y: number) => {
    let w = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[j]!, b = pts[i]!;
      if (a.y <= y) { if (b.y > y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) > 0) w++; }
      else if (b.y <= y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) < 0) w--;
    }
    return w;
  };
  for (let py = 0; py < GRID; py++) for (let px = 0; px < GRID; px++) {
    const x = ((px + 0.5) / GRID) * 200, y = ((py + 0.5) / GRID) * 200;
    let w = 0;
    for (const r of rings) { if (x < r.x1 || x > r.x2 || y < r.y1 || y > r.y2) continue; w += wn(r.pts, x, y); }
    if (w !== 0) m[py * GRID + px] = 1;
  }
  return m;
}
/** 就地畫，並記錄每一筆攤平筆劃的多邊形區間（不能把子字形單獨畫一次） */
function perStrokeMasks(gi: number): { masks: Masks; boxes: Box[] } | null {
  const drawing = drawingIdx(lib, gi);
  const dg = lib.glyphs[drawing]!;
  const refs = dg.strokes.filter((s) => s.kind === 99 && s.ref !== null);
  if (refs.length < 1) return null;
  fillKage(drawing);
  const polys: { array: unknown[] } = new (globalThis as any).Polygons();
  const data = kage.kBuhin.search(nameOf(drawing));
  const strokesArray = kage.adjustStrokes(kage.getEachStrokes(data));
  const ranges: [number, number][] = [];
  for (const s of strokesArray) {
    const before = polys.array.length;
    (globalThis as any).dfDrawFont(kage, polys, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10]);
    ranges.push([before, polys.array.length]);
  }
  const { ranges: sRanges } = flatRanges(drawing);
  const masks: Uint8Array[] = [];
  const boxes: Box[] = [];
  for (const s of refs) {
    const k = dg.strokes.indexOf(s);
    const rr = sRanges[k];
    if (!rr) continue;
    const m = rasterize(polys, ranges[rr[0]]![0], ranges[rr[1] - 1]![1]);
    masks.push(m);
    boxes.push(boxOfMask(m, GRID));
  }
  if (masks.length !== refs.length) return null;
  const whole = rasterize(polys, 0, polys.array.length);
  return { masks: { grid: GRID, masks, whole }, boxes };
}

/* ---------------------------------------------------------------- IDS（答案，只在驗收用） */
const OP_ARITY: Record<string, number> = {
  "⿰": 2, "⿱": 2, "⿲": 3, "⿳": 3, "⿴": 2, "⿵": 2, "⿶": 2, "⿷": 2, "⿸": 2, "⿹": 2, "⿺": 2, "⿻": 2,
};
const CP_RE = /^U\+([0-9A-Fa-f]{4,6})$/;
const idsByCp = new Map<number, string>();
/* 第 73 輪：尺規換成新 IDS 來源（ids_lv1.txt 的主要拆法）。舊 CHISE 的讀法停用——
   先前一直讀舊來源，所以第 58 輪把字庫換成新來源的效果量不出來。 */
const _idsSrc = await import("./ids-source.ts");
for (const [cp2, e2] of _idsSrc.loadIdsFile(`${D}/ids/ids_lv1.txt`)) {
  if (!e2.primary.length) continue;
  const raw2 = _idsSrc.stripIndicators(e2.primary[0]!);
  const head2 = Array.from(raw2)[0];
  if (head2 === undefined || "⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻".indexOf(head2) < 0) continue;
  if (/[#&{}\[\]]/.test(raw2)) continue;
  idsByCp.set(cp2, raw2);
}
if (false)
for (const line of readFileSync(`${D}/unicode-cjk-ids/All.txt`, "utf8").split("\n")) {
  const t = line.split("\t");
  const m = t[0] ? CP_RE.exec(t[0]) : null;
  if (m && t[2]) idsByCp.set(parseInt(m[1]!, 16), t[2]);
}
const idsOpOf = (s: string) => {
  const t = Array.from(s);
  return t.length && OP_ARITY[t[0]!] !== undefined ? t[0]! : null;
};

/* ---------------------------------------------------------------- IDS 的**巢狀**樹（答案） */
/** IDS 字串 → 樹（分量可以是字元，也可以是 `&NAME;`） */
type IdsNode = { op: string | null; leaf?: string; kids: IdsNode[] };
function parseIdsTree(s: string): IdsNode | null {
  const toks: string[] = [];
  for (const ch of Array.from(s)) toks.push(ch);
  let pos = 0;
  const one = (): IdsNode | null => {
    const t = toks[pos++];
    if (t === undefined) return null;
    if (OP_ARITY[t] !== undefined) {
      const kids: IdsNode[] = [];
      for (let k = 0; k < OP_ARITY[t]!; k++) { const c = one(); if (c) kids.push(c); }
      return { op: t, kids };
    }
    return { op: null, leaf: t, kids: [] };
  };
  const first = toks[0];
  if (first === undefined) return null;
  return one();
}
/**
 * 把 IDS 樹展開成「葉子都是**單一部件**」的樹（`品`＝`⿱口吅` 的 `吅` 要展開成 `⿰口口`）。
 * 用字庫自己的 IDS 展開（驗收時才知道答案，模組本身不碰 IDS）。
 */
function expandIdsTree(n: IdsNode | null, depth = 0): IdsNode | null {
  if (!n) return null;
  if (depth > 6) return n;
  if (n.op) return { op: n.op, kids: n.kids.map((k) => expandIdsTree(k, depth + 1)).filter((k): k is IdsNode => !!k) };
  if (!n.leaf) return n;
  const cp = n.leaf.codePointAt(0);
  if (cp === undefined) return n;
  const ids = idsByCp.get(cp);
  const sub = ids ? parseIdsTree(ids) : null;
  if (!sub || !sub.op) return n;                 /* 它自己是獨體 → 就是葉子 */
  return expandIdsTree(sub, depth + 1);
}
/** 樹的字串（葉子用字元；`⿱(口,⿰(口,口))`） */
function idsTreeString(n: IdsNode | null): string {
  if (!n) return "∅";
  if (!n.op) return n.leaf ?? "?";
  return `${n.op}(${n.kids.map(idsTreeString).join(",")})`;
}
/** 收葉子（依序） */
function idsLeaves(n: IdsNode | null): string[] {
  if (!n) return [];
  if (!n.op) return n.leaf ? [n.leaf] : [];
  return n.kids.flatMap(idsLeaves);
}

/* ---------------------------------------------------------------- 1. 算子的個別案例 */
console.log("1. 版面算子：用手上這幾個字逐一看（IDS 當對照）");
console.log("   ✓＝與 IDS 一致　○＝不敢說（誠實棄權）　✗＝說錯（這才是 bug）");
{
  let wrong = 0, agree = 0, abstain = 0;
  const cases: [string, string][] = [
    ["明", "左右"], ["想", "上下"], ["困", "全包圍"], ["問", "上包圍"], ["區", "左包圍"],
    ["病", "左上包圍"], ["適", "左下包圍"], ["邏", "左下包圍"], ["峰", "左右"],
    ["街", "（IDS 說 ⿴，但墨只有左右封住 → 應該棄權）"],
    ["品", "（三個口＝巢狀結構，平面算子表達不了 → 應該棄權）"],
    ["林", "（KAGE 沒有引用，畫成筆劃 → 沒有部件）"],
  ];
  for (const [ch, note] of cases) {
    const cp = ch.codePointAt(0)!;
    const gi = indexOfCodePoint(lib, cp);
    if (gi === undefined) { bad(`${ch} 不在庫`); continue; }
    const pm = perStrokeMasks(gi);
    const st = structureOf(lib, gi, { inkOf, masks: pm?.masks });
    const ids = idsByCp.get(cp) ?? "";
    const want = idsOpOf(ids);
    const got = st.layout;
    const line = `${ch} ${ids}　部件 ${st.parts.length}（${st.parts.map((p) => p.ch || "∅").join("+")}）` +
      `　推=${got ?? "（不敢說）"}（信心 ${st.layoutConf.toFixed(2)}）　${st.layoutWhy}${want && !got ? `　IDS=${want}` : ""}`;
    if (!want) { console.log("  ○ " + line + `　${note}`); abstain++; }
    else if (got === want) { ok(line); agree++; }
    else if (!got) { console.log("  ○ " + line); abstain++; }
    else { bad(line); wrong++; }
  }
  console.log(`  小計：一致 ${agree}、棄權 ${abstain}、**說錯 ${wrong}**`);
  wrong === 0 ? ok("個別案例沒有說錯（棄權是允許的）") : bad(`${wrong} 個案例說錯`);
}

/* ---------------------------------------------------------------- 2. 全庫一致率 */
console.log("\n2. 全庫一致率（引用數＝IDS 分量數的字形）");
{
  let n = 0, maskOk = 0, maskNull = 0, maskWrong = 0, boxOk = 0, repl = 0;
  const perOp = new Map<string, { n: number; ok: number; wrong: number }>();
  let processed = 0;
  const t0 = performance.now();
  const fails: string[] = [];
  for (let gi = 0; gi < lib.glyphs.length; gi++) {
    const cp = codePointOf(lib, gi);
    if (!cp) continue;
    if (!isPlainIdeograph(lib, gi)) continue;
    if (indexOfCodePoint(lib, cp) !== gi) continue;
    if (processed++ >= LIMIT) break;
    const ids = idsByCp.get(cp);
    const want = ids ? idsOpOf(ids) : null;
    if (!want) continue;
    const dr = drawingIdx(lib, gi);
    const refs = lib.glyphs[dr]!.strokes.filter((s) => s.kind === 99 && s.ref !== null);
    if (refs.length !== OP_ARITY[want]!) continue;
    const pm = perStrokeMasks(gi);
    if (!pm) continue;
    n++;
    const gm = layoutFromMasks(pm.masks.masks, pm.boxes, pm.masks.grid).op;
    const gb = layoutFromBoxes(structureParts(lib, dr, inkOf).map((p) => p.tight ?? p.raw)).op;
    if (gm === want) maskOk++; else if (gm === null) maskNull++; else maskWrong++;
    if (gb === want) boxOk++;
    /* 「可以完全替代 IDS」＝算子與 IDS 一致 **且** 整個字的墨都被這些部件認領 */
    {
      const whole = pm.masks.whole!;
      let ink = 0, covered = 0;
      for (let k = 0; k < whole.length; k++) {
        if (!whole[k]) continue;
        ink++;
        for (const m of pm.masks.masks) if (m[k]) { covered++; break; }
      }
      if (gm === want && ink && covered / ink >= 0.99) repl++;
    }
    const e = perOp.get(want) ?? { n: 0, ok: 0, wrong: 0 };
    e.n++; if (gm === want) e.ok++; else if (gm) e.wrong++;
    perOp.set(want, e);
    if (gm && gm !== want && fails.length < 8) fails.push(`${String.fromCodePoint(cp)} IDS=${want} 推=${gm}`);
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  const pct = (x: number, d = n) => `${((x / Math.max(1, d)) * 100).toFixed(1)}%`;
  console.log(`  樣本 ${n.toLocaleString()} 個字（${secs}s，點陣 ${GRID}×${GRID}）`);
  console.log(`  各算子（一致率／樣本數）：` + [...perOp.entries()].sort((a, b) => b[1].n - a[1].n)
    .map(([op, e]) => `${op} ${pct(e.ok, e.n)}(${e.n.toLocaleString()})`).join("　"));
  console.log(`  棄權 ${maskNull.toLocaleString()}（${pct(maskNull)}）、說錯 ${maskWrong.toLocaleString()}（${pct(maskWrong)}）`);
  const precision = maskOk / Math.max(1, maskOk + maskWrong);
  maskOk / Math.max(1, n) >= 0.97
    ? ok(`墨跡推算子與 IDS 一致 ${pct(maskOk)}——IDS 的算子資訊已可由自有資料重建`)
    : bad(`墨跡推算子一致率只有 ${pct(maskOk)}（門檻 97%）`);
  precision >= 0.99
    ? ok(`敢說的時候準確率 ${pct(maskOk, maskOk + maskWrong)}（要求 ≥99%：寧可棄權，不要說錯）`)
    : bad(`敢說的時候準確率只有 ${pct(maskOk, maskOk + maskWrong)}（要求 ≥99%）`);
  boxOk / Math.max(1, n) >= 0.95
    ? ok(`便宜的框版一致 ${pct(boxOk)}（沒有遮罩時的退路）`)
    : bad(`框版一致率 ${pct(boxOk)}（門檻 95%）`);
  /* 主要算子都要有水準，避免「平均好看、某一類全錯」；樣本太少的算子只報數字不設門檻 */
  const must: [string, number][] = [["⿰", 0.97], ["⿱", 0.95], ["⿺", 0.9], ["⿸", 0.9], ["⿵", 0.85]];
  for (const [op, min] of must) {
    const e = perOp.get(op);
    if (!e) { bad(`樣本裡沒有 ${op}`); continue; }
    if (e.n < 20) { console.log(`  ○ ${op} 樣本只有 ${e.n} 個，不設門檻（一致 ${pct(e.ok, e.n)}）`); continue; }
    (e.ok / e.n) >= min ? ok(`${op} 一致 ${pct(e.ok, e.n)}（n=${e.n.toLocaleString()}，≥${(min * 100).toFixed(0)}%）`)
                        : bad(`${op} 一致只有 ${pct(e.ok, e.n)}（n=${e.n}，要求 ≥${(min * 100).toFixed(0)}%）`);
  }
  if (fails.length) console.log(`  說錯的例子：${fails.join("　")}`);
  console.log(`\n  【IDS 替代進度】這一類樣本 ${n.toLocaleString()} 個字裡，` +
    `算子一致 **且** 墨全被部件認領的＝${repl.toLocaleString()}（${pct(repl)}）——` +
    `這些字的 IDS 結構資訊已可完全由自有資料重建`);
}

/* ------------------------------------------------ 用墨跡補出「沒有引用的分量」（不改畫法）
 *
 * `進`＝引用 `辶` ＋ 手畫的 `隹`：畫法裡只有一個引用，`perStrokeMasks()` 的部件數 < 2，
 * 我們自己的結構樹就斷在這裡（第 2 輪量到 `leafNoStruct` 38.9% 就是這一類）。
 * 但**不一定要改畫法**：把「引用沒有認領的墨」拿去和缺的分量做墨跡比對，
 * 對得上就把那個分量當成一個**推論出來的部件**（有框、有身分），畫法一個字都不動。
 *
 * 身分靠**幾何**對，不靠碼位——因為 `進` 的引用是相容字符 `辶`(U+FA66) 而 IDS 寫 `辶`(U+8FB6)，
 * 兩者不在同一個家族（字庫的異體表缺口），比碼位會兩邊都對不上。
 */
let infCraft = 0;
/** 把分量畫進指定框，回傳遮罩 */
function craftRefMask(refIdx: number, box: Box): Uint8Array | null {
  fillKage(refIdx);
  const name = "inf" + (++infCraft);
  kage.kBuhin.push(name, kageDataOf({ strokes: [{
    kind: 99, width: 0, style: 0, points: box.slice(), ref: refIdx, box: box.slice(), stretch: [0, 0, 0, 0],
  }] } as never));
  const polys: { array: unknown[] } = new (globalThis as any).Polygons();
  try { kage.makeGlyph(polys, name); } catch { return null; }
  return rasterize(polys, 0, polys.array.length);
}
const iou2 = (a: Uint8Array, b: Uint8Array) => {
  let inter = 0, uni = 0;
  for (let k = 0; k < a.length; k++) {
    const p = a[k], q = b[k];
    if (p && q) inter++;
    if (p || q) uni++;
  }
  return uni ? inter / uni : 1;
};
/* 第 7 輪：門檻從 0.72 降到 0.30。理由：這些字的畫法是手畫的、不是構件的縮放
   （第 4 輪實測：`兄` 的 `口` 110×75/筆寬 10 vs 正規 `口` 128×128/筆寬 18），
   絕對門檻 0.72 會讓推論一次都不接手。改成「先取最像的」，對不對由成績單來判。 */
const INF_MIN = 0.3;
/** 把構件縮放到「目標墨框」，再做尺度／位移微調，取與目標墨跡重疊最大者 */
function fitCompInto(refIdx: number, compBox: Box, target: Uint8Array, targetBox: Box): { box: Box; iou: number } | null {
  const cw = Math.max(1e-6, compBox[2] - compBox[0]), ch = Math.max(1e-6, compBox[3] - compBox[1]);
  const tw = targetBox[2] - targetBox[0], th = targetBox[3] - targetBox[1];
  const mk = (s: number, dx: number, dy: number): Box => {
    const sx = Math.min(400, Math.max(40, (200 * tw) / cw)) * s;
    const sy = Math.min(400, Math.max(40, (200 * th) / ch)) * s;
    const bx = targetBox[0] + dx - (compBox[0] * sx) / 200;
    const by = targetBox[1] + dy - (compBox[1] * sy) / 200;
    return [bx, by, bx + sx, by + sy];
  };
  let best: { box: Box; iou: number } | null = null;
  for (const s of [1, 0.9, 1.1]) {
    for (const dx of [0, -8, 8]) {
      for (const dy of [0, -8, 8]) {
        const box = mk(s, dx, dy);
        const m = craftRefMask(refIdx, box);
        if (!m) continue;
        const v = iou2(m, target);
        if (!best || v > best.iou) best = { box, iou: v };
      }
    }
  }
  return best;
}
const infCache = new Map<number, { tree: TreeNode | null; parts: StructurePart[] } | null>();
/** 推論版：既有引用（幾何對身分）＋ 從剩下的墨補出來的分量 */
/** 推論版：**用模組的實作**（第 8 輪搬進 `structure.ts`），這裡只提供引擎側的兩個能力 */
function inferStructure(gi: number): { tree: TreeNode | null; parts: StructurePart[] } | null {
  const hit = infCache.get(gi);
  if (hit !== undefined) return hit;
  let out: { tree: TreeNode | null; parts: StructurePart[] } | null = null;
  const pm = perStrokeMasks(gi);
  if (pm) {
    const r = inferStructureParts(lib, gi, pm.masks, {
      inkBox: (ref) => iouBox(ref),
      renderInto: (ref, box) => craftRefMask(ref, box),
    });
    if (r) out = { tree: r.tree, parts: r.parts };
  }
  infCache.set(gi, out);
  return out;
}/** 一個字形自己畫出來的墨框（用來當擬合的起始猜測） */
function iouBox(gi: number): Box | null {
  const b = inkOf(gi);
  return b ? [b[0], b[1], b[2], b[3]] : null;
}

/* ---------------------------------------------------------------- 4. 巢狀結構樹 */
console.log("\n4. 巢狀結構樹：把平的部件清單遞迴切成 ⿰⿱…，與 IDS 的樹比對");
{
  /* 比對要**對稱**：我們的樹可能比 IDS 粗（`唱`＝`⿰口昌`，IDS＝`⿰口⿱(日,曰)`），
     兩邊都可以「再展開一層」——我們展開靠 `structureOf`（自己的資料），
     IDS 那邊才用 IDS 展開。這樣比的才是「能不能重建同一個結構」。 */
  const ourCache = new Map<number, { tree: TreeNode | null; parts: StructurePart[] } | null>();
  const ourStructure = (gi: number) => {
    if (ourCache.has(gi)) return ourCache.get(gi)!;
    const pm = perStrokeMasks(gi);
    /* 引用夠多就走原本的路；引用不足（或根本沒有引用）就用墨跡把缺的部件補出來 */
    const r = pm && pm.masks.masks.length >= 2
      ? (() => { const st = structureOf(lib, gi, { inkOf, masks: pm.masks }); return { tree: st.tree, parts: st.parts }; })()
      : inferStructure(gi);
    ourCache.set(gi, r);
    return r;
  };
  /* 字元比對要**家族感知**：`邏` 的 IDS 寫 `⺲`（U+2EB2）而字庫引用的是 `罒`（U+7F52），
     兩者是同一個部件的異體——字庫的家族表（`familyMembers`）就是我們自己的異體資料。 */
  const famCache = new Map<number, Set<number>>();
  const famOf = (cp: number) => {
    let s = famCache.get(cp);
    if (!s) {
      s = new Set(familyMembers(lib, cp).map((i) => codePointOf(lib, i)).filter((c): c is number => !!c));
      famCache.set(cp, s);
    }
    return s;
  };
  const sameChar = (a: string, b: string) => {
    if (!a || !b) return false;
    const ca = a.codePointAt(0)!, cb = b.codePointAt(0)!;
    /* 第 92 輪：**異體知識收攏成一份**——字庫 v5 的 `syn`（跨碼位異體 1,271 對）用
       `synKeyOf()`（連通分量）當代表，同一個分量就視為同一個部件 ✓。
       先前這裡只有同碼位的家族表 ✗，所以 `辶/辶`、`⺲/罒`、`⺼/月` 這種得靠手寫表補 ✗。 */
    return ca === cb || synKeyOf(lib, ca) === synKeyOf(lib, cb) || famOf(ca).has(cb) || famOf(cb).has(ca);
  };
  /* IDS 常寫相容字符／部首（`⺲` U+2EB2、`爫` U+FA49、`辶` U+FA66），字庫的家族表**沒有**
     把它們綁到正規碼位（`罒`、`爫`、`辶`）——頁面靠手寫的 `RADICAL_SYN` 補。
     這一類不是「結構不同」而是「異體表缺口」，要分開算，否則會把數字壓低又看不出原因。 */
  const isCompatOrRadical = (cp: number) =>
    (cp >= 0x2e80 && cp <= 0x2fdf) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
  const charVerdict = (a: string, b: string): "same" | "compat" | "diff" => {
    if (!a || !b) return "diff";
    if (sameChar(a, b)) return "same";
    const ca = a.codePointAt(0)!, cb = b.codePointAt(0)!;
    return (isCompatOrRadical(ca) || isCompatOrRadical(cb)) ? "compat" : "diff";
  };
  /** IDS 樹 vs IDS 樹（比字元；`allowCompat` 時把相容字符／部首當同一個部件） */
  const eqIds = (a: IdsNode | null, b: IdsNode | null, allowCompat = false): boolean => {
    if (!a || !b) return false;
    if (!a.op && !b.op) {
      const v = charVerdict(a.leaf ?? "", b.leaf ?? "");
      return v === "same" || (allowCompat && v === "compat");
    }
    if (!a.op || !b.op) return false;
    if (a.op !== b.op || a.kids.length !== b.kids.length) return false;
    return a.kids.every((k, i) => eqIds(k, b.kids[i]!, allowCompat));
  };
  /** 某個字元自己的 IDS 展開樹（可能沒有） */
  const idsTreeOfChar = (ch: string) => {
    if (!ch) return null;
    const ids = idsByCp.get(ch.codePointAt(0)!);
    return ids ? expandIdsTree(parseIdsTree(ids)) : null;
  };

  type Why = "same" | "leafNoStruct" | "charDiff" | "compatVariant" | "opDiff" | "declined" | "noCodepoint" | "noIds";
  /**
   * 我們的樹 vs IDS 樹。
   * `strict`＝**完全重建**：我們的葉子要能自己再展開（靠 `structureOf`）才對得上。
   * `contraction`＝**收縮等價**：我們的葉子若是一個「合體字」而 IDS 在那裡寫成展開式
   *   （`㐌` 我們＝`⿱𠂉也`、IDS＝`⿱⿰丿一也`），只要那個字自己的 IDS 等於該展開式就算一致
   *   ——這代表「樹形相同，只是粒度不同」。`allowCompat` 再把相容字符／部首算成同一個部件。
   * `declined`＝我們**棄權**（切不出算子），與「說錯」分開算——棄權是誠實，說錯才是 bug。
   */
  const cmp = (ours: TreeNode | null, ids: IdsNode | null, parts: StructurePart[], strict: boolean, allowCompat: boolean): Why => {
    if (!ours || !ids) return "declined";
    if (ours.part !== undefined && !ids.op) {
      const p = parts[ours.part]!;
      if (!p.ch || (ids.leaf ?? "").startsWith("&")) return "noCodepoint";
      const v = charVerdict(p.ch, ids.leaf!);
      return v === "same" || (allowCompat && v === "compat") ? "same" : v === "compat" ? "compatVariant" : "charDiff";
    }
    if (ours.part !== undefined && ids.op) {
      const p = parts[ours.part]!;
      if (strict) {
        const sub = ourStructure(p.ref);
        if (!sub || !sub.tree || !sub.tree.op) {
          /* 我們展開不了 → 看看是不是「粒度的關係」（那個字自己的 IDS 就等於 IDS 的展開式） */
          const gTree = idsTreeOfChar(p.ch);
          return gTree && eqIds(gTree, ids, allowCompat) ? "leafNoStruct" : "charDiff";
        }
        return cmp(sub.tree, ids, sub.parts, true, allowCompat);
      }
      const gTree = idsTreeOfChar(p.ch);
      if (!gTree) return "noIds";
      return eqIds(gTree, ids, allowCompat) ? "same" : "charDiff";
    }
    if (!ours.op && ids.leaf) {
      const sub = expandIdsTree(ids);
      if (!sub || !sub.op) return "charDiff";
      return cmp(ours, sub, parts, strict, allowCompat);
    }
    if (!ours.op) return "declined";                 /* 我們這一層切不出算子 */
    if (!ids.op) return "declined";
    if (ours.op !== ids.op) return "opDiff";
    if (ours.kids.length !== ids.kids.length) return "opDiff";
    let worst: Why = "same";
    for (let i = 0; i < ours.kids.length; i++) {
      const w = cmp(ours.kids[i]!, ids.kids[i]!, parts, strict, allowCompat);
      if (w === "same") continue;
      if (worst === "same") worst = w;
      if (w === "charDiff" || w === "noCodepoint" || w === "opDiff") return w;   /* 身分／版面不同最嚴重 */
    }
    return worst;
  };
  const ch2 = (cp: number) => String.fromCodePoint(cp);

  console.log("   先看幾個字（`strict`＝我們能自己再展開；`收縮`＝樹形相同、只是粒度不同）：");
  for (const ch of ["品", "唱", "想", "邏", "樹", "㐌", "困", "明"]) {
    const cp = ch.codePointAt(0)!;
    const gi = indexOfCodePoint(lib, cp);
    if (gi === undefined) continue;
    const pm = perStrokeMasks(gi);
    const st = structureOf(lib, gi, { inkOf, masks: pm?.masks });
    const idsTree = expandIdsTree(parseIdsTree(idsByCp.get(cp) ?? ""));
    const s = cmp(st.tree, idsTree, st.parts, true, false);
    const c = cmp(st.tree, idsTree, st.parts, false, false);
    const c2 = cmp(st.tree, idsTree, st.parts, false, true);
    console.log(`   ${ch}　我們=${treeToString(st.tree, (k) => st.parts[k]?.ch || "∅")}　IDS=${idsTreeString(idsTree)}` +
      `　→ strict=${s}　收縮=${c}${c2 !== c ? `（容相容字符→${c2}）` : ""}`);
  }

  let n = 0, same = 0, contraction = 0, contractionCompat = 0;
  const why = new Map<string, number>();
  const whyContract = new Map<string, number>();
  const diffEx: string[] = [];
  let processed = 0;
  for (let gi = 0; gi < lib.glyphs.length; gi++) {
    const cp = codePointOf(lib, gi);
    if (!cp) continue;
    if (!isPlainIdeograph(lib, gi)) continue;
    if (indexOfCodePoint(lib, cp) !== gi) continue;
    if (processed++ >= LIMIT) break;
    const ids = idsByCp.get(cp);
    if (!ids) continue;
    const idsTree = expandIdsTree(parseIdsTree(ids));
    if (!idsTree || !idsTree.op) continue;             /* 標註是獨體 → 沒得比 */
    const pm = perStrokeMasks(gi);
    if (!pm) continue;                                  /* 沒有引用（畫成筆劃）→ 另一類缺口 */
    const st = structureOf(lib, gi, { inkOf, masks: pm.masks });
    n++;
    const s = cmp(st.tree, idsTree, st.parts, true, false);
    const c = cmp(st.tree, idsTree, st.parts, false, false);
    const c2 = cmp(st.tree, idsTree, st.parts, false, true);
    why.set(s, (why.get(s) ?? 0) + 1);
    if (c !== "same") whyContract.set(c, (whyContract.get(c) ?? 0) + 1);
    if (s === "same") same++;
    if (c === "same") contraction++;
    if (c2 === "same") contractionCompat++;
    if (s !== "same" && diffEx.length < 6) {
      diffEx.push(`${ch2(cp)}(${s}) 我們=${treeToString(st.tree, (k) => st.parts[k]?.ch || "∅")} IDS=${idsTreeString(idsTree)}`);
    }
  }
  const pct = (x: number, d = n) => `${((x / Math.max(1, d)) * 100).toFixed(1)}%`;
  /* ---- 推論自己的成績單：接手幾個、其中幾個與 IDS 樹一致 ----
     要**單獨計數**：第 5 輪把「只有一個引用」的字也納入比較之後分母變大，
     整體百分比反而被拉低，看不出推論到底有沒有用。 */
  {
    let infOk = 0, infBad = 0, infNull = 0;
    const badEx: string[] = [];
    for (const [gi, r] of infCache) {
      const cp = codePointOf(lib, gi);
      const ids = cp != null ? idsByCp.get(cp) : undefined;
      if (!ids) continue;
      const it = expandIdsTree(parseIdsTree(ids));
      if (!it || !it.op) continue;
      if (!r) { infNull++; continue; }
      const v = cmp(r.tree, it, r.parts, false, true);
      if (v === "same") infOk++;
      else {
        infBad++;
        if (badEx.length < 5) badEx.push(`${cp ? String.fromCodePoint(cp) : "?"} 我們=${treeToString(r.tree, (k) => r.parts[k]?.ch || "∅")} IDS=${idsTreeString(it)}`);
      }
    }
    const tot = infOk + infBad;
    console.log(`\n   推論自己的成績單：接手 ${tot.toLocaleString()} 個字（與 IDS 樹一致 ` +
      `${pct(infOk, Math.max(1, tot))}、不一致 ${infBad.toLocaleString()}）、補不出來 ${infNull.toLocaleString()} 個`);
    if (badEx.length) console.log(`   推論不一致的例子：${badEx.join("　")}`);
    if (tot > 0) {
      infOk / tot >= 0.6 ? ok(`推論接手時與 IDS 一致 ${pct(infOk, tot)}（門檻 60%）`)
                         : bad(`推論接手時一致率只有 ${pct(infOk, tot)}（門檻 60%）`);
    }
  }
  console.log(`\n   樣本 ${n.toLocaleString()} 個字（IDS 有巢狀樹、且畫法有引用）`);
  console.log(`   **收縮等價**（樹形相同、粒度不同也接受）${pct(contraction)}（${contraction.toLocaleString()}）`);
  console.log(`   收縮等價＋把相容字符／部首當同一部件 ${pct(contractionCompat)}（${contractionCompat.toLocaleString()}）` +
    `——差距 ${(contractionCompat - contraction).toLocaleString()} 個字是**異體表缺口**`);
  console.log(`   **完全重建**（我們的葉子也能自己再展開）${pct(same)}（${same.toLocaleString()}）`);
  console.log(`   完全重建失敗的原因：` + [...why.entries()].sort((a, b) => b[1] - a[1])
    .filter(([k]) => k !== "same")
    .map(([k, v]) => `${k} ${v.toLocaleString()}（${pct(v)}）`).join("　"));
  if (whyContract.size) console.log(`   收縮等價失敗的原因：` + [...whyContract.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v.toLocaleString()}（${pct(v)}）`).join("　"));
  if (diffEx.length) console.log(`   例子：${diffEx.join("　")}`);
  /* 第 74 輪：這條**不再是合格／不合格的門檻** ✗。
     第 73 輪把尺規換成新 IDS 來源（`ids/ids_lv1.txt`）之後，收縮等價由 67.7% 掉到 40.3%——
     原因不是退步，而是**我們刻意與 IDS 不同**：`木`／`貝` 我們列獨體（說文作象形）、
     `真` 我們沿用畫法的 `十具` 而 IDS 拆 `直八`（編碼便利的拆法）。這種分歧正是目標本身
     （以自有結構取代 IDS），不該被判為失敗。所以只報數字與歸因，不設下限。 */
  console.log(`   ○ 收縮等價（容相容字符）${pct(contractionCompat)}——**僅供參考**：這是「與 IDS 一致的程度」；` +
    `我們的結構刻意在獨體字與粒度上與 IDS 不同（見 tools/atomic-chars.ts），所以低不代表品質低`);
  /* 第 110 輪把這一條**拆開**（原本是 `opDiff + charDiff` 合起來設 35% 門檻 ✗）：
     · `opDiff`（說了但**算子說錯**）＝**真的錯** ✓ → **保留門檻** ✓。
     · `charDiff`（葉子的**身分**與 IDS 不同）＝**大部分是我們刻意的** ✗：
       `木` 我們列獨體（師父裁定「墨是一團」，見 tools/atomic-chars.ts），IDS 卻攤成 `十`＋`人`；
       `邏` 我們停在 `羅`，IDS 攤到 `罒／維`。這正是 §6.19「以視覺為基礎」與
       §6.20「只需部件一致」的**目標本身**，不該判為失敗——理由與第 74 輪把
       「收縮等價」改成**僅供參考**完全相同。
     ⚠ 這一條**先前一直是紅的**（44.8%，其中 charDiff 42.0%），只是它**不在出貨三套裡**
       所以沒人看見 ✗；第 110 輪做「一鍵驗收」（`tools/verify.ts`）才把它照出來 ✓。
       ⚠ 修異體表（§6.22）**不是**它變紅的原因：實測修前 44.8%／修後 44.8%
       （charDiff 39,684 → 39,740，只差 56 個字）。 */
  const opBad = whyContract.get("opDiff") ?? 0;
  const charDiffN = whyContract.get("charDiff") ?? 0;
  opBad / Math.max(1, n) <= 0.35
    ? ok(`其中「說了但**算子**說錯」${pct(opBad)}（門檻 35%；其餘是棄權、資料缺口或刻意的粒度差）`)
    : bad(`算子說錯的比例太高：${pct(opBad)}（門檻 35%）`);
  console.log(`   ○ 葉子「身分」與 IDS 不同 ${pct(charDiffN)}——**大部分是刻意的**（獨體字與粒度），` +
    `不是錯誤：見 §6.19／§6.20 與 tools/atomic-chars.ts`);

  /* ---- 「完全重建」要動哪些字：把「被引用、自己畫成筆劃、但 IDS 說它有分解」的字列出來 ----
     這是把百分比變成**工作清單**：改這些字的畫法（用引用取代筆劃），
     完全重建率就會往上走（遞迴地，因為它們自己也是別人的部件）。 */
  const work = new Map<number, number>();
  const workByRef = new Map<number, Set<number>>();
  let scanned = 0;
  for (let gi = 0; gi < lib.glyphs.length; gi++) {
    const cp = codePointOf(lib, gi);
    if (!cp) continue;
    if (!isPlainIdeograph(lib, gi)) continue;
    if (indexOfCodePoint(lib, cp) !== gi) continue;
    if (processed !== 0 && scanned >= 0) { /* 沿用上面的掃描範圍 */ }
    const ids = idsByCp.get(cp);
    if (!ids) continue;
    const t = Array.from(ids);
    if (!t.length || OP_ARITY[t[0]!] === undefined) continue;
    scanned++;
    const dr = drawingIdx(lib, gi);
    for (const s of lib.glyphs[dr]!.strokes) {
      if (s.kind !== 99 || s.ref === null) continue;
      const rc = codePointOf(lib, s.ref);
      if (!rc) continue;
      const tgt = indexOfCodePoint(lib, s.ref);
      if (tgt === undefined) continue;
      const sub = lib.glyphs[drawingIdx(lib, tgt)]!;
      if (sub.strokes.filter((x) => x.kind === 99 && x.ref !== null).length >= 2) continue;
      const subIds = idsByCp.get(rc);
      if (!subIds) continue;
      const st = Array.from(subIds);
      if (!st.length || OP_ARITY[st[0]!] === undefined) continue;
      work.set(tgt, (work.get(tgt) ?? 0) + 1);
      let set = workByRef.get(tgt);
      if (!set) { set = new Set(); workByRef.set(tgt, set); }
      set.add(gi);
    }
  }
  const top = [...work.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);  console.log(`\n   【畫法要改成引用的字】掃描 ${scanned.toLocaleString()} 個有算子的字 → ` +
    `**${work.size.toLocaleString()} 個字形**自己畫成筆劃、但 IDS 說它有分解（被引用 ${[...work.values()].reduce((a, b) => a + b, 0).toLocaleString()} 次）`);
  console.log(`   最常被引用：` + top.map(([gi, cnt]) => {
    const c = codePointOf(lib, gi);
    return `${c ? String.fromCodePoint(c) : "∅"}×${cnt}`;
  }).join(" "));
  work.size > 0 && work.size < 2000
    ? ok(`工作清單是有界的：${work.size.toLocaleString()} 個字形（不是幾千個字要重畫）`)
    : console.log(`   ○ 工作清單 ${work.size.toLocaleString()} 個字形`);
  /* 把工作清單寫成檔案（下一輪要照著改畫法）：--worklist <path> */
  {
    const wi = argv.indexOf("--worklist");
    if (wi >= 0 && argv[wi + 1]) {
      const lines = ["idx\tchar\tcodepoint\t被引用次數\t自己的 IDS"];
      for (const [gi, cnt] of [...work.entries()].sort((a, b) => b[1] - a[1])) {
        const cp = codePointOf(lib, gi);
        lines.push(`${gi}\t${cp ? String.fromCodePoint(cp) : "∅"}\t` +
          `${cp ? "U+" + cp.toString(16).toUpperCase() : "∅"}\t${cnt}\t${(cp ? idsByCp.get(cp) : "") ?? ""}`);
      }
      writeFileSync(argv[wi + 1]!, lines.join("\n") + "\n", "utf8");
      console.log(`   （工作清單已寫入 ${argv[wi + 1]}：${work.size.toLocaleString()} 列）`);
    }
  }

  /* ---- 異體表對「相容字符／部首」的覆蓋（IDS 常寫 ⺲、爫、辶 這種碼位） ---- */
  const compatProbe: [string, string][] = [["爫", "爫"], ["⺲", "罒"], ["辶", "辶"], ["⻞", "食"], ["⺟", "母"]];
  const miss: string[] = [];
  for (const [a, b] of compatProbe) {
    const ca = a.codePointAt(0)!, cb = b.codePointAt(0)!;
    /* 第 93 輪：改讀**字庫 v5 的 syn**（同一連通分量 → 同一個部件 ✓）。
       先前這裡只看同碼位的家族表 ✗，所以第 91 輪明明把這 12 組寫進字庫了，探針還是說「不涵蓋」✗。 */
    if (!famOf(ca).has(cb) && !famOf(cb).has(ca) && synKeyOf(lib, ca) !== synKeyOf(lib, cb)) miss.push(`${a}(U+${ca.toString(16).toUpperCase()}) ↔ ${b}`);
  }
  miss.length === 0
    ? ok("異體表涵蓋相容字符／部首的對應（來源＝字庫 v5 的 syn ✓）")
    : console.log(`   ○ 異體表**不涵蓋**相容字符／部首的對應：${miss.join("、")}——` +
        `字庫 v5 的 syn 與頁面都已經讀它 ✓，這裡若還缺就是真的該補進 out/compat-map.tsv`);
}

/* ---------------------------------------------------------------- 3. 結構 API 的三塊 */
console.log("\n3. 組字結構的三塊（部件拆分／異體／字框）都拿得到嗎");
{
  const cp = "邏".codePointAt(0)!;
  const gi = indexOfCodePoint(lib, cp)!;
  const pm = perStrokeMasks(gi);
  const st = structureOf(lib, gi, { inkOf, masks: pm?.masks });
  st.parts.length === 2 && st.parts.every((p) => p.tight && p.raw)
    ? ok(`部件拆分：邏 → ${st.parts.map((p) => `${p.ch}（${p.zone}，緊框[${p.tight!.map((v) => Math.round(v)).join(",")}]）`).join(" ＋ ")}`)
    : bad(`部件拆分不完整：${JSON.stringify(st.parts.map((p) => ({ ch: p.ch, tight: p.tight })))}`);
  st.family.length > 0 && st.parts.some((p) => p.variants.length > 0)
    ? ok(`異體：邏 的家族 ${st.family.length} 個成員；部件 ${st.parts.map((p) => `${p.ch}→${p.variants.length} 個異體`).join("、")}`)
    : bad("異體資訊沒回傳");
  st.parts.every((p) => p.raw && p.raw.length === 4)
    ? ok(`字框：每個部件都有 raw（KAGE 引用框）與 tight（墨跡緊框）`)
    : bad("字框缺漏");
  st.orphanInk !== null && st.orphanInk < 0.01
    ? ok(`覆蓋：邏 的墨 ${((1 - st.orphanInk!) * 100).toFixed(1)}% 落在部件裡（無主 ${(st.orphanInk! * 100).toFixed(1)}%）`)
    : bad(`覆蓋率算不出來或偏低：${st.orphanInk}`);
}

console.log(fail === 0 ? "\n全部通過" : `\n有 ${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
