#!/usr/bin/env bun
/**
 * redraw-check.ts — **把「用筆劃畫的合體字」改成「用引用組的」**，並量它有沒有走鐘。
 *
 * 為什麼要做：第 2 輪量到「結構樹完全重建」只有 22.1%，頭號障礙（38.9%）是
 * 「我們引用的部件字自己畫成筆劃」——那些字明明有 IDS 分解，畫法卻是一筆一劃。
 * 這一步把它們改成引用，結構樹就接得起來（IDS 的資訊就真的由自有資料重建了）。
 *
 * 流程（每個字）：
 *   1. `solveIdsSlots(L, gi, { relaxed: true, forceBest: true, tol: 40 })`
 *      ——放寬版：允許任意數量的「沒有碼位的分量」、關掉「次佳解接近就不猜」的護欄。
 *      猜錯不會出事，因為下一步會擋下來。
 *   2. `redrawStrokes()` 產生新筆劃（每個分量一筆引用）。
 *   3. **驗收**：把原字與新字都畫出來、光柵化，算墨跡 **IoU**；
 *      太低的直接丟掉（＝「改了會走鐘」）。另外看結構樹有沒有因此接得起來。
 *
 * 產出：
 *   * 螢幕統計（各 IoU 門檻過幾個、失敗原因分佈）
 *   * `--patch out/structure-redraw.tsv`：idx／字／IoU／新筆劃的 KAGE 字串（給建庫用）
 *   * `--audit out/redraw-audit.html`：原字／新字／差異 的目視對照（挑最差的幾個）
 *
 * 用法: bun run tools/redraw-check.ts [--limit N] [--grid 64] [--patch 檔] [--audit 檔] [--top N]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { decodeLibrary, codePointOf, indexOfCodePoint, isPlainIdeograph } from "./lib-format.ts";
import type { Library, Stroke } from "./lib-format.ts";
import { drawingIdx, solveIdsSlots } from "./free-compose.ts";
import { redrawStrokes, treeToString } from "./structure.ts";
import { inkBoundsOfPolys } from "./component-boxes.ts";

const D = "D:/2023/glyphwiki";
const argv = Bun.argv.slice(2);
const argNum = (k: string, d: number) => {
  const i = argv.indexOf(k);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const argStr = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIMIT = argNum("--limit", Infinity);
const GRID = argNum("--grid", 64);
const TOP = argNum("--top", 8);
const PATCH = argStr("--patch");
const AUDIT = argStr("--audit");

const lib: Library = decodeLibrary(
  new Uint8Array(Bun.gunzipSync(readFileSync(`${D}/out/lib-cjk-all.bin.gz`))),
);
for (const f of ["2d.js", "buhin.js", "curve.js", "kage.js", "kagecd.js", "kagedf.js", "polygon.js", "polygons.js"]) {
  (0, eval)(readFileSync(`${D}/kage-engine/${f}`, "utf8"));
}
const kage = new (globalThis as any).Kage();
const nameOf = (i: number) => "g" + i;
const dataOf = (strokes: Stroke[]) => strokes.map((s) => s.kind === 99
  ? `99:0:0:${s.box![0]}:${s.box![1]}:${s.box![2]}:${s.box![3]}:${nameOf(s.ref!)}:${s.stretch![0]}:${s.stretch![1]}:${s.stretch![2]}:${s.stretch![3]}`
  : [s.kind, s.width, s.style].concat(s.points).join(":")).join("$");
const filled = new Set<string>();
function ensure(name: string, data: string, refs: number[]) {
  if (filled.has(name)) return;
  filled.add(name);
  kage.kBuhin.push(name, data);
  for (const r of refs) {
    const g = lib.glyphs[r];
    if (!g) continue;
    ensure(nameOf(r), dataOf(g.strokes), g.strokes.filter((s) => s.kind === 99 && s.ref !== null).map((s) => s.ref!));
  }
}
/** 畫一個字形，回傳墨跡遮罩（nonzero winding） */
function maskOfGlyph(name: string, data: string, refs: number[]): { mask: Uint8Array; ink: number } | null {
  ensure(name, data, refs);
  const polys: { array: unknown[] } = new (globalThis as any).Polygons();
  try { kage.makeGlyph(polys, name); } catch { return null; }
  const rings: { pts: { x: number; y: number }[]; x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const p of polys.array as { array: { x: number; y: number }[] }[]) {
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
  const mask = new Uint8Array(GRID * GRID);
  let ink = 0;
  for (let py = 0; py < GRID; py++) for (let px = 0; px < GRID; px++) {
    const x = ((px + 0.5) / GRID) * 200, y = ((py + 0.5) / GRID) * 200;
    let w = 0;
    for (const r of rings) { if (x < r.x1 || x > r.x2 || y < r.y1 || y > r.y2) continue; w += wn(r.pts, x, y); }
    if (w !== 0) { mask[py * GRID + px] = 1; ink++; }
  }
  return { mask, ink };
}
const iou = (a: Uint8Array, b: Uint8Array) => {
  let inter = 0, uni = 0;
  for (let k = 0; k < a.length; k++) {
    const p = a[k], q = b[k];
    if (p && q) inter++;
    if (p || q) uni++;
  }
  return uni ? inter / uni : 1;
};
/** 原字／新字（引用指向的筆劃數） */
const refsOf = (gi: number) => {
  const g = lib.glyphs[gi]!;
  return g.strokes.filter((s) => s.kind === 99 && s.ref !== null).map((s) => s.ref!);
};

/* ---------------------------------------------------------------- 掃描 */
type Row = { gi: number; cp: number; ch: string; iou: number; err: number; parts: string; ids: string; data: string };
const rows: Row[] = [];
const reasons = new Map<string, number>();
let tried = 0, converted = 0, processed = 0;
const INK_CACHE = new Map<string, { mask: Uint8Array; ink: number } | null>();

/* 預設掃「工作清單」；沒有給就掃全庫（畫成筆劃、且 IDS 有算子的字） */
const workPath = `${D}/out/structure-worklist.tsv`;
const workList: number[] = [];
try {
  for (const line of readFileSync(workPath, "utf8").split("\n").slice(1)) {
    const c = line.split("\t")[0];
    if (c) workList.push(Number(c));
  }
} catch { /* 沒有清單就全庫掃 */ }
const scan: number[] = workList.length ? workList : lib.glyphs.map((_, i) => i);

for (const gi of scan) {
  if (processed++ >= LIMIT) break;
  const cp = codePointOf(lib, gi);
  if (!cp || !isPlainIdeograph(lib, gi)) continue;
  if (workList.length === 0 && indexOfCodePoint(lib, cp) !== gi) continue;
  const drawing = drawingIdx(lib, gi);
  const dg = lib.glyphs[drawing]!;
  if (dg.strokes.some((s) => s.kind === 99)) continue;        /* 已經有引用 → 不是我們要改的 */
  const sol = solveIdsSlots(lib, gi, { relaxed: true, forceBest: true, tol: 40 });
  if (!sol) { reasons.set("推不出槽位", (reasons.get("推不出槽位") ?? 0) + 1); continue; }
  if (sol.slots.every((s) => s.index === undefined || !s.box)) {
    reasons.set("所有分量都沒有碼位", (reasons.get("所有分量都沒有碼位") ?? 0) + 1);
    continue;
  }
  const newStrokes = redrawStrokes(lib, drawing, sol);
  if (!newStrokes) { reasons.set("產生不出新筆劃", (reasons.get("產生不出新筆劃") ?? 0) + 1); continue; }
  tried++;
  const oldData = dataOf(dg.strokes);
  const newData = dataOf(newStrokes);
  const oldRefs = refsOf(drawing);
  const newRefs = newStrokes.filter((s) => s.kind === 99 && s.ref !== null).map((s) => s.ref!);
  let mo = INK_CACHE.get("o" + drawing);
  if (mo === undefined) { mo = maskOfGlyph(nameOf(drawing), oldData, oldRefs); INK_CACHE.set("o" + drawing, mo); }
  const mn = maskOfGlyph("rd" + gi, newData, newRefs);
  if (!mo || !mn) { reasons.set("畫不出來", (reasons.get("畫不出來") ?? 0) + 1); continue; }
  const v = iou(mo.mask, mn.mask);
  converted++;
  rows.push({
    gi: drawing, cp, ch: String.fromCodePoint(cp), iou: v, err: sol.error, data: newData,
    parts: sol.slots.map((s) => (s.index !== undefined && codePointOf(lib, s.index) ? String.fromCodePoint(codePointOf(lib, s.index)!) : "∅")).join("+"),
    ids: L_ids(cp),
  });
}
function L_ids(cp: number): string {
  const ids = (lib.comp as Map<number, number[]> | undefined)?.get(cp);
  return ids ? ids.map((c) => String.fromCodePoint(c)).join("") : "";
}

/* ---------------------------------------------------------------- 報表 */
rows.sort((a, b) => b.iou - a.iou);
const n = rows.length;
const q = (p: number) => (n ? rows[Math.min(n - 1, Math.floor(n * (1 - p)))]!.iou : 0);
const cnt = (t: number) => rows.filter((r) => r.iou >= t).length;
console.log(`掃描 ${processed.toLocaleString()} 個字形（工作清單 ${workList.length || "全庫"}）`);
console.log(`解出槽位 ${tried.toLocaleString()} 個、畫得出來 ${n.toLocaleString()} 個`);
console.log(`IoU 中位 ${(q(0.5) * 100).toFixed(1)}%、最差 10% ${(q(0.9) * 100).toFixed(1)}%`);
for (const t of [0.99, 0.97, 0.95, 0.9, 0.8, 0.6]) {
  console.log(`  IoU ≥ ${t.toFixed(2)}：${cnt(t).toLocaleString()} 個（${((cnt(t) / Math.max(1, n)) * 100).toFixed(1)}%）`);
}
console.log(`失敗原因：` + [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("　"));
const bad = rows.slice(-Math.min(n, 12)).reverse();
console.log(`\n最差（要看圖）的：` + bad.slice(0, 8).map((r) => `${r.ch}(${(r.iou * 100).toFixed(0)}% ${r.ids}→${r.parts})`).join("　"));
const good = rows.slice(0, 8);
console.log(`最好的：` + good.map((r) => `${r.ch}(${(r.iou * 100).toFixed(0)}% ${r.ids}→${r.parts})`).join("　"));

/* ---------------------------------------------------------------- 交代建庫的 patch */
if (PATCH) {
  const lines = ["idx\tchar\tcodepoint\tIoU\t分量\t新筆劃"];
  for (const r of rows) lines.push(`${r.gi}\t${r.ch}\tU+${r.cp.toString(16).toUpperCase()}\t${r.iou.toFixed(4)}\t${r.parts}\t${r.data}`);
  writeFileSync(PATCH, lines.join("\n") + "\n", "utf8");
  console.log(`\n（patch 已寫入 ${PATCH}：${rows.length} 列）`);
}

/* ---------------------------------------------------------------- 目視對照 */
if (AUDIT) {
  const pick = [...rows.slice(0, TOP), ...rows.slice(-TOP)].slice(0, TOP * 2);
  const cell = (label: string, strokeList: Stroke[], name: string, refs: number[]) => {
    ensure(name, dataOf(strokeList), refs);
    const p = new (globalThis as any).Polygons();
    try { kage.makeGlyph(p, name); } catch { return `<div class="c">${label}：畫不出來</div>`; }
    let path = "";
    for (const poly of p.array as { array: { x: number; y: number }[] }[]) {
      if (!poly) continue;
      path += "M" + poly.array.map((q) => `${(+q.x).toFixed(1)},${(+q.y).toFixed(1)}`).join("L") + "Z";
    }
    return `<div class="c"><div class="lb">${label}</div><svg viewBox="0 0 200 200" width="120" height="120">` +
      `<path d="${path}" fill="#111" fill-rule="nonzero"/></svg></div>`;
  };
  let html = `<!doctype html><meta charset="utf-8"><title>重畫對照（原字 vs 改成引用）</title>` +
    `<style>body{font:14px/1.5 system-ui,sans-serif;margin:16px}h2{font-size:15px;margin:20px 0 6px}` +
    `.row{display:flex;gap:10px;align-items:center;border-bottom:1px solid #eee;padding:6px 0}` +
    `.c{text-align:center}.lb{font-size:12px;color:#666}code{background:#f4f4f4;padding:1px 4px}</style>` +
    `<h1>重畫對照</h1><p>左＝原字（筆劃）、右＝改成引用後。IoU 是兩者墨跡的重疊率。</p>`;
  for (const r of pick) {
    const dg = lib.glyphs[r.gi]!;
    html += `<h2>${r.ch} U+${r.cp.toString(16).toUpperCase()}　IoU ${(r.iou * 100).toFixed(1)}%　` +
      `<code>${r.ids}</code> → <code>${r.parts}</code>　誤差 ${r.err.toFixed(1)}</h2><div class="row">`;
    html += cell("原字", dg.strokes, nameOf(r.gi), refsOf(r.gi));
    const ns = r.data.split("$").length; void ns;
    html += cell("改引用", parseData(r.data), "rd" + r.gi, []);
    html += `</div>`;
  }
  writeFileSync(AUDIT, html, "utf8");
  console.log(`（對照表已寫入 ${AUDIT}）`);
}
/** KAGE 字串 → 筆劃（只給稽核頁用；引用會指向別的 g… 名稱，render 時靠 ensure 遞迴註冊） */
function parseData(data: string): Stroke[] {
  const out: Stroke[] = [];
  for (const part of data.split("$")) {
    const f = part.split(":");
    if (Number(f[0]) === 99) {
      const refName = f[7]!;
      out.push({
        kind: 99, width: 0, style: 0, points: [], ref: Number(refName.slice(1)),
        box: [Number(f[3]), Number(f[4]), Number(f[5]), Number(f[6])], stretch: [Number(f[8]), Number(f[9]), Number(f[10]), Number(f[11])],
      });
    } else {
      out.push({ kind: Number(f[0]), width: Number(f[1]), style: Number(f[2]), points: f.slice(3).map(Number), ref: null, box: null, stretch: null });
    }
  }
  return out;
}
void inkBoundsOfPolys;
